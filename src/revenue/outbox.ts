import { createHmac } from "node:crypto";
import type { Fetch } from "../paystack.js";

/**
 * One delivery to Leadaut's store webhook. Leadaut already takes orders from WooCommerce stores,
 * so we send each order in that shape and Leadaut needs no new code (see docs/leadaut-sync.md).
 *
 * `key` is the order reference. Each body is the order's full current state, so deliveries for
 * one order must arrive in order: a later one waits while an earlier one is retrying.
 */
export type RevenueEvent = {
  event_id: string;
  topic: "order.created" | "order.updated";
  key: string;
  occurred_at: string;
  body: Record<string, unknown>;
};

/** X-WC-Webhook-Signature: base64 HMAC-SHA256 of the raw body, as WooCommerce signs it. */
export function signRevenueBody(body: string, secret: string) {
  return createHmac("sha256", secret).update(body).digest("base64");
}

/**
 * Leadaut's store webhook answers 200 even when it refuses an event, with `{ ok: false, error }`.
 * These errors won't fix themselves by retrying; anything else (a paused store, a processing
 * failure) is retried.
 */
const PERMANENT = new Set(["bad_signature", "unknown_integration", "invalid_json", "account_missing"]);

type Entry = { event: RevenueEvent; attempts: number; nextAt: number; state: "pending" | "sent" | "dead"; lastError?: string };

export type OutboxStatus = { pending: number; sent: number; dead: number; lastError?: string; recentDead: { event_id: string; error?: string }[] };

/**
 * Sends events in order of arrival, retrying with backoff (30s, 1m, 2m … capped at 1h) for up to
 * `maxAttempts` tries. Held in memory, like the rest of the app until the storage layer lands.
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
    // An order whose earlier delivery is still waiting to retry is held back, so Leadaut never
    // sees "refunded" before "paid".
    const held = new Set<string>();
    for (const e of this.entries) {
      if (e.state !== "pending") continue;
      if (held.has(e.event.key) || e.nextAt > this.now()) {
        held.add(e.event.key);
        continue;
      }
      await this.send(e);
      if (e.state === "pending") held.add(e.event.key);
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
    const body = JSON.stringify(e.event.body);
    const url = new URL(this.cfg.url);
    url.searchParams.set("topic", e.event.topic);
    const headers = {
      "Content-Type": "application/json",
      "X-WC-Webhook-Topic": e.event.topic,
      "X-WC-Webhook-Delivery-ID": e.event.event_id,
      "X-WC-Webhook-Signature": signRevenueBody(body, this.cfg.secret),
    };
    let retry = true;
    try {
      const res = await (this.cfg.fetchImpl ?? fetch)(url.toString(), { method: "POST", headers, body, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const reply = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (reply.ok !== false) {
          e.state = "sent";
          e.lastError = undefined;
          this.cfg.log?.("revenue_event_sent", { event_id: e.event.event_id, topic: e.event.topic, attempts: e.attempts });
          return;
        }
        e.lastError = `leadaut: ${reply.error ?? "refused"}`;
        retry = !PERMANENT.has(reply.error ?? "");
      } else {
        e.lastError = `HTTP ${res.status}`;
        retry = res.status >= 500 || res.status === 408 || res.status === 429;
      }
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
