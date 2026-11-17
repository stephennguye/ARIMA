import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Spaces calls at least `minIntervalMs` apart (Notion allows ~3 requests/second per integration,
 * so the default is 334 ms). Calls are serialised in arrival order.
 */
export class Throttle {
  private next = 0;

  constructor(
    private readonly minIntervalMs = 334,
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<unknown> = (ms) => sleep(ms),
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const start = Math.max(this.now(), this.next);
    this.next = start + this.minIntervalMs;
    const delay = start - this.now();
    if (delay > 0) await this.wait(delay);
    return fn();
  }
}
