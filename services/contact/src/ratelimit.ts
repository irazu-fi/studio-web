/* In-memory rate limiting (single process, no database).
   IPs are never stored in clear: they are hashed with a random key that exists only in
   memory and changes on every restart, so the counters cannot be linked to a person. */
import { createHmac, randomBytes } from "node:crypto";

export class RateLimiter {
  private readonly key = randomBytes(32);
  private readonly hits = new Map<string, number[]>();
  private global: number[] = [];

  constructor(
    private readonly perIp: number,
    private readonly windowMs: number,
    private readonly globalPerHour: number,
  ) {}

  private id(ip: string): string {
    return createHmac("sha256", this.key).update(ip).digest("base64url");
  }

  /** Returns 0 if allowed (and counts the hit), otherwise seconds to wait. */
  take(ip: string, now = Date.now()): number {
    const id = this.id(ip);
    const mine = (this.hits.get(id) ?? []).filter(t => now - t < this.windowMs);
    this.global = this.global.filter(t => now - t < 3_600_000);

    if (mine.length >= this.perIp) {
      this.hits.set(id, mine);
      return Math.ceil((this.windowMs - (now - mine[0]!)) / 1000);
    }
    if (this.global.length >= this.globalPerHour) {
      return Math.ceil((3_600_000 - (now - this.global[0]!)) / 1000);
    }
    mine.push(now); this.global.push(now);
    this.hits.set(id, mine);
    return 0;
  }

  /** Drop expired entries so memory stays bounded. */
  sweep(now = Date.now()): void {
    for (const [id, ts] of this.hits) {
      const live = ts.filter(t => now - t < this.windowMs);
      if (live.length) this.hits.set(id, live); else this.hits.delete(id);
    }
  }
}
