# @eleata/resilient-llm-router

Multi-provider LLM routing with **3 orthogonal resilience states**:

- **rate_limit** — short-period back-off (per-minute / per-day request and token windows). TTL from `Retry-After` headers.
- **quota_exhausted** — long-period cap hit (daily / monthly). `exhausted=true` only when the error body explicitly says so. Period rolls forward automatically when the window ends.
- **circuit** — transient health (`closed` / `open` / `half_open`) from 5xx and timeouts.

> A 429 with body `"You exceeded your daily limit"` and a 429 with `Retry-After: 60` are semantically different. Most routers treat them the same and waste hundreds of calls retrying every minute against an exhausted free-tier provider. This library separates the two so each gets the cooldown it deserves.

This is the TypeScript port of [`resilient-llm-router`](https://github.com/hernaninverso/resilient-llm-router) (Python).

> **Status: alpha (`0.1.0-alpha.0`)**. API surface is stable for the in-memory backend. Persistence backends (SQLite, Postgres) and the `probes` health helper from the Python lib are deferred to `0.2.x`.

## Install

```bash
npm install @eleata/resilient-llm-router
```

Requires Node ≥ 18. Zero runtime dependencies.

## Quick start

```ts
import { router, parseHeaders } from "@eleata/resilient-llm-router";

const r = router(); // in-memory state by default

// Optional: seed quota caps so guard() can predict near-cap throttling
await r.seedCaps({
  groq: { "llama-3.3-70b-versatile": { "daily/tokens": 14_400_000 } },
});

// Before every call: ask should we even try?
const decision = await r.guard({
  provider: "groq",
  model: "llama-3.3-70b-versatile",
  estimatedInputTokens: 800,
  estimatedOutputTokens: 200,
});

if (!decision.allow) {
  console.log(`skip: ${decision.reason} (retry in ${decision.ttlS}s)`);
  // try next provider / model
} else {
  // make the actual call...
  const resp = await yourLLMClient.chat({ ... });

  // Tell the router how it went so it can update state.
  await r.recordOutcome({
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    success: true,
    tokensIn: 812,
    tokensOut: 204,
    responseHeaders: resp.headers, // parses Retry-After + dialect-specific rate-limit headers
  });
}
```

## Failure handling

```ts
// 429 with no specific body → rate-limit, blocked for the Retry-After window
await r.recordOutcome({
  provider: "groq",
  model: "llama-3.3-70b-versatile",
  success: false,
  statusCode: 429,
  errorMessage: "Too many requests",
  retryAfterSeconds: 60,
});

// 429 with quota body → quota_exhausted, blocked until period rolls over
await r.recordOutcome({
  provider: "openai",
  model: "gpt-4",
  success: false,
  statusCode: 429,
  errorMessage: "You exceeded your daily limit. Try tomorrow.",
});

// 401 / 403 → circuit open INDEFINITELY (until manual reset). Bad credentials shouldn't burn through every retry slot.
await r.recordOutcome({
  provider: "openai",
  model: "gpt-4",
  success: false,
  statusCode: 401,
  errorMessage: "Invalid API key",
});

// 5xx / timeout / generic → circuit error_streak++ atomically; opens at threshold (default 3).
await r.recordOutcome({
  provider: "groq",
  model: "llama-3.3-70b-versatile",
  success: false,
  statusCode: 503,
  errorMessage: "Upstream timed out",
});
```

## Header parsing

`parseHeaders()` understands four dialects:

- **Groq / OpenAI**: `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`
- **Anthropic**: `anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}`
- **IETF draft**: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`
- **Standalone**: `Retry-After` (Cerebras-style)

`Retry-After` accepts integer seconds (`"60"`), HTTP-date (`"Wed, 01 Jan 2099 00:00:00 GMT"`), and Groq-style relative units (`"60s"` / `"5m"` / `"2h"`). The `parseInt("5m") === 5` trap is regression-tested.

When response headers indicate **<5% remaining** on any dimension, the router sets a *soft block* even on a successful call — so subsequent `guard()` skips the candidate before you'd actually 429.

## Public API

- `router(state?, opts?)` — factory. Default: in-memory state.
- `Router` — class. Methods: `guard()`, `recordOutcome()`, `seedCaps()`.
- `MemoryState` — backend. SQLite + Postgres deferred to a future release.
- `parseHeaders(headers)` → `HeaderInsight`
- `looksLikeQuotaExhausted(errorMessage)` / `inferQuotaPeriod(errorMessage)` → standalone classifier helpers, useable without instantiating a router.

## Design

Three states are **orthogonal** and live under primary key `(provider, model, credentialAlias)`. A provider can be quota-exhausted on `daily/tokens` but still healthy on circuit, etc. `guard()` evaluates them in this precedence order:

1. Circuit OPEN (with `retry_at > now`) → block.
2. Active rate-limit blocks → block, return shortest TTL.
3. Quota explicitly exhausted (period not rolled over) → block until period_end.
4. Quota near cap (default ≥97% with the request's *estimated* tokens factored in) → block until period_end.
5. Otherwise → allow.

`recordOutcome()` handles the post-call mutation, and `_consume_headers()` extracts forward-looking signals from response headers regardless of success.

## Why a separate library

Most routers (LiteLLM, ClawRouter, OmniRoute pre-PR-#2116) collapse all 429s into a single uniform retry policy. That works until you hit a free-tier monthly cap and burn 1440 retries/day for the rest of the month. Separating the three states means a quota-exhausted provider gets a long cooldown (until period_end), a rate-limited one gets the short Retry-After, and a misconfigured credential opens the circuit indefinitely until you intervene.

## License

MIT — see [LICENSE](./LICENSE).

## See also

- [resilient-llm-router](https://github.com/hernaninverso/resilient-llm-router) — the original Python library this port is based on.
- [OmniRoute PR #2116](https://github.com/diegosouzapw/OmniRoute/pull/2116) — the same patterns landed upstream in OmniRoute's circuit breaker (issue #2100).
