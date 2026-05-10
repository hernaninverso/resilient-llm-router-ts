/**
 * Core API: routing_guard() pre-call decision and record_outcome() post-call
 * state mutation.
 *
 * Three orthogonal states per (provider, model, credentialAlias):
 * - rate_limit: TTL from Retry-After headers, dimensions (RPM/TPM/RPD)
 * - quota:      long-period (daily/monthly), exhausted=true ONLY with
 *               explicit keyword match in error body
 * - circuit:    transient health (closed/open/half_open) from 5xx/timeouts
 */

import { parseHeaders, isEmpty as headerInsightIsEmpty } from "./headers";
import { State, MemoryState } from "./state";

const DEFAULT_ERROR_STREAK_TO_OPEN = 3;
const DEFAULT_OPEN_RETRY_AFTER_S = 60;
const DEFAULT_QUOTA_NEAR_CAP_PCT = 0.97;
const DEFAULT_RATE_LIMIT_TTL_CAP_S = 3600; // 1 hour

const _QUOTA_PATTERNS: ReadonlyArray<readonly [RegExp, "daily" | "monthly"]> = [
    [/daily.*limit/i, "daily"],
    [/daily.*quota/i, "daily"],
    [/per.?day.*limit/i, "daily"],
    [/monthly.*limit/i, "monthly"],
    [/monthly.*quota/i, "monthly"],
    [/per.?month.*limit/i, "monthly"],
    [/quota.*exceed/i, "daily"],
    [/exceed.*quota/i, "daily"],
    [/insufficient.*quota/i, "daily"],
    [/billing.*cap/i, "monthly"],
    [/credit.*exhaust/i, "monthly"],
    [/out of credits/i, "monthly"],
    [/hard.?limit/i, "daily"],
    [/plan.*limit/i, "monthly"],
];

function looksLikeQuotaExhausted(errorMessage: string | null | undefined): boolean {
    if (!errorMessage) return false;
    return _QUOTA_PATTERNS.some(([pat]) => pat.test(errorMessage));
}

function inferQuotaPeriod(errorMessage: string | null | undefined): "daily" | "monthly" {
    if (!errorMessage) return "daily";
    for (const [pat, period] of _QUOTA_PATTERNS) {
        if (pat.test(errorMessage)) return period;
    }
    return "daily";
}

type SkipKind = "rate_limit" | "quota" | "circuit" | null;

interface Decision {
    allow: boolean;
    reason: string;
    ttlS: number | null;
    skipKind: SkipKind;
}

function decision(allow: boolean, reason = "ok", ttlS: number | null = null, skipKind: SkipKind = null): Decision {
    return { allow, reason, ttlS, skipKind };
}

interface RouterOptions {
    state?: State;
    errorStreakToOpen?: number;
    openRetryAfterS?: number;
    quotaNearCapPct?: number;
    rateLimitTtlCapS?: number;
    storeErrorBody?: boolean;
    quotaCaps?: Record<string, Record<string, Record<string, number>>>;
}

interface GuardArgs {
    provider: string;
    model: string;
    credentialAlias?: string;
    estimatedInputTokens?: number;
    estimatedOutputTokens?: number;
}

interface RecordOutcomeArgs {
    provider: string;
    model: string;
    credentialAlias?: string;
    success: boolean;
    statusCode?: number | null;
    errorMessage?: string | null;
    retryAfterSeconds?: number | null;
    responseHeaders?: Record<string, string> | null;
    tokensIn?: number;
    tokensOut?: number;
}

class Router {
    state: State;
    errorStreakToOpen: number;
    openRetryAfterS: number;
    quotaNearCapPct: number;
    rateLimitTtlCapS: number;
    storeErrorBody: boolean;
    quotaCaps: Record<string, Record<string, Record<string, number>>>;

    constructor(opts: RouterOptions = {}) {
        this.state = opts.state ?? new MemoryState();
        this.errorStreakToOpen = opts.errorStreakToOpen ?? DEFAULT_ERROR_STREAK_TO_OPEN;
        this.openRetryAfterS = opts.openRetryAfterS ?? DEFAULT_OPEN_RETRY_AFTER_S;
        this.quotaNearCapPct = opts.quotaNearCapPct ?? DEFAULT_QUOTA_NEAR_CAP_PCT;
        this.rateLimitTtlCapS = opts.rateLimitTtlCapS ?? DEFAULT_RATE_LIMIT_TTL_CAP_S;
        this.storeErrorBody = opts.storeErrorBody ?? true;
        this.quotaCaps = opts.quotaCaps ?? {};
    }

    async guard(args: GuardArgs): Promise<Decision> {
        const { provider, model, credentialAlias = "default" } = args;
        const estIn = args.estimatedInputTokens ?? 0;
        const estOut = args.estimatedOutputTokens ?? 0;
        const now = new Date();

        // 1. Circuit
        const circuit = await this.state.getCircuit(provider, model, credentialAlias);
        if (circuit && circuit.status === "open") {
            const retryAt = circuit.retry_at;
            if (retryAt === null) {
                return decision(false, "circuit_open_indefinite", null, "circuit");
            }
            if (retryAt > now) {
                const ttl = Math.floor((retryAt.getTime() - now.getTime()) / 1000);
                return decision(false, "circuit_open", ttl, "circuit");
            }
        }

        // 2. Rate-limit blocks
        const blocks = await this.state.getRateLimitBlocks(provider, model, credentialAlias);
        if (blocks.length > 0) {
            let ttl = 0;
            for (const b of blocks) {
                if (b.blocked_until) {
                    const t = Math.floor((b.blocked_until.getTime() - now.getTime()) / 1000);
                    if (t > ttl) ttl = t;
                }
            }
            const dim = blocks[0].dimension;
            return decision(false, `rate_limited:${dim}`, ttl, "rate_limit");
        }

        // 3 & 4. Quota
        const estimatedTotal = estIn + estOut;
        const quotas = await this.state.getQuotaState(provider, model, credentialAlias);
        for (const q of quotas) {
            if (q.exhausted) {
                const periodEnd = q.period_end;
                const ttl = periodEnd ? Math.floor((periodEnd.getTime() - now.getTime()) / 1000) : null;
                return decision(false, `quota_exhausted:${q.period}:${q.limit_type}`, ttl, "quota");
            }
            const limitValue = q.limit_value ?? 0;
            const usage = q.current_usage ?? 0;
            let projected = usage;
            if (q.limit_type === "tokens") projected += estimatedTotal;
            else if (q.limit_type === "requests") projected += 1;
            if (limitValue > 0 && projected / limitValue >= this.quotaNearCapPct) {
                const periodEnd = q.period_end;
                const ttl = periodEnd ? Math.floor((periodEnd.getTime() - now.getTime()) / 1000) : null;
                return decision(false, `quota_near_cap:${q.period}:${q.limit_type}`, ttl, "quota");
            }
        }

        return decision(true);
    }

    async recordOutcome(args: RecordOutcomeArgs): Promise<void> {
        const {
            provider, model, success,
            credentialAlias = "default",
            statusCode = null, errorMessage = null,
            responseHeaders = null,
            tokensIn = 0, tokensOut = 0,
        } = args;
        let retryAfterSeconds = args.retryAfterSeconds ?? null;

        if (responseHeaders) {
            await this._consumeHeaders(provider, model, credentialAlias, responseHeaders);
            const insight = parseHeaders(responseHeaders);
            if (insight.retryAfterS && !retryAfterSeconds) {
                retryAfterSeconds = insight.retryAfterS;
            }
        }

        if (success) {
            await this._onSuccess(provider, model, credentialAlias, tokensIn, tokensOut);
        } else {
            await this._onFailure(provider, model, credentialAlias, statusCode, errorMessage, retryAfterSeconds);
        }
    }

    private async _consumeHeaders(
        provider: string, model: string, credentialAlias: string,
        headers: Record<string, string>,
    ): Promise<void> {
        const insight = parseHeaders(headers);
        if (headerInsightIsEmpty(insight)) return;
        if (insight.nearExhaustion) {
            const candidates: number[] = [];
            if (insight.requestsResetS && insight.requestsResetS > 0) candidates.push(insight.requestsResetS);
            if (insight.tokensResetS && insight.tokensResetS > 0) candidates.push(insight.tokensResetS);
            let ttl = candidates.length > 0 ? Math.min(...candidates) : 60;
            ttl = Math.min(Math.max(ttl, 1), this.rateLimitTtlCapS);
            await this.state.bumpRateLimitBlock(
                provider, model, "header_near_exhaustion", ttl, credentialAlias,
            );
        }
    }

    private async _onSuccess(
        provider: string, model: string, credentialAlias: string,
        tokensIn: number, tokensOut: number,
    ): Promise<void> {
        const circuit = await this.state.getCircuit(provider, model, credentialAlias);
        if (circuit && (circuit.status === "open" || circuit.status === "half_open")) {
            await this.state.upsertCircuit({
                provider, model, credentialAlias,
                status: "closed", errorStreak: 0, successStreak: 1,
                lastError: null, retryAt: null,
            });
        }
        for (const period of ["daily", "monthly"] as const) {
            await this.state.bumpQuotaUsage(provider, model, period, "requests", 1, credentialAlias);
        }
        if (tokensIn || tokensOut) {
            const total = tokensIn + tokensOut;
            for (const period of ["daily", "monthly"] as const) {
                await this.state.bumpQuotaUsage(provider, model, period, "tokens", total, credentialAlias);
            }
        }
    }

    private async _onFailure(
        provider: string, model: string, credentialAlias: string,
        statusCode: number | null, errorMessage: string | null,
        retryAfterSeconds: number | null,
    ): Promise<void> {
        let safeError: string | null;
        if (this.storeErrorBody && errorMessage) {
            safeError = errorMessage.slice(0, 200);
        } else if (statusCode !== null) {
            safeError = `http_${statusCode}`;
        } else {
            safeError = null;
        }

        // 401 / 403 — credentials problem; open indefinitely.
        if (statusCode === 401 || statusCode === 403) {
            const err = (this.storeErrorBody
                ? `auth_${statusCode}: ${errorMessage ?? ""}`
                : `auth_${statusCode}`).slice(0, 200);
            await this.state.upsertCircuit({
                provider, model, credentialAlias,
                status: "open", errorStreak: 99, successStreak: 0,
                lastError: err, retryAt: null,
            });
            return;
        }

        // 429 — disambiguate quota vs rate-limit.
        if (statusCode === 429) {
            if (looksLikeQuotaExhausted(errorMessage)) {
                const period = inferQuotaPeriod(errorMessage);
                await this.state.markQuotaExhausted(provider, model, credentialAlias, period);
                return;
            }
            let ttl = Math.min(retryAfterSeconds ?? 60, this.rateLimitTtlCapS);
            ttl = Math.max(1, ttl);
            await this.state.bumpRateLimitBlock(provider, model, "api_429", ttl, credentialAlias);
            return;
        }

        // 5xx / timeout / generic — atomic record_circuit_failure.
        await this.state.recordCircuitFailure({
            provider, model, credentialAlias,
            threshold: this.errorStreakToOpen,
            openRetryAfterS: this.openRetryAfterS,
            lastError: safeError,
        });
    }

    async seedCaps(caps: Record<string, Record<string, Record<string, number>>>): Promise<void> {
        const now = new Date();
        const dailyStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const dailyEnd = new Date(dailyStart.getTime() + 24 * 60 * 60 * 1000);
        const monthlyStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const monthlyEnd = monthlyStart.getMonth() === 11
            ? new Date(monthlyStart.getFullYear() + 1, 0, 1)
            : new Date(monthlyStart.getFullYear(), monthlyStart.getMonth() + 1, 1);

        for (const [provider, models] of Object.entries(caps)) {
            for (const [model, limits] of Object.entries(models)) {
                for (const [key, value] of Object.entries(limits)) {
                    const slash = key.indexOf("/");
                    if (slash < 0) continue;
                    const period = key.slice(0, slash);
                    const limitType = key.slice(slash + 1);
                    let pStart: Date, pEnd: Date;
                    if (period === "daily") {
                        pStart = dailyStart;
                        pEnd = dailyEnd;
                    } else if (period === "monthly") {
                        pStart = monthlyStart;
                        pEnd = monthlyEnd;
                    } else {
                        continue;
                    }
                    await this.state.upsertQuotaCap({
                        provider, model,
                        period, limitType,
                        limitValue: value,
                        periodStart: pStart, periodEnd: pEnd,
                    });
                }
            }
        }
    }
}

function router(state: "memory" | State = "memory", opts: Omit<RouterOptions, "state"> = {}): Router {
    let resolved: State;
    if (typeof state === "string") {
        if (state === "memory") {
            resolved = new MemoryState();
        } else {
            throw new Error(
                `Unknown state backend: ${state}. Pass "memory" or a State instance.`,
            );
        }
    } else {
        resolved = state;
    }
    return new Router({ ...opts, state: resolved });
}

export { Router, router, looksLikeQuotaExhausted, inferQuotaPeriod };
export type { Decision, SkipKind, RouterOptions, GuardArgs, RecordOutcomeArgs };
