/**
 * State backend protocol + in-memory implementation.
 */
interface State {
    getRateLimitBlocks(provider: string, model: string, credentialAlias: string): Promise<RateLimitRow[]>;
    bumpRateLimitBlock(provider: string, model: string, dimension: string, ttlSeconds: number, credentialAlias: string): Promise<void>;
    getQuotaState(provider: string, model: string, credentialAlias: string): Promise<QuotaRow[]>;
    bumpQuotaUsage(provider: string, model: string, period: string, limitType: string, increment: number, credentialAlias: string): Promise<void>;
    markQuotaExhausted(provider: string, model: string, credentialAlias: string, period?: string | null): Promise<void>;
    upsertQuotaCap(params: {
        provider: string;
        model: string;
        period: string;
        limitType: string;
        limitValue: number;
        periodStart: Date;
        periodEnd: Date;
        credentialAlias?: string;
    }): Promise<void>;
    getCircuit(provider: string, model: string, credentialAlias: string): Promise<CircuitRow | null>;
    upsertCircuit(params: {
        provider: string;
        model: string;
        status: string;
        credentialAlias?: string;
        lastError?: string | null;
        retryAt?: Date | null;
        errorStreak?: number | null;
        successStreak?: number | null;
        incrementErrorStreak?: boolean;
    }): Promise<void>;
    recordCircuitFailure(params: {
        provider: string;
        model: string;
        credentialAlias: string;
        threshold: number;
        openRetryAfterS: number;
        lastError: string | null;
    }): Promise<CircuitRow>;
}

type RateLimitRow = {
    dimension: string;
    blocked_until: Date | null;
    bucket_used: number;
    bucket_limit: number;
    bucket_window_s: number;
    updated_at: Date;
};

type QuotaRow = {
    period: string;
    limit_type: string;
    limit_value: number;
    current_usage: number;
    period_start: Date;
    period_end: Date | null;
    exhausted: boolean;
    last_429_at: Date | null;
    updated_at: Date;
};

type CircuitRow = {
    status: string;
    error_streak: number;
    success_streak: number;
    last_error: string | null;
    last_error_at: Date | null;
    opened_at: Date | null;
    retry_at: Date | null;
    updated_at: Date;
};

class MemoryState implements State {
    private readonly _rateLimits: Map<string, RateLimitRow[]>;
    private readonly _quotas: Map<string, QuotaRow[]>;
    private readonly _circuits: Map<string, CircuitRow>;

    constructor() {
        this._rateLimits = new Map();
        this._quotas = new Map();
        this._circuits = new Map();
    }

    private _key(provider: string, model: string, credentialAlias: string): string {
        return `${provider}|${model}|${credentialAlias}`;
    }

    pruneExpired(): number {
        const now = new Date();
        let pruned = 0;
        for (const [key, rows] of Array.from(this._rateLimits.entries())) {
            const keep = rows.filter(r => r.blocked_until === null || r.blocked_until > now);
            pruned += rows.length - keep.length;
            if (keep.length > 0) {
                this._rateLimits.set(key, keep);
            } else {
                this._rateLimits.delete(key);
            }
        }
        return pruned;
    }

    async getRateLimitBlocks(provider: string, model: string, credentialAlias: string): Promise<RateLimitRow[]> {
        const key = this._key(provider, model, credentialAlias);
        const rows = this._rateLimits.get(key) || [];
        const now = new Date();
        const active = rows.filter(r => r.blocked_until !== null && r.blocked_until > now);
        if (active.length !== rows.length) {
            if (active.length > 0) {
                this._rateLimits.set(key, active);
            } else {
                this._rateLimits.delete(key);
            }
        }
        return active;
    }

    async bumpRateLimitBlock(provider: string, model: string, dimension: string, ttlSeconds: number, credentialAlias: string): Promise<void> {
        const key = this._key(provider, model, credentialAlias);
        const blockedUntil = new Date(Date.now() + Math.max(ttlSeconds, 1) * 1000);
        const now = new Date();
        let rows = this._rateLimits.get(key);
        if (!rows) {
            rows = [];
            this._rateLimits.set(key, rows);
        }
        for (const r of rows) {
            if (r.dimension === dimension) {
                r.blocked_until = blockedUntil;
                r.updated_at = now;
                return;
            }
        }
        rows.push({
            dimension,
            blocked_until: blockedUntil,
            bucket_used: 0,
            bucket_limit: 0,
            bucket_window_s: 60,
            updated_at: now,
        });
    }

    async getQuotaState(provider: string, model: string, credentialAlias: string): Promise<QuotaRow[]> {
        const key = this._key(provider, model, credentialAlias);
        const rows = this._quotas.get(key) || [];
        const now = new Date();
        const active: QuotaRow[] = [];
        for (const r of rows) {
            if (!r.period_end) {
                active.push(r);
                continue;
            }
            // Capture into a local mutable so TS narrowing survives mutation across loop iterations.
            let periodEnd: Date = r.period_end;
            if (periodEnd <= now) {
                r.current_usage = 0;
                r.exhausted = false;
                while (periodEnd <= now) {
                    if (r.period === "daily") {
                        r.period_start = periodEnd;
                        periodEnd = new Date(periodEnd.getTime() + 24 * 60 * 60 * 1000);
                    } else if (r.period === "monthly") {
                        if (periodEnd.getMonth() === 11) {
                            r.period_start = periodEnd;
                            periodEnd = new Date(periodEnd.getFullYear() + 1, 0, 1);
                        } else {
                            r.period_start = periodEnd;
                            periodEnd = new Date(periodEnd.getFullYear(), periodEnd.getMonth() + 1, 1);
                        }
                    } else {
                        break;
                    }
                }
                r.period_end = periodEnd;
            }
            active.push(r);
        }
        return active;
    }

    async bumpQuotaUsage(provider: string, model: string, period: string, limitType: string, increment: number, credentialAlias: string): Promise<void> {
        const key = this._key(provider, model, credentialAlias);
        let rows = this._quotas.get(key);
        if (!rows) {
            rows = [];
            this._quotas.set(key, rows);
        }
        const now = new Date();
        for (const r of rows) {
            if (r.period === period && r.limit_type === limitType && (r.period_end === null || r.period_end > now)) {
                r.current_usage = (r.current_usage || 0) + increment;
                r.updated_at = now;
                return;
            }
        }
    }

    async markQuotaExhausted(provider: string, model: string, credentialAlias: string, period: string | null = null): Promise<void> {
        const key = this._key(provider, model, credentialAlias);
        let rows = this._quotas.get(key);
        const now = new Date();
        if (!rows || rows.length === 0) {
            const inferredPeriod = period || "daily";
            let start: Date;
            let end: Date;
            if (inferredPeriod === "monthly") {
                start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
                end = start.getMonth() === 11
                    ? new Date(start.getFullYear() + 1, 0, 1)
                    : new Date(start.getFullYear(), start.getMonth() + 1, 1);
            } else {
                start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
                end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
            }
            rows = [{
                period: inferredPeriod,
                limit_type: "tokens",
                limit_value: 0,
                current_usage: 0,
                period_start: start,
                period_end: end,
                exhausted: true,
                last_429_at: now,
                updated_at: now,
            }];
            this._quotas.set(key, rows);
            return;
        }
        let anyMatch = false;
        for (const r of rows) {
            if (period === null || r.period === period) {
                r.exhausted = true;
                r.last_429_at = now;
                r.updated_at = now;
                anyMatch = true;
            }
        }
        if (period !== null && !anyMatch) {
            let start: Date;
            let end: Date;
            if (period === "monthly") {
                start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
                end = start.getMonth() === 11
                    ? new Date(start.getFullYear() + 1, 0, 1)
                    : new Date(start.getFullYear(), start.getMonth() + 1, 1);
            } else {
                start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
                end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
            }
            rows.push({
                period,
                limit_type: "tokens",
                limit_value: 0,
                current_usage: 0,
                period_start: start,
                period_end: end,
                exhausted: true,
                last_429_at: now,
                updated_at: now,
            });
        }
    }

    async upsertQuotaCap(params: {
        provider: string;
        model: string;
        period: string;
        limitType: string;
        limitValue: number;
        periodStart: Date;
        periodEnd: Date;
        credentialAlias?: string;
    }): Promise<void> {
        const { provider, model, period, limitType, limitValue, periodStart, periodEnd, credentialAlias = "default" } = params;
        const key = this._key(provider, model, credentialAlias);
        let rows = this._quotas.get(key);
        const now = new Date();
        if (!rows) {
            rows = [];
            this._quotas.set(key, rows);
        }
        for (const r of rows) {
            if (r.period === period && r.limit_type === limitType) {
                r.limit_value = limitValue;
                r.period_start = periodStart;
                r.period_end = periodEnd;
                r.updated_at = now;
                if (r.period_end <= now) {
                    r.current_usage = 0;
                    r.exhausted = false;
                }
                return;
            }
        }
        rows.push({
            period,
            limit_type: limitType,
            limit_value: limitValue,
            current_usage: 0,
            period_start: periodStart,
            period_end: periodEnd,
            exhausted: false,
            last_429_at: null,
            updated_at: now,
        });
    }

    async getCircuit(provider: string, model: string, credentialAlias: string): Promise<CircuitRow | null> {
        const key = this._key(provider, model, credentialAlias);
        return this._circuits.get(key) || null;
    }

    async upsertCircuit(params: {
        provider: string;
        model: string;
        status: string;
        credentialAlias?: string;
        lastError?: string | null;
        retryAt?: Date | null;
        errorStreak?: number | null;
        successStreak?: number | null;
        incrementErrorStreak?: boolean;
    }): Promise<void> {
        const { provider, model, status, credentialAlias = "default", lastError, retryAt, errorStreak, successStreak, incrementErrorStreak } = params;
        const key = this._key(provider, model, credentialAlias);
        const existing = this._circuits.get(key);
        const now = new Date();
        let newStreak: number;
        if (incrementErrorStreak) {
            newStreak = (existing?.error_streak || 0) + 1;
        } else if (errorStreak !== undefined && errorStreak !== null) {
            newStreak = errorStreak;
        } else if (existing) {
            newStreak = existing.error_streak || 0;
        } else {
            newStreak = 0;
        }
        let openedAt: Date | null = null;
        if (status === "open") {
            if (existing && existing.status === "open") {
                openedAt = existing.opened_at || now;
            } else {
                openedAt = now;
            }
        }
        this._circuits.set(key, {
            status,
            error_streak: newStreak,
            success_streak: successStreak !== undefined && successStreak !== null
                ? successStreak
                : (existing?.success_streak || 0),
            last_error: lastError !== undefined && lastError !== null
                ? lastError
                : (existing?.last_error || null),
            last_error_at: lastError ? now : (existing?.last_error_at || null),
            opened_at: openedAt,
            retry_at: retryAt || null,
            updated_at: now,
        });
    }

    async recordCircuitFailure(params: {
        provider: string;
        model: string;
        credentialAlias: string;
        threshold: number;
        openRetryAfterS: number;
        lastError: string | null;
    }): Promise<CircuitRow> {
        const { provider, model, credentialAlias, threshold, openRetryAfterS, lastError } = params;
        const key = this._key(provider, model, credentialAlias);
        const existing = this._circuits.get(key);
        const now = new Date();
        const newStreak = (existing?.error_streak || 0) + 1;
        let status: string;
        let retryAt: Date | null;
        let openedAt: Date | null;
        if (newStreak >= threshold) {
            status = "open";
            retryAt = new Date(now.getTime() + Math.max(openRetryAfterS, 1) * 1000);
            openedAt = (existing?.status === "open" && existing.opened_at) || now;
        } else {
            status = existing?.status || "closed";
            retryAt = existing?.retry_at || null;
            openedAt = existing?.opened_at || null;
        }
        const circuitRow: CircuitRow = {
            status,
            error_streak: newStreak,
            success_streak: 0,
            last_error: lastError !== null ? lastError : (existing?.last_error || null),
            last_error_at: now,
            opened_at: openedAt,
            retry_at: retryAt,
            updated_at: now,
        };
        this._circuits.set(key, circuitRow);
        return circuitRow;
    }
}

export { State, MemoryState, RateLimitRow, QuotaRow, CircuitRow };
