import { createHmac } from "node:crypto";
import type { Fetch } from "../paystack.js";

/**
 * Events sent to the revenue system (Leadaut). Each has a stable event_id so the receiver can
 * ignore repeats: we retry until we get a 2xx, so the same event may arrive more than once.
 */
export type RevenueEvent = {
  event_type: "customer.upserted" | "order.paid" | "order.fulfilled" | "order.cancelled";
  event_id: string;
  occurred_at: string;
  data: Record<string, unknown>;
};

/** X-Mtk-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">, same scheme as Chord's events. */
export function signRevenueEvent(body: string, secret: string, timestampMs: number) {
  const ts = String(timestampMs);
  return { "X-Mtk-Timestamp": ts, "X-Mtk-Signature": `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}` };
}

type Entry = { event: RevenueEvent; attempts: number; nextAt: number; state: "pending" | "sent" | "dead"; lastError?: string };

export type OutboxStatus = { pending: number; sent: number; dead: number; lastError?: string; recentDead: { event_id: string; error?: string }[] };

/**
 * Sends events in order of arrival, retrying with backoff (30s, 1m, 2m … capped at 1h) for up to
 * `maxAttempts` tries. A 4xx other than 408/429 means the receiver rejected the event: no retry.
 * Held in memory, like the rest of the app until the storage layer lands.
 */
export class RevenueOutbox {
  private entries: Entry[] = [];
  private ids = new Set<string>();
  private current?: Promise<void>;
  private timer?: NodeJS.Timeout;

  constructor(
    private cfg: {
      url: string;
      secret: string;
      fetchImpl?: Fetch;
      now?: () => number;
      maxAttempts?: number;
      log?: (msg: string, extra?: Record<string, unknown>) => void;
    },
  ) {}

  private now() {
    return (this.cfg.now ?? Date.now)();
  }

  /** Queue an event; repeats of an event_id already queued are ignored. Sends straight away. */
  enqueue(event: RevenueEvent) {
    if (this.ids.has(event.event_id)) return false;
    this.ids.add(event.event_id);
    this.entries.push({ event, attempts: 0, nextAt: this.now(), state: "pending" });
    void this.flush();
    return true;
  }

  /** Try every pending event that's due. Calls queue behind each other, so one flush runs at a time. */
  async flush(): Promise<void> {
    while (this.current) await this.current;
    this.current = this.run();
    try {
      await this.current;
    } finally {
      this.current = undefined;
    }
  }

  private async run() {
    for (const e of this.entries) {
      if (e.state !== "pending" || e.nextAt > this.now()) continue;
      await this.send(e);
    }
    // Keep memory bounded: forget delivered events beyond the last 500.
    const sent = this.entries.filter((e) => e.state === "sent");
    if (sent.length > 500) {
      const drop = new Set(sent.slice(0, sent.length - 500));
      this.entries = this.entries.filter((e) => !drop.has(e));
    }
  }

  private async send(e: Entry) {
    e.attempts++;
    const body = JSON.stringify(e.event);
    const headers = { "Content-Type": "application/json", "X-Mtk-Event-Id": e.event.event_id, ...signRevenueEvent(body, this.cfg.secret, this.now()) };
    let retry = true;
    try {
      const res = await (this.cfg.fetchImpl ?? fetch)(this.cfg.url, { method: "POST", headers, body, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        e.state = "sent";
        e.lastError = undefined;
        this.cfg.log?.("revenue_event_sent", { event_id: e.event.event_id, event_type: e.event.event_type, attempts: e.attempts });
        return;
      }
      e.lastError = `HTTP ${res.status}`;
      retry = res.status >= 500 || res.status === 408 || res.status === 429;
    } catch (err) {
      e.lastError = err instanceof Error ? err.message : String(err);
    }
    if (!retry || e.attempts >= (this.cfg.maxAttempts ?? 8)) {
      e.state = "dead";
      this.cfg.log?.("revenue_event_dead", { event_id: e.event.event_id, attempts: e.attempts, error: e.lastError });
    } else {
      e.nextAt = this.now() + Math.min(3600_000, 30_000 * 2 ** (e.attempts - 1));
      this.cfg.log?.("revenue_event_retry", { event_id: e.event.event_id, attempts: e.attempts, error: e.lastError });
    }
  }

  /** Re-queue events that gave up, e.g. after the receiver is fixed. */
  retryDead() {
    let n = 0;
    for (const e of this.entries) {
      if (e.state === "dead") {
        e.state = "pending";
        e.attempts = 0;
        e.nextAt = this.now();
        n++;
      }
    }
    void this.flush();
    return n;
  }

  status(): OutboxStatus {
    const count = (s: Entry["state"]) => this.entries.filter((e) => e.state === s).length;
    const dead = this.entries.filter((e) => e.state === "dead");
    return {
      pending: count("pending"),
      sent: count("sent"),
      dead: dead.length,
      lastError: [...this.entries].reverse().find((e) => e.lastError)?.lastError,
      recentDead: dead.slice(-5).map((e) => ({ event_id: e.event.event_id, error: e.lastError })),
    };
  }

  /** Retry due events every `ms`. The timer doesn't keep the process alive. */
  start(ms = 15_000) {
    this.timer ??= setInterval(() => void this.flush(), ms);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
