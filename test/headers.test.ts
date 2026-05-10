import { parseHeaders, isEmpty } from "../src/headers";

describe("parseHeaders", () => {
    test("empty headers", () => {
        expect(isEmpty(parseHeaders(null))).toBe(true);
        expect(isEmpty(parseHeaders({}))).toBe(true);
    });

    test("groq dialect", () => {
        const h = {
            "x-ratelimit-limit-requests": "1000",
            "x-ratelimit-remaining-requests": "950",
            "x-ratelimit-reset-requests": "120s",
            "x-ratelimit-limit-tokens": "60000",
            "x-ratelimit-remaining-tokens": "30000",
            "x-ratelimit-reset-tokens": "60s",
        };
        const i = parseHeaders(h);
        expect(i.requestsLimit).toBe(1000);
        expect(i.requestsRemaining).toBe(950);
        expect(i.requestsResetS).toBe(120);
        expect(i.tokensLimit).toBe(60000);
        expect(i.tokensRemaining).toBe(30000);
        expect(i.tokensResetS).toBe(60);
        expect(i.nearExhaustion).toBe(false); // 950/1000 = 95%
    });

    test("anthropic dialect", () => {
        const h = {
            "anthropic-ratelimit-requests-limit": "50",
            "anthropic-ratelimit-requests-remaining": "1",
            "anthropic-ratelimit-requests-reset": "2099-12-31T23:59:59Z",
        };
        const i = parseHeaders(h);
        expect(i.requestsLimit).toBe(50);
        expect(i.requestsRemaining).toBe(1);
        expect(i.requestsResetS).not.toBeNull();
        expect(i.nearExhaustion).toBe(true); // 1/50 = 2%
    });

    test("IETF draft", () => {
        const h = {
            "RateLimit-Limit": "100",
            "RateLimit-Remaining": "5",
            "RateLimit-Reset": "30",
        };
        const i = parseHeaders(h);
        expect(i.requestsLimit).toBe(100);
        expect(i.requestsRemaining).toBe(5);
        expect(i.requestsResetS).toBe(30);
        expect(i.nearExhaustion).toBe(false); // 5/100 = 5%, threshold is <5%
    });

    test("retry-after only (cerebras-style)", () => {
        const i = parseHeaders({ "retry-after": "120" });
        expect(i.retryAfterS).toBe(120);
        expect(i.requestsLimit).toBeNull();
    });

    test("retry-after as HTTP date", () => {
        const i = parseHeaders({ "retry-after": "Wed, 01 Jan 2099 00:00:00 GMT" });
        expect(i.retryAfterS).not.toBeNull();
        expect(i.retryAfterS!).toBeGreaterThan(0);
    });

    test("near_exhaustion flag at <5%", () => {
        const h = {
            "x-ratelimit-limit-tokens": "10000",
            "x-ratelimit-remaining-tokens": "400", // 4%
        };
        expect(parseHeaders(h).nearExhaustion).toBe(true);
    });

    test("case-insensitive lookup", () => {
        const h = {
            "X-RateLimit-Limit-Requests": "100",
            "X-RATELIMIT-REMAINING-REQUESTS": "10",
        };
        const i = parseHeaders(h);
        expect(i.requestsLimit).toBe(100);
        expect(i.requestsRemaining).toBe(10);
    });

    test("Groq relative units: 5m → 300, 2h → 7200", () => {
        // regression test: caught a bug where parseInt("5m") returned 5 instead of 300
        expect(parseHeaders({ "retry-after": "5m" }).retryAfterS).toBe(300);
        expect(parseHeaders({ "retry-after": "2h" }).retryAfterS).toBe(7200);
        expect(parseHeaders({ "retry-after": "60s" }).retryAfterS).toBe(60);
    });
});
