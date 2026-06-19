import { SlidingWindowRateLimiter } from './voyage-rate-limiter';

describe('SlidingWindowRateLimiter', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('allows up to maxRequests within the window then blocks (RPM)', () => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        // High TPM so only the request count binds.
        const limiter = new SlidingWindowRateLimiter(3, 1_000_000, 60_000);

        expect(limiter.wouldExceed(10)).toBe(false);
        limiter.record(10);
        limiter.record(10);
        expect(limiter.wouldExceed(10)).toBe(false); // 2 used, a 3rd still fits
        limiter.record(10);
        expect(limiter.wouldExceed(10)).toBe(true);  // 3 used, a 4th would exceed RPM
    });

    it('blocks when the token budget would be exceeded (TPM)', () => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        // High RPM so only the token budget binds.
        const limiter = new SlidingWindowRateLimiter(100, 10_000, 60_000);

        limiter.record(8000);
        expect(limiter.wouldExceed(1000)).toBe(false); // 8000 + 1000 <= 10000
        expect(limiter.wouldExceed(3000)).toBe(true);  // 8000 + 3000 > 10000
    });

    it('frees capacity after the window elapses', () => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        const limiter = new SlidingWindowRateLimiter(1, 10_000, 60_000);

        limiter.record(5000);
        expect(limiter.wouldExceed(1)).toBe(true); // RPM=1 already used
        jest.setSystemTime(60_001);
        expect(limiter.wouldExceed(1)).toBe(false); // old record aged out of the window
    });

    it('markExhausted blocks until the window elapses', () => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        const limiter = new SlidingWindowRateLimiter(3, 10_000, 60_000);

        limiter.markExhausted();
        expect(limiter.wouldExceed(1)).toBe(true);
        jest.setSystemTime(59_999);
        expect(limiter.wouldExceed(1)).toBe(true);
        jest.setSystemTime(60_001);
        expect(limiter.wouldExceed(1)).toBe(false);
    });

    it('tryAcquire reserves atomically — the request over RPM is rejected', () => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        const limiter = new SlidingWindowRateLimiter(3, 1_000_000, 60_000);

        // Models concurrent callers each doing check-and-reserve in one synchronous step.
        expect(limiter.tryAcquire(10)).toBe(true);
        expect(limiter.tryAcquire(10)).toBe(true);
        expect(limiter.tryAcquire(10)).toBe(true);
        expect(limiter.tryAcquire(10)).toBe(false); // 4th in the minute → must go to paid
    });

    it('tryAcquire reserves against the token budget too', () => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        const limiter = new SlidingWindowRateLimiter(100, 10_000, 60_000);

        expect(limiter.tryAcquire(8000)).toBe(true);
        expect(limiter.tryAcquire(3000)).toBe(false); // 8000 + 3000 > 10000
        expect(limiter.tryAcquire(2000)).toBe(true);  // 8000 + 2000 == 10000, still fits
    });

    it('waitForCapacity resolves immediately when there is capacity', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        const limiter = new SlidingWindowRateLimiter(3, 10_000, 60_000);
        await expect(limiter.waitForCapacity(10)).resolves.toBeUndefined();
    });

    it('waitForCapacity blocks until the window frees up, then reserves the slot', async () => {
        // Real timers + a modest window: fast but with enough margin to not flake on slow CI.
        const windowMs = 300;
        const limiter = new SlidingWindowRateLimiter(1, 1_000_000, windowMs);
        limiter.record(10); // RPM=1 already used → next acquire must wait ~windowMs

        const start = Date.now();
        await limiter.waitForCapacity(10);
        const elapsed = Date.now() - start;

        expect(elapsed).toBeGreaterThanOrEqual(windowMs - 50);
        // It reserved the freed slot, so a further immediate acquire is blocked again.
        expect(limiter.wouldExceed(10)).toBe(true);
    });
});
