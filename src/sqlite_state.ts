/**
 * SQLite-backed State implementation.
 *
 * Production-ready single-host state backend. SQLite serializes writers but
 * allows multiple readers in WAL mode. `recordCircuitFailure` uses
 * `BEGIN IMMEDIATE` so the increment + status decision is one atomic step
 * (audit HIGH #2 fix from the Python original).
 *
 * Port of `src/resilient_llm_router/sqlite_state.py` from the Python lib.
 * Uses `better-sqlite3` (sync, fast, embedded). Public methods return
 * Promises to match the {@link State} interface — they resolve immediately
 * since the underlying driver is synchronous.
 *
 * @module sqlite_state
 */

import Database, { type Database as SqliteDb } from "better-sqlite3";
import type {
    State,
    RateLimitRow,
    QuotaRow,
    CircuitRow,
} from "./state";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rate_limits (
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    credential_alias TEXT NOT NULL DEFAULT 'default',
    dimension TEXT NOT NULL,
    blocked_until_utc TEXT,
    bucket_used INTEGER DEFAULT 0,
    bucket_limit INTEGER DEFAULT 0,
    bucket_window_s INTEGER DEFAULT 60,
    updated_at_utc TEXT NOT NULL,
    PRIMARY KEY (provider, model, credential_alias, dimension)
);

CREATE INDEX IF NOT EXISTS idx_rl_blocked
    ON rate_limits(blocked_until_utc);

CREATE TABLE IF NOT EXISTS quotas (
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    credential_alias TEXT NOT NULL DEFAULT 'default',
    period TEXT NOT NULL,
    limit_type TEXT NOT NULL,
    limit_value INTEGER NOT NULL,
    current_usage INTEGER DEFAULT 0,
    period_start_utc TEXT NOT NULL,
    period_end_utc TEXT NOT NULL,
    exhausted INTEGER DEFAULT 0,
    last_429_at_utc TEXT,
    updated_at_utc TEXT NOT NULL,
    PRIMARY KEY (provider, model, credential_alias, period, limit_type)
);

CREATE INDEX IF NOT EXISTS idx_q_provider ON quotas(provider, exhausted);

CREATE TABLE IF NOT EXISTS circuits (
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    credential_alias TEXT NOT NULL DEFAULT 'default',
    status TEXT NOT NULL DEFAULT 'closed',
    error_streak INTEGER DEFAULT 0,
    success_streak INTEGER DEFAULT 0,
    last_error TEXT,
    last_error_at_utc TEXT,
    opened_at_utc TEXT,
    retry_at_utc TEXT,
    updated_at_utc TEXT NOT NULL,
    PRIMARY KEY (provider, model, credential_alias)
);

CREATE INDEX IF NOT EXISTS idx_c_status ON circuits(status);
`;

function isoNow(): string {
    return new Date().toISOString();
}

function iso(d: Date): string {
    return d.toISOString();
}

function parseIso(s: string | null | undefined): Date | null {
    if (s === null || s === undefined || s === "") return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
}

function addSeconds(d: Date, seconds: number): Date {
    return new Date(d.getTime() + Math.max(seconds, 0) * 1000);
}

function addDays(d: Date, days: number): Date {
    return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

function startOfNextMonth(d: Date): Date {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    return new Date(Date.UTC(m === 11 ? y + 1 : y, m === 11 ? 0 : m + 1, 1));
}

interface UpsertCircuitArgs {
    provider: string;
    model: string;
    credentialAlias?: string;
    status: string;
    lastError?: string | null;
    retryAt?: Date | null;
    errorStreak?: number | null;
    successStreak?: number | null;
    incrementErrorStreak?: boolean;
}

interface UpsertQuotaCapArgs {
    provider: string;
    model: string;
    period: string;
    limitType: string;
    limitValue: number;
    periodStart: Date;
    periodEnd: Date;
    credentialAlias?: string;
}

interface RecordCircuitFailureArgs {
    provider: string;
    model: string;
    credentialAlias: string;
    threshold: number;
    openRetryAfterS: number;
    lastError: string | null;
}

/**
 * SQLite-backed State. Construct with a file path or `:memory:` and call
 * `await init()` before first use to open the connection and ensure the
 * schema.
 */
export class SqliteState implements State {
    readonly dbPath: string;
    private _db: SqliteDb | null = null;

    constructor(dbPath: string = ":memory:") {
        this.dbPath = dbPath;
    }

    async init(): Promise<void> {
        const db = new Database(this.dbPath);
        db.pragma("journal_mode = WAL");
        db.pragma("synchronous = NORMAL");
        db.pragma("foreign_keys = ON");
        db.exec(SCHEMA);
        this._db = db;
    }

    async close(): Promise<void> {
        if (this._db !== null) {
            this._db.close();
            this._db = null;
        }
    }

    private get db(): SqliteDb {
        if (this._db === null) {
            throw new Error("SqliteState.init() was not awaited.");
        }
        return this._db;
    }

    // ---- rate_limit ----------------------------------------------------

    async getRateLimitBlocks(
        provider: string, model: string, credentialAlias: string,
    ): Promise<RateLimitRow[]> {
        const nowIso = isoNow();
        const rows = this.db.prepare(`
            SELECT dimension, blocked_until_utc, bucket_used, bucket_limit,
                   bucket_window_s, updated_at_utc
            FROM rate_limits
            WHERE provider = ? AND model = ? AND credential_alias = ?
              AND blocked_until_utc IS NOT NULL
              AND blocked_until_utc > ?
        `).all(provider, model, credentialAlias, nowIso) as Array<{
            dimension: string;
            blocked_until_utc: string | null;
            bucket_used: number;
            bucket_limit: number;
            bucket_window_s: number;
            updated_at_utc: string;
        }>;
        return rows.map((r) => ({
            dimension: r.dimension,
            blocked_until: parseIso(r.blocked_until_utc),
            bucket_used: r.bucket_used,
            bucket_limit: r.bucket_limit,
            bucket_window_s: r.bucket_window_s,
            updated_at: parseIso(r.updated_at_utc) as Date,
        }));
    }

    async bumpRateLimitBlock(
        provider: string, model: string, dimension: string,
        ttlSeconds: number, credentialAlias: string = "default",
    ): Promise<void> {
        const now = new Date();
        const blockedUntil = addSeconds(now, Math.max(ttlSeconds, 1));
        this.db.prepare(`
            INSERT INTO rate_limits
                (provider, model, credential_alias, dimension,
                 blocked_until_utc, updated_at_utc)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider, model, credential_alias, dimension)
            DO UPDATE SET blocked_until_utc = excluded.blocked_until_utc,
                          updated_at_utc = excluded.updated_at_utc
        `).run(provider, model, credentialAlias, dimension,
            iso(blockedUntil), iso(now));
    }

    // ---- quota ---------------------------------------------------------

    async getQuotaState(
        provider: string, model: string, credentialAlias: string,
    ): Promise<QuotaRow[]> {
        const rows = this.db.prepare(`
            SELECT period, limit_type, limit_value, current_usage,
                   period_start_utc, period_end_utc, exhausted, last_429_at_utc
            FROM quotas
            WHERE provider = ? AND model = ? AND credential_alias = ?
        `).all(provider, model, credentialAlias) as Array<{
            period: string;
            limit_type: string;
            limit_value: number;
            current_usage: number;
            period_start_utc: string;
            period_end_utc: string;
            exhausted: number;
            last_429_at_utc: string | null;
        }>;

        const now = new Date();
        const active: QuotaRow[] = [];
        const rolled: Array<{
            period_start: Date;
            period_end: Date;
            period: string;
            limit_type: string;
            credentialAlias: string;
        }> = [];

        for (const r of rows) {
            const row: QuotaRow = {
                period: r.period,
                limit_type: r.limit_type,
                limit_value: r.limit_value,
                current_usage: r.current_usage,
                period_start: parseIso(r.period_start_utc) as Date,
                period_end: parseIso(r.period_end_utc) as Date,
                exhausted: !!r.exhausted,
                last_429_at: parseIso(r.last_429_at_utc),
                updated_at: now,
            };
            // audit MED #7: roll forward in a loop, not just one period.
            if (row.period_end !== null && row.period_end <= now) {
                row.current_usage = 0;
                row.exhausted = false;
                let periodStart = row.period_start;
                let periodEnd: Date = row.period_end;
                while (periodEnd <= now) {
                    if (row.period === "daily") {
                        periodStart = periodEnd;
                        periodEnd = addDays(periodEnd, 1);
                    } else if (row.period === "monthly") {
                        periodStart = periodEnd;
                        periodEnd = startOfNextMonth(periodEnd);
                    } else {
                        break;
                    }
                }
                row.period_start = periodStart;
                row.period_end = periodEnd;
                rolled.push({
                    period_start: periodStart,
                    period_end: periodEnd,
                    period: row.period,
                    limit_type: row.limit_type,
                    credentialAlias,
                });
            }
            active.push(row);
        }

        // Persist roll-forward results in one transaction.
        if (rolled.length > 0) {
            const upd = this.db.prepare(`
                UPDATE quotas
                SET current_usage = 0,
                    exhausted = 0,
                    period_start_utc = ?,
                    period_end_utc = ?,
                    updated_at_utc = ?
                WHERE provider = ? AND model = ? AND credential_alias = ?
                  AND period = ? AND limit_type = ?
            `);
            const tx = this.db.transaction(() => {
                const nowI = iso(now);
                for (const u of rolled) {
                    upd.run(iso(u.period_start), iso(u.period_end), nowI,
                        provider, model, u.credentialAlias, u.period, u.limit_type);
                }
            });
            tx();
        }

        return active;
    }

    async bumpQuotaUsage(
        provider: string, model: string, period: string, limitType: string,
        increment: number, credentialAlias: string = "default",
    ): Promise<void> {
        const now = isoNow();
        this.db.prepare(`
            UPDATE quotas
            SET current_usage = current_usage + ?,
                updated_at_utc = ?
            WHERE provider = ? AND model = ? AND credential_alias = ?
              AND period = ? AND limit_type = ?
              AND period_end_utc > ?
        `).run(increment, now, provider, model, credentialAlias, period, limitType, now);
    }

    async markQuotaExhausted(
        provider: string, model: string, credentialAlias: string = "default",
        period: string | null = null,
    ): Promise<void> {
        const now = isoNow();
        // Apply to matching rows. Empty period filter = all periods.
        let result;
        if (period === null) {
            result = this.db.prepare(`
                UPDATE quotas
                SET exhausted = 1, last_429_at_utc = ?, updated_at_utc = ?
                WHERE provider = ? AND model = ? AND credential_alias = ?
            `).run(now, now, provider, model, credentialAlias);
        } else {
            result = this.db.prepare(`
                UPDATE quotas
                SET exhausted = 1, last_429_at_utc = ?, updated_at_utc = ?
                WHERE provider = ? AND model = ? AND credential_alias = ?
                  AND period = ?
            `).run(now, now, provider, model, credentialAlias, period);
        }
        // If no rows matched, synthesize one for the inferred period.
        if (result.changes === 0) {
            this._synthesizeExhausted(provider, model, credentialAlias, period);
        }
    }

    private _synthesizeExhausted(
        provider: string, model: string, credentialAlias: string,
        period: string | null,
    ): void {
        const now = new Date();
        const inferred = period ?? "daily";
        let pStart: Date, pEnd: Date;
        if (inferred === "monthly") {
            pStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
            pEnd = startOfNextMonth(pStart);
        } else {
            pStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
            pEnd = addDays(pStart, 1);
        }
        const nowIso = iso(now);
        this.db.prepare(`
            INSERT INTO quotas
                (provider, model, credential_alias, period, limit_type,
                 limit_value, current_usage, period_start_utc, period_end_utc,
                 exhausted, last_429_at_utc, updated_at_utc)
            VALUES (?, ?, ?, ?, 'tokens', 0, 0, ?, ?, 1, ?, ?)
            ON CONFLICT(provider, model, credential_alias, period, limit_type)
            DO UPDATE SET exhausted = 1,
                          last_429_at_utc = excluded.last_429_at_utc,
                          updated_at_utc = excluded.updated_at_utc
        `).run(provider, model, credentialAlias, inferred,
            iso(pStart), iso(pEnd), nowIso, nowIso);
    }

    async upsertQuotaCap(args: UpsertQuotaCapArgs): Promise<void> {
        const {
            provider, model, period, limitType, limitValue,
            periodStart, periodEnd, credentialAlias = "default",
        } = args;
        const now = isoNow();
        this.db.prepare(`
            INSERT INTO quotas
                (provider, model, credential_alias, period, limit_type,
                 limit_value, current_usage, period_start_utc, period_end_utc,
                 exhausted, last_429_at_utc, updated_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 0, NULL, ?)
            ON CONFLICT(provider, model, credential_alias, period, limit_type)
            DO UPDATE SET
                limit_value = excluded.limit_value,
                period_start_utc = excluded.period_start_utc,
                period_end_utc = excluded.period_end_utc,
                updated_at_utc = excluded.updated_at_utc,
                current_usage = CASE
                    WHEN excluded.period_end_utc <= ? THEN 0
                    ELSE current_usage
                END,
                exhausted = CASE
                    WHEN excluded.period_end_utc <= ? THEN 0
                    ELSE exhausted
                END
        `).run(provider, model, credentialAlias, period, limitType, limitValue,
            iso(periodStart), iso(periodEnd), now, now, now);
    }

    // ---- circuit -------------------------------------------------------

    async getCircuit(
        provider: string, model: string, credentialAlias: string,
    ): Promise<CircuitRow | null> {
        const row = this.db.prepare(`
            SELECT status, error_streak, success_streak, last_error,
                   last_error_at_utc, opened_at_utc, retry_at_utc, updated_at_utc
            FROM circuits
            WHERE provider = ? AND model = ? AND credential_alias = ?
        `).get(provider, model, credentialAlias) as {
            status: string;
            error_streak: number;
            success_streak: number;
            last_error: string | null;
            last_error_at_utc: string | null;
            opened_at_utc: string | null;
            retry_at_utc: string | null;
            updated_at_utc: string;
        } | undefined;
        if (row === undefined) return null;
        return {
            status: row.status,
            error_streak: row.error_streak,
            success_streak: row.success_streak,
            last_error: row.last_error,
            last_error_at: parseIso(row.last_error_at_utc),
            opened_at: parseIso(row.opened_at_utc),
            retry_at: parseIso(row.retry_at_utc),
            updated_at: parseIso(row.updated_at_utc) as Date,
        };
    }

    async upsertCircuit(args: UpsertCircuitArgs): Promise<void> {
        const {
            provider, model, status,
            credentialAlias = "default",
            lastError = null,
            retryAt = null,
            errorStreak = null,
            successStreak = null,
            incrementErrorStreak = false,
        } = args;

        const now = new Date();
        const existing = await this.getCircuit(provider, model, credentialAlias);

        let newStreak: number;
        if (incrementErrorStreak) {
            newStreak = (existing?.error_streak ?? 0) + 1;
        } else if (errorStreak !== null) {
            newStreak = errorStreak;
        } else if (existing) {
            newStreak = existing.error_streak;
        } else {
            newStreak = 0;
        }

        let openedAt: Date | null = null;
        if (status === "open") {
            if (existing && existing.status === "open") {
                openedAt = existing.opened_at ?? now;
            } else {
                openedAt = now;
            }
        }

        const finalSuccessStreak = successStreak !== null
            ? successStreak
            : (existing?.success_streak ?? 0);
        const finalLastError = lastError !== null
            ? lastError
            : (existing?.last_error ?? null);
        const finalLastErrorAt = lastError
            ? now
            : (existing?.last_error_at ?? null);

        this.db.prepare(`
            INSERT INTO circuits
                (provider, model, credential_alias, status,
                 error_streak, success_streak, last_error,
                 last_error_at_utc, opened_at_utc, retry_at_utc, updated_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider, model, credential_alias)
            DO UPDATE SET
                status = excluded.status,
                error_streak = excluded.error_streak,
                success_streak = excluded.success_streak,
                last_error = excluded.last_error,
                last_error_at_utc = excluded.last_error_at_utc,
                opened_at_utc = excluded.opened_at_utc,
                retry_at_utc = excluded.retry_at_utc,
                updated_at_utc = excluded.updated_at_utc
        `).run(
            provider, model, credentialAlias, status,
            newStreak, finalSuccessStreak, finalLastError,
            finalLastErrorAt ? iso(finalLastErrorAt) : null,
            openedAt ? iso(openedAt) : null,
            retryAt ? iso(retryAt) : null,
            iso(now),
        );
    }

    /**
     * Atomic: increment error_streak, decide status, set retry_at — all
     * inside one `BEGIN IMMEDIATE` transaction. This is the audit HIGH #2
     * fix from the Python original: concurrent failures cannot leave
     * streak=N>=threshold with status='closed'.
     */
    async recordCircuitFailure(args: RecordCircuitFailureArgs): Promise<CircuitRow> {
        const {
            provider, model, credentialAlias, threshold,
            openRetryAfterS, lastError,
        } = args;
        const now = new Date();
        const nowIso = iso(now);

        const select = this.db.prepare(`
            SELECT status, error_streak, success_streak, last_error,
                   last_error_at_utc, opened_at_utc, retry_at_utc, updated_at_utc
            FROM circuits
            WHERE provider = ? AND model = ? AND credential_alias = ?
        `);
        const upsert = this.db.prepare(`
            INSERT INTO circuits
                (provider, model, credential_alias, status,
                 error_streak, success_streak, last_error,
                 last_error_at_utc, opened_at_utc, retry_at_utc, updated_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider, model, credential_alias)
            DO UPDATE SET
                status = excluded.status,
                error_streak = excluded.error_streak,
                success_streak = excluded.success_streak,
                last_error = excluded.last_error,
                last_error_at_utc = excluded.last_error_at_utc,
                opened_at_utc = excluded.opened_at_utc,
                retry_at_utc = excluded.retry_at_utc,
                updated_at_utc = excluded.updated_at_utc
        `);

        let result!: CircuitRow;
        const tx = this.db.transaction(() => {
            const existing = select.get(provider, model, credentialAlias) as {
                status: string;
                error_streak: number;
                success_streak: number;
                last_error: string | null;
                last_error_at_utc: string | null;
                opened_at_utc: string | null;
                retry_at_utc: string | null;
                updated_at_utc: string;
            } | undefined;

            const newStreak = (existing?.error_streak ?? 0) + 1;
            let status: string;
            let retryAt: Date | null;
            let openedAt: Date | null;
            if (newStreak >= threshold) {
                status = "open";
                retryAt = addSeconds(now, Math.max(openRetryAfterS, 1));
                openedAt = (existing && existing.status === "open")
                    ? (parseIso(existing.opened_at_utc) ?? now)
                    : now;
            } else {
                status = existing?.status ?? "closed";
                retryAt = parseIso(existing?.retry_at_utc ?? null);
                openedAt = parseIso(existing?.opened_at_utc ?? null);
            }

            const finalLastError = lastError !== null
                ? lastError
                : (existing?.last_error ?? null);

            upsert.run(
                provider, model, credentialAlias, status,
                newStreak, 0, finalLastError,
                nowIso,
                openedAt ? iso(openedAt) : null,
                retryAt ? iso(retryAt) : null,
                nowIso,
            );

            result = {
                status,
                error_streak: newStreak,
                success_streak: 0,
                last_error: finalLastError,
                last_error_at: now,
                opened_at: openedAt,
                retry_at: retryAt,
                updated_at: now,
            };
        });
        tx.immediate();

        return result;
    }

    /**
     * List circuits whose `retry_at` is in the past — useful for periodic
     * sweepers that move OPEN → HALF_OPEN.
     */
    async listOpenDueCircuits(): Promise<Array<{
        provider: string;
        model: string;
        credentialAlias: string;
        retryAt: Date;
    }>> {
        const nowIso = isoNow();
        const rows = this.db.prepare(`
            SELECT provider, model, credential_alias, retry_at_utc
            FROM circuits
            WHERE status = 'open'
              AND retry_at_utc IS NOT NULL
              AND retry_at_utc <= ?
        `).all(nowIso) as Array<{
            provider: string;
            model: string;
            credential_alias: string;
            retry_at_utc: string;
        }>;
        return rows.map((r) => ({
            provider: r.provider,
            model: r.model,
            credentialAlias: r.credential_alias,
            retryAt: parseIso(r.retry_at_utc) as Date,
        }));
    }
}
