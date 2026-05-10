import { router, Router, looksLikeQuotaExhausted, inferQuotaPeriod } from "../src/core";
import { MemoryState } from "../src/state";

describe("classifier helpers", () => {
    test("looksLikeQuotaExhausted detects keywords", () => {
        expect(looksLikeQuotaExhausted("daily limit exceeded")).toBe(true);
        expect(looksLikeQuotaExhausted("monthly quota reached")).toBe(true);
        expect(looksLikeQuotaExhausted("out of credits")).toBe(true);
        expect(looksLikeQuotaExhausted(null)).toBe(false);
        expect(looksLikeQuotaExhausted("rate limit, retry in 60s")).toBe(false);
    });

    test("inferQuotaPeriod returns correct period", () => {
        expect(inferQuotaPeriod("daily limit hit")).toBe("daily");
        expect(inferQuotaPeriod("monthly quota exceeded")).toBe("monthly");
        expect(inferQuotaPeriod("out of credits")).toBe("monthly");
        expect(inferQuotaPeriod("plan limit reached")).toBe("monthly");
        expect(inferQuotaPeriod("hard-limit hit")).toBe("daily");
        expect(inferQuotaPeriod(null)).toBe("daily");
    });
});

describe("Router.guard", () => {
    test("clean state allows", async () => {
        const r = router();
        const d = await r.guard({ provider: "groq", model: "llama-70b" });
        expect(d.allow).toBe(true);
        expect(d.reason).toBe("ok");
    });

    test("circuit open blocks with circuit_open reason", async () => {
        const r = router();
        // Simulate 3 failures (default threshold)
        for (let i = 0; i < 3; i++) {
            await r.recordOutcome({
                provider: "groq", model: "llama-70b",
                success: false, statusCode: 500, errorMessage: "boom",
            });
        }
        const d = await r.guard({ provider: "groq", model: "llama-70b" });
        expect(d.allow).toBe(false);
        expect(d.reason).toBe("circuit_open");
        expect(d.skipKind).toBe("circuit");
        expect(d.ttlS).toBeGreaterThan(0);
    });

    test("rate-limit block on 429 (no quota body)", async () => {
        const r = router();
        await r.recordOutcome({
            provider: "groq", model: "llama-70b",
            success: false, statusCode: 429,
            errorMessage: "too many requests",
            retryAfterSeconds: 30,
        });
        const d = await r.guard({ provider: "groq", model: "llama-70b" });
        expect(d.allow).toBe(false);
        expect(d.reason.startsWith("rate_limited")).toBe(true);
        expect(d.skipKind).toBe("rate_limit");
        expect(d.ttlS).toBeLessThanOrEqual(30);
        expect(d.ttlS).toBeGreaterThan(25);
    });

    test("quota exhausted on 429 with daily-limit body", async () => {
        const r = router();
        await r.recordOutcome({
            provider: "openai", model: "gpt-4",
            success: false, statusCode: 429,
            errorMessage: "You exceeded your daily limit. Try tomorrow.",
        });
        const d = await r.guard({ provider: "openai", model: "gpt-4" });
        expect(d.allow).toBe(false);
        expect(d.reason).toContain("quota_exhausted");
        expect(d.reason).toContain("daily");
        expect(d.skipKind).toBe("quota");
    });

    test("401 opens circuit indefinite", async () => {
        const r = router();
        await r.recordOutcome({
            provider: "openai", model: "gpt-4",
            success: false, statusCode: 401, errorMessage: "Invalid API key",
        });
        const d = await r.guard({ provider: "openai", model: "gpt-4" });
        expect(d.allow).toBe(false);
        expect(d.reason).toBe("circuit_open_indefinite");
        expect(d.ttlS).toBeNull();
    });

    test("success closes open circuit", async () => {
        const r = router();
        for (let i = 0; i < 3; i++) {
            await r.recordOutcome({
                provider: "groq", model: "llama-70b",
                success: false, statusCode: 500, errorMessage: "boom",
            });
        }
        // Confirm open
        let d = await r.guard({ provider: "groq", model: "llama-70b" });
        expect(d.allow).toBe(false);
        // A successful call should close the circuit
        await r.recordOutcome({
            provider: "groq", model: "llama-70b",
            success: true, tokensIn: 10, tokensOut: 20,
        });
        d = await r.guard({ provider: "groq", model: "llama-70b" });
        expect(d.allow).toBe(true);
    });

    test("near-cap quota blocks before exhaustion", async () => {
        const r = router("memory", { quotaNearCapPct: 0.9 });
        await r.seedCaps({
            openai: { "gpt-4": { "daily/tokens": 1000 } },
        });
        // Bump to 95% via 950 token usage
        for (let i = 0; i < 95; i++) {
            await r.recordOutcome({
                provider: "openai", model: "gpt-4",
                success: true, tokensIn: 5, tokensOut: 5,
            });
        }
        const d = await r.guard({ provider: "openai", model: "gpt-4" });
        expect(d.allow).toBe(false);
        expect(d.reason).toContain("quota_near_cap");
    });

    test("estimated tokens factor into near-cap check", async () => {
        const r = router("memory", { quotaNearCapPct: 0.9 });
        await r.seedCaps({
            openai: { "gpt-4": { "daily/tokens": 1000 } },
        });
        // Usage is 0 but estimated request would push over
        const d = await r.guard({
            provider: "openai", model: "gpt-4",
            estimatedInputTokens: 600, estimatedOutputTokens: 350,
        });
        expect(d.allow).toBe(false);
        expect(d.reason).toContain("quota_near_cap");
    });
});

describe("Router header integration", () => {
    test("near_exhaustion header sets soft block", async () => {
        const r = router();
        await r.recordOutcome({
            provider: "groq", model: "llama-70b",
            success: true, tokensIn: 10, tokensOut: 10,
            responseHeaders: {
                "x-ratelimit-limit-requests": "1000",
                "x-ratelimit-remaining-requests": "10", // 1%
                "x-ratelimit-reset-requests": "60s",
            },
        });
        const d = await r.guard({ provider: "groq", model: "llama-70b" });
        expect(d.allow).toBe(false);
        expect(d.reason).toContain("header_near_exhaustion");
    });

    test("healthy headers do not block", async () => {
        const r = router();
        await r.recordOutcome({
            provider: "groq", model: "llama-70b",
            success: true, tokensIn: 10, tokensOut: 10,
            responseHeaders: {
                "x-ratelimit-limit-requests": "1000",
                "x-ratelimit-remaining-requests": "950",
                "x-ratelimit-reset-requests": "60s",
            },
        });
        const d = await r.guard({ provider: "groq", model: "llama-70b" });
        expect(d.allow).toBe(true);
    });
});

describe("router() factory", () => {
    test('default returns Router with MemoryState', () => {
        const r = router();
        expect(r).toBeInstanceOf(Router);
        expect(r.state).toBeInstanceOf(MemoryState);
    });

    test("rejects unknown backend strings", () => {
        expect(() => router("postgres://...")).toThrow(/Unknown state backend/);
    });

    test("accepts custom State instance", () => {
        const myState = new MemoryState();
        const r = router(myState);
        expect(r.state).toBe(myState);
    });
});
