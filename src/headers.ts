/**
 * Provider-specific HTTP header parsers for rate-limit auto-detection.
 *
 * Many providers publish their current rate-limit budget in response headers
 * that follow either the Groq/OpenAI/Anthropic conventions or the IETF
 * RateLimit draft (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`).
 */

interface HeaderInsight {
    readonly requestsLimit: number | null;
    readonly requestsRemaining: number | null;
    readonly requestsResetS: number | null;
    readonly tokensLimit: number | null;
    readonly tokensRemaining: number | null;
    readonly tokensResetS: number | null;
    readonly retryAfterS: number | null;
    readonly nearExhaustion: boolean;
}

type MutableInsight = {
    -readonly [K in keyof HeaderInsight]: HeaderInsight[K];
};

const UNIT_MULTIPLIERS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600 };

function isEmpty(insight: HeaderInsight): boolean {
    return Object.values(insight).every(v => v === null || v === false);
}

function _ciGet(headers: Record<string, string> | null, ...names: string[]): string | null {
    if (!headers) return null;
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
        lower[k.toLowerCase()] = v;
    }
    for (const n of names) {
        const v = lower[n.toLowerCase()];
        if (v !== undefined) return v;
    }
    return null;
}

function _parseInt(s: string | null): number | null {
    if (s === null) return null;
    const num = parseFloat(s);
    return isNaN(num) ? null : Math.floor(num);
}

function _parseResetSeconds(s: string | null): number | null {
    if (s === null) return null;
    const trimmed = s.trim();
    if (!trimmed) return null;
    const now = Date.now();

    // Groq-style: "60s", "1m", "2h" -- CHECK BEFORE parseInt
    const groqMatch = trimmed.match(/^(\d+)([smh])$/i);
    if (groqMatch) {
        const n = parseFloat(groqMatch[1]);
        const unit = groqMatch[2].toLowerCase();
        const mult = UNIT_MULTIPLIERS[unit];
        if (!isNaN(n) && mult !== undefined) {
            return Math.floor(n * mult);
        }
    }

    // ms suffix: "1500ms"
    if (trimmed.endsWith("ms")) {
        const ms = parseFloat(trimmed.slice(0, -2));
        if (!isNaN(ms)) {
            return Math.max(1, Math.floor(ms / 1000));
        }
        return null;
    }

    const val = _parseInt(trimmed);
    if (val !== null) {
        if (val > 10_000_000_000) { // epoch ms
            return Math.max(0, Math.floor((val - now) / 1000));
        }
        if (val > 1_700_000_000) { // epoch seconds
            return Math.max(0, Math.floor(val - now / 1000));
        }
        return val;
    }

    // ISO 8601 / RFC 3339
    const isoDate = trimmed.replace(/Z$/, "+00:00");
    const targetIso = new Date(isoDate);
    if (!isNaN(targetIso.getTime())) {
        return Math.max(0, Math.floor((targetIso.getTime() - now) / 1000));
    }

    // HTTP date
    const targetHttp = new Date(trimmed);
    if (!isNaN(targetHttp.getTime())) {
        return Math.max(0, Math.floor((targetHttp.getTime() - now) / 1000));
    }

    return null;
}

function parseHeaders(headers: Record<string, string> | null): HeaderInsight {
    const insight: MutableInsight = {
        requestsLimit: null,
        requestsRemaining: null,
        requestsResetS: null,
        tokensLimit: null,
        tokensRemaining: null,
        tokensResetS: null,
        retryAfterS: null,
        nearExhaustion: false,
    };

    for (const dim of ["requests", "tokens"] as const) {
        const limKey = `${dim}Limit` as const;
        const remKey = `${dim}Remaining` as const;
        const rstKey = `${dim}ResetS` as const;
        const lim = _parseInt(_ciGet(headers, `x-ratelimit-limit-${dim}`));
        const rem = _parseInt(_ciGet(headers, `x-ratelimit-remaining-${dim}`));
        const rst = _parseResetSeconds(_ciGet(headers, `x-ratelimit-reset-${dim}`));
        if (lim !== null) insight[limKey] = lim;
        if (rem !== null) insight[remKey] = rem;
        if (rst !== null) insight[rstKey] = rst;
    }

    for (const dim of ["requests", "tokens"] as const) {
        const limKey = `${dim}Limit` as const;
        const remKey = `${dim}Remaining` as const;
        const rstKey = `${dim}ResetS` as const;
        if (insight[limKey] === null) {
            insight[limKey] = _parseInt(_ciGet(headers, `anthropic-ratelimit-${dim}-limit`));
        }
        if (insight[remKey] === null) {
            insight[remKey] = _parseInt(_ciGet(headers, `anthropic-ratelimit-${dim}-remaining`));
        }
        if (insight[rstKey] === null) {
            insight[rstKey] = _parseResetSeconds(_ciGet(headers, `anthropic-ratelimit-${dim}-reset`));
        }
    }

    if (insight.requestsLimit === null) {
        insight.requestsLimit = _parseInt(_ciGet(headers, "ratelimit-limit"));
    }
    if (insight.requestsRemaining === null) {
        insight.requestsRemaining = _parseInt(_ciGet(headers, "ratelimit-remaining"));
    }
    if (insight.requestsResetS === null) {
        insight.requestsResetS = _parseResetSeconds(_ciGet(headers, "ratelimit-reset"));
    }

    insight.retryAfterS = _parseResetSeconds(_ciGet(headers, "retry-after"));

    for (const dim of ["requests", "tokens"] as const) {
        const lim = insight[`${dim}Limit`];
        const rem = insight[`${dim}Remaining`];
        if (lim !== null && lim > 0 && rem !== null && rem / lim < 0.05) {
            insight.nearExhaustion = true;
            break;
        }
    }

    return insight;
}

export { parseHeaders, isEmpty };
export type { HeaderInsight };
