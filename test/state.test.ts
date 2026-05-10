import { MemoryState } from "../src/state";

describe("MemoryState — rate limit", () => {
    test("bump + get returns active block", async () => {
        const s = new MemoryState();
        await s.bumpRateLimitBlock("groq", "llama-70b", "rpm", 60, "default");
        const blocks = await s.getRateLimitBlocks("groq", "llama-70b", "default");
        expect(blocks.length).toBe(1);
        expect(blocks[0].dimension).toBe("rpm");
        expect(blocks[0].blocked_until).not.toBeNull();
    });

    test("bump twice on same dimension updates, not duplicates", async () => {
        const s = new MemoryState();
        await s.bumpRateLimitBlock("groq", "llama-70b", "rpm", 60, "default");
        await s.bumpRateLimitBlock("groq", "llama-70b", "rpm", 120, "default");
        const blocks = await s.getRateLimitBlocks("groq", "llama-70b", "default");
        expect(blocks.length).toBe(1);
    });

    test("expired blocks pruned on read", async () => {
        const s = new MemoryState();
        await s.bumpRateLimitBlock("groq", "llama-70b", "rpm", 1, "default");
        // Force expiry
        await new Promise(r => setTimeout(r, 1100));
        const blocks = await s.getRateLimitBlocks("groq", "llama-70b", "default");
        expect(blocks.length).toBe(0);
    });

    test("ttl_seconds=0 still creates a 1-second block (max(ttl, 1))", async () => {
        const s = new MemoryState();
        await s.bumpRateLimitBlock("groq", "llama-70b", "rpm", 0, "default");
        const blocks = await s.getRateLimitBlocks("groq", "llama-70b", "default");
        expect(blocks.length).toBe(1);
    });
});

describe("MemoryState — quota", () => {
    test("markQuotaExhausted with no rows synthesizes daily by default", async () => {
        const s = new MemoryState();
        await s.markQuotaExhausted("openai", "gpt-4", "default", null);
        const rows = await s.getQuotaState("openai", "gpt-4", "default");
        expect(rows.length).toBe(1);
        expect(rows[0].period).toBe("daily");
        expect(rows[0].exhausted).toBe(true);
    });

    test("markQuotaExhausted with period=monthly synthesizes monthly", async () => {
        const s = new MemoryState();
        await s.markQuotaExhausted("openai", "gpt-4", "default", "monthly");
        const rows = await s.getQuotaState("openai", "gpt-4", "default");
        expect(rows.length).toBe(1);
        expect(rows[0].period).toBe("monthly");
    });

    test("markQuotaExhausted with period=daily only flags daily rows", async () => {
        const s = new MemoryState();
        const now = new Date();
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        await s.upsertQuotaCap({
            provider: "openai", model: "gpt-4",
            period: "daily", limitType: "tokens", limitValue: 1000,
            periodStart: now, periodEnd: tomorrow,
            credentialAlias: "default",
        });
        await s.upsertQuotaCap({
            provider: "openai", model: "gpt-4",
            period: "monthly", limitType: "tokens", limitValue: 30000,
            periodStart: now, periodEnd: nextMonth,
            credentialAlias: "default",
        });
        await s.markQuotaExhausted("openai", "gpt-4", "default", "daily");
        const rows = await s.getQuotaState("openai", "gpt-4", "default");
        const daily = rows.find(r => r.period === "daily");
        const monthly = rows.find(r => r.period === "monthly");
        expect(daily?.exhausted).toBe(true);
        expect(monthly?.exhausted).toBe(false);
    });

    test("getQuotaState rolls forward expired daily period", async () => {
        const s = new MemoryState();
        const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
        const stillPast = new Date(past.getTime() + 24 * 60 * 60 * 1000); // 2 days ago
        await s.upsertQuotaCap({
            provider: "openai", model: "gpt-4",
            period: "daily", limitType: "tokens", limitValue: 1000,
            periodStart: past, periodEnd: stillPast,
            credentialAlias: "default",
        });
        await s.markQuotaExhausted("openai", "gpt-4", "default", "daily");
        // Now read — should roll forward through multiple expired windows
        const rows = await s.getQuotaState("openai", "gpt-4", "default");
        expect(rows.length).toBe(1);
        expect(rows[0].period_end!.getTime()).toBeGreaterThan(Date.now());
        expect(rows[0].current_usage).toBe(0);
        expect(rows[0].exhausted).toBe(false);
    });
});

describe("MemoryState — circuit (race-safe)", () => {
    test("first failure does not open under threshold", async () => {
        const s = new MemoryState();
        const r = await s.recordCircuitFailure({
            provider: "openai", model: "gpt-4", credentialAlias: "default",
            threshold: 3, openRetryAfterS: 60, lastError: "boom",
        });
        expect(r.error_streak).toBe(1);
        expect(r.status).toBe("closed");
    });

    test("Nth failure with N>=threshold opens circuit", async () => {
        const s = new MemoryState();
        for (let i = 0; i < 2; i++) {
            await s.recordCircuitFailure({
                provider: "openai", model: "gpt-4", credentialAlias: "default",
                threshold: 3, openRetryAfterS: 60, lastError: "boom",
            });
        }
        const r = await s.recordCircuitFailure({
            provider: "openai", model: "gpt-4", credentialAlias: "default",
            threshold: 3, openRetryAfterS: 60, lastError: "boom",
        });
        expect(r.error_streak).toBe(3);
        expect(r.status).toBe("open");
        expect(r.retry_at).not.toBeNull();
        expect(r.opened_at).not.toBeNull();
    });

    test("opened_at is preserved across subsequent failures while open", async () => {
        const s = new MemoryState();
        for (let i = 0; i < 3; i++) {
            await s.recordCircuitFailure({
                provider: "openai", model: "gpt-4", credentialAlias: "default",
                threshold: 3, openRetryAfterS: 60, lastError: "boom",
            });
        }
        const c1 = await s.getCircuit("openai", "gpt-4", "default");
        const openedAt1 = c1!.opened_at;
        await new Promise(r => setTimeout(r, 50));
        await s.recordCircuitFailure({
            provider: "openai", model: "gpt-4", credentialAlias: "default",
            threshold: 3, openRetryAfterS: 60, lastError: "boom",
        });
        const c2 = await s.getCircuit("openai", "gpt-4", "default");
        expect(c2!.opened_at!.getTime()).toBe(openedAt1!.getTime());
    });
});
