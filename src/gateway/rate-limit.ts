/**
 * Fixed one-minute windows counted in memory. Enough for one gateway
 * process; with several replicas this would move to Redis.
 */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(private now: () => number = Date.now) {}

  /** Returns seconds to wait, or 0 if the request may go ahead. */
  hit(key: string, perMinute: number): number {
    const now = this.now();
    let w = this.windows.get(key);
    if (!w || now - w.start >= 60_000) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count++;
    if (this.windows.size > 50_000) this.sweep(now);
    return w.count > perMinute ? Math.ceil((w.start + 60_000 - now) / 1000) : 0;
  }

  private sweep(now: number) {
    for (const [key, w] of this.windows) if (now - w.start >= 60_000) this.windows.delete(key);
  }
}
