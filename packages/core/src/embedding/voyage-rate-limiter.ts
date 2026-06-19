/**
 * Token-aware sliding-window rate limiter for the VoyageAI free tier.
 *
 * The free tier enforces two simultaneous limits (confirmed from a real 429 body):
 *   - requests per minute (RPM, default 3)
 *   - tokens per minute   (TPM, default 10000)
 *
 * The limiter keeps the timestamp + token cost of every reserved call within a
 * trailing window (default 60s) so we can either:
 *   - atomically reserve a slot if one is free ({@link tryAcquire}) and otherwise
 *     route the call to the paid key (search path), or
 *   - block until the free key has capacity again ({@link waitForCapacity})
 *     (incremental indexing path).
 *
 * Reservation ({@link tryAcquire} / the acquire inside {@link waitForCapacity}) does
 * the capacity check and the {@link record} in a single synchronous step. That is
 * what keeps the limiter correct when several callers race across `await` points:
 * a concurrent caller can never slip between "looks free" and "reserved".
 */
export class SlidingWindowRateLimiter {
    private readonly records: Array<{ ts: number; tokens: number }> = [];
    /** When set (epoch ms), the window is treated as fully exhausted until this time. */
    private exhaustedUntil = 0;

    constructor(
        private readonly maxRequests: number,
        private readonly maxTokens: number,
        private readonly windowMs: number = 60_000
    ) { }

    /** Drop records that have aged out of the trailing window. */
    private prune(now: number): void {
        const cutoff = now - this.windowMs;
        // Strictly-older-than keeps a record on the exact boundary one extra tick,
        // which is conservative against the API's own (latency-shifted) window.
        while (this.records.length > 0 && this.records[0].ts < cutoff) {
            this.records.shift();
        }
    }

    private usedTokens(): number {
        return this.records.reduce((sum, r) => sum + r.tokens, 0);
    }

    /**
     * Would a call costing `tokens` exceed the free-tier budget at `now`?
     * Returns true if the request count or token budget would be blown, or if the
     * window was force-marked exhausted by a real 429.
     */
    wouldExceed(tokens: number, now: number = Date.now()): boolean {
        if (now < this.exhaustedUntil) {
            return true;
        }
        this.prune(now);
        if (this.records.length + 1 > this.maxRequests) {
            return true;
        }
        // The token budget only blocks when there is existing usage in the window.
        // A request that alone exceeds the per-minute token budget is let through
        // best-effort against an empty window — otherwise it could never be served
        // and waitForCapacity would spin forever.
        if (this.records.length > 0 && this.usedTokens() + tokens > this.maxTokens) {
            return true;
        }
        return false;
    }

    /** Record a reserved free-key call so it counts against the window. */
    record(tokens: number, now: number = Date.now()): void {
        this.records.push({ ts: now, tokens });
    }

    /**
     * Atomically reserve capacity for a call costing `tokens`. If it fits, the usage
     * is recorded immediately (synchronously, before the caller awaits the network
     * call) and `true` is returned; otherwise `false`. Performing the check and the
     * record in one synchronous step is what makes the limiter concurrency-safe.
     */
    tryAcquire(tokens: number, now: number = Date.now()): boolean {
        if (this.wouldExceed(tokens, now)) {
            return false;
        }
        this.record(tokens, now);
        return true;
    }

    /**
     * Force the window to look exhausted for one full window length. Called after a
     * real 429 so subsequent calls fall back to paid (search) / wait (incremental)
     * even if our local accounting underestimated usage.
     */
    markExhausted(now: number = Date.now()): void {
        this.exhaustedUntil = now + this.windowMs;
    }

    /**
     * Earliest moment (epoch ms) at which a call costing `tokens` could succeed,
     * given the current window contents. Returns `now` if it fits immediately.
     */
    private nextAvailableAt(tokens: number, now: number): number {
        this.prune(now);
        let waitUntil = now;
        if (now < this.exhaustedUntil) {
            waitUntil = Math.max(waitUntil, this.exhaustedUntil);
        }
        // Need a request slot to free up: wait for the oldest overflowing record to age out.
        if (this.records.length + 1 > this.maxRequests) {
            const overflow = this.records.length + 1 - this.maxRequests;
            const rec = this.records[overflow - 1];
            if (rec) {
                waitUntil = Math.max(waitUntil, rec.ts + this.windowMs);
            }
        }
        // Need token budget to free up: drop oldest records until enough headroom.
        // Symmetric with wouldExceed — an empty window never blocks on tokens.
        const used = this.usedTokens();
        if (this.records.length > 0 && used + tokens > this.maxTokens) {
            let freed = 0;
            const needed = used + tokens - this.maxTokens;
            for (const rec of this.records) {
                freed += rec.tokens;
                if (freed >= needed) {
                    waitUntil = Math.max(waitUntil, rec.ts + this.windowMs);
                    break;
                }
            }
        }
        return waitUntil;
    }

    /**
     * Block until a call costing `tokens` fits within the free-tier budget, then
     * atomically reserve it. Resolves immediately if there is capacity now.
     */
    async waitForCapacity(tokens: number): Promise<void> {
        // Loop because new records may be added by concurrent callers while we sleep.
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const now = Date.now();
            if (this.tryAcquire(tokens, now)) {
                return;
            }
            const waitUntil = this.nextAvailableAt(tokens, now);
            const sleepMs = Math.max(50, waitUntil - now);
            await new Promise(resolve => setTimeout(resolve, sleepMs));
        }
    }
}
