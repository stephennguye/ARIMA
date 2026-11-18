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

export interface BackoffOptions {
  /** Retries after the first attempt (default 5). */
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
}

/** True for a Notion "rate limited" response (HTTP 429). */
export function isRateLimited(e: unknown): boolean {
  const err = e as { status?: unknown; code?: unknown } | null;
  return err?.status === 429 || err?.code === 'rate_limited';
}

function retryAfterMs(e: unknown): number | undefined {
  const headers = (e as { headers?: unknown } | null)?.headers as
    { get?: (n: string) => string | null } | Record<string, string> | undefined;
  if (headers === undefined || headers === null) return undefined;
  const raw =
    typeof (headers as { get?: unknown }).get === 'function'
      ? (headers as { get: (n: string) => string | null }).get('retry-after')
      : (headers as Record<string, string>)['retry-after'];
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 && raw !== null && raw !== undefined
    ? seconds * 1000
    : undefined;
}

/**
 * Retries `fn` when Notion answers 429, waiting for Retry-After when given and otherwise backing
 * off exponentially. Any other error, or running out of retries, is thrown unchanged.
 */
/** A failure that is the network's or Notion's, not the request's (a dropped connection, a 5xx). */
export function isTransient(e: unknown): boolean {
  const err = e as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: { code?: unknown };
  } | null;
  const code = String(err?.code ?? err?.cause?.code ?? '');
  if (/^(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR_.*)$/.test(code))
    return true;
  if (typeof err?.status === 'number' && [500, 502, 503, 504].includes(err.status)) return true;
  if (code === 'notionhq_client_request_timeout') return true;
  return /fetch failed|socket hang up|network|timed out/i.test(String(err?.message ?? ''));
}

/**
 * Retries a READ a couple of times on a transient failure. Never use it for a create or an update:
 * after an ambiguous failure a retry could duplicate the write.
 */
export async function withReadRetry<T>(
  fn: () => Promise<T>,
  o: { retries?: number; baseMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const { retries = 2, baseMs = 300, sleep: wait = (ms) => sleep(ms) } = o;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransient(e) || attempt >= retries) throw e;
      await wait(baseMs * 2 ** attempt);
    }
  }
}

export async function withBackoff<T>(fn: () => Promise<T>, o: BackoffOptions = {}): Promise<T> {
  const { retries = 5, baseMs = 500, maxMs = 30_000, sleep: wait = (ms) => sleep(ms) } = o;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimited(e) || attempt >= retries) throw e;
      await wait(retryAfterMs(e) ?? Math.min(maxMs, baseMs * 2 ** attempt));
    }
  }
}
