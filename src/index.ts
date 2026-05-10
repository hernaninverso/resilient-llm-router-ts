/**
 * @eleata/resilient-llm-router — TypeScript port of resilient-llm-router (Python).
 *
 * Multi-provider LLM routing with 3 orthogonal resilience states:
 * rate-limit ≠ quota-exhausted ≠ circuit-broken.
 *
 * @see https://github.com/eleata/resilient-llm-router (Python original)
 */

export { Router, router, looksLikeQuotaExhausted, inferQuotaPeriod } from "./core";
export type {
    Decision, SkipKind, RouterOptions, GuardArgs, RecordOutcomeArgs,
} from "./core";
export { MemoryState } from "./state";
export { SqliteState } from "./sqlite_state";
export type { State, RateLimitRow, QuotaRow, CircuitRow } from "./state";
export { parseHeaders, isEmpty as isHeaderInsightEmpty } from "./headers";
export type { HeaderInsight } from "./headers";
