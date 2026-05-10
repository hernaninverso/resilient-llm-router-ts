import { SqliteState } from "../src/sqlite_state";
import { router } from "../src/core";

describe("SqliteState — basic CRUD", () => {
    let s: SqliteState;
    beforeEach(async () => {
        s = new SqliteState(":memory:");
        await s.init();
    });
    afterEach(async () => {
        await s.close();
    });

    test("init creates the schema (rate_limits, quotas, circuits)", async () => {
        // If init failed the next ops would throw; instead we use it to
        // verify a clean read against an empty schema.
        const rl = await s.getRateLimitBlocks("p", "m", "default");
        const q = await s.getQuotaState("p", "m", "default");
        const c = await s.getCircuit("p", "m", "default");
        expect(rl).toEqual([]);
        expect(q).toEqual([]);
        expect(c).toBeNull();
    });

    test("rate-limit: bump + get returns active block", async () => {
        await s.bumpRateLimitBlock("groq", "llama-70b", "rpm", 60, "default");
        const blocks = await s.getRateLimitBlocks("groq", "llama-70b", "default");
        expect(blocks.length).toBe(1);
        expect(blocks[0].dimension).toBe("rpm");
        expect(blocks[0].blocked_until).not.toBeNull();
    });

    test("rate-limit: expired blocks not returned (filtered by SQL)", async () => {
        await s.bumpRateLimitBlock("groq", "llama-70b", "rpm", 1, "default");
        await new Promise((r) => setTimeout(r, 1100));
        const blocks = await s.getRateLimitBlocks("groq", "llama-70b", "default");
        expect(blocks.length).toBe(0);
    });

    test("quota: markExhausted synthesizes daily row when none exists", async () => {
        await s.markQuotaExhausted("openai", "gpt-4", "default", null);
        const rows = await s.getQuotaState("openai", "gpt-4", "default");
        expect(rows.length).toBe(1);
        expect(rows[0].period).toBe("daily");
        expect(rows[0].exhausted).toBe(true);
    });

    test("quota: markExhausted period=monthly synthesizes monthly", async () => {
        await s.markQuotaExhausted("openai", "gpt-4", "default", "monthly");
        const rows = await s.getQuotaState("openai", "gpt-4", "default");
        expect(rows.length).toBe(1);
        expect(rows[0].period).toBe("monthly");
        expect(rows[0].exhausted).toBe(true);
    });

    test("quota: getQuotaState rolls forward an expired daily period", async () => {
        const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3d ago
        const stillPast = new Date(past.getTime() + 24 * 60 * 60 * 1000); // 2d ago
        await s.upsertQuotaCap({
            provider: "openai", model: "gpt-4",
            period: "daily", limitType: "tokens", limitValue: 1000,
            periodStart: past, periodEnd: stillPast,
        });
        await s.markQuotaExhausted("openai", "gpt-4", "default", "daily");
        const rows = await s.getQuotaState("openai", "gpt-4", "default");
        expect(rows.length).toBe(1);
        expect(rows[0].period_end!.getTime()).toBeGreaterThan(Date.now());
        expect(rows[0].current_usage).toBe(0);
        expect(rows[0].exhausted).toBe(false);
    });

    test("circuit: recordCircuitFailure opens at threshold (race-safe)", async () => {
        for (let i = 0; i < 2; i++) {
            await s.recordCircuitFailure({
                provider: "p", model: "m", credentialAlias: "default",
                threshold: 3, openRetryAfterS: 60, lastError: "boom",
            });
        }
        const r = await s.recordCircuitFailure({
            provider: "p", model: "m", credentialAlias: "default",
            threshold: 3, openRetryAfterS: 60, lastError: "boom",
        });
        expect(r.error_streak).toBe(3);
        expect(r.status).toBe("open");
        expect(r.retry_at).not.toBeNull();
        expect(r.opened_at).not.toBeNull();
    });

    test("circuit: upsertCircuit preserves opened_at while open", async () => {
        await s.recordCircuitFailure({
            provider: "p", model: "m", credentialAlias: "default",
            threshold: 1, openRetryAfterS: 60, lastError: "boom",
        });
        const c1 = await s.getCircuit("p", "m", "default");
        const openedAt1 = c1!.opened_at!.getTime();
        await new Promise((r) => setTimeout(r, 40));
        await s.upsertCircuit({
            provider: "p", model: "m", credentialAlias: "default",
            status: "open", lastError: "again",
        });
        const c2 = await s.getCircuit("p", "m", "default");
        expect(c2!.opened_at!.getTime()).toBe(openedAt1);
    });
});

describe("SqliteState — restart survival", () => {
    test("state persists across SqliteState instances pointing at same file", async () => {
        const fs = require("fs");
        const path = require("path");
        const os = require("os");
        const tmp = path.join(os.tmpdir(), `rlrtest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

        try {
            // First instance: write a quota-exhausted row
            const s1 = new SqliteState(tmp);
            await s1.init();
            await s1.markQuotaExhausted("openai", "gpt-4", "default", "daily");
            await s1.close();

            // Second instance: brand-new, same DB path
            const s2 = new SqliteState(tmp);
            await s2.init();
            const rows = await s2.getQuotaState("openai", "gpt-4", "default");
            expect(rows.length).toBe(1);
            expect(rows[0].period).toBe("daily");
            expect(rows[0].exhausted).toBe(true);
            await s2.close();
        } finally {
            for (const ext of ["", "-shm", "-wal"]) {
                try { fs.unlinkSync(tmp + ext); } catch {}
            }
        }
    });
});

describe("router() factory — sqlite backend", () => {
    test('router("sqlite::memory:") returns a Router whose state needs init()', async () => {
        const r = router("sqlite::memory:");
        // First op should fail because state was never initialized.
        await expect(
            r.guard({ provider: "p", model: "m" }),
        ).rejects.toThrow(/init/);
    });

    test('router("sqlite::memory:") works after explicit init()', async () => {
        const r = router("sqlite::memory:");
        // @ts-expect-error — state is typed as State; SqliteState has init()
        await r.state.init();
        const decision = await r.guard({ provider: "p", model: "m" });
        expect(decision.allow).toBe(true);
    });
});
