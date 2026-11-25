import { createHash } from "node:crypto";
import type { Checkout, ToolResult } from "./checkout.js";
import { normaliseReference } from "./domain.js";

/** What we keep of a Paystack webhook: enough to look the rest up. Amounts always come from Paystack's API. */
export type PaymentEvent = { id: string; type: string; reference?: string; disputeId?: string };

export type EventEntry = { event: PaymentEvent; attempts: number; nextAt: number; state: "pending" | "done" | "dead"; lastError?: string };

export interface EventJournal {
  /** True when a saved event survives a restart. */
  readonly durable: boolean;
  load(): Promise<EventEntry[]>;
  save(entry: EventEntry): Promise<void>;
}

const HANDLED = /^(charge\.success|refund\.(processed|failed)|charge\.dispute\.(create|remind|resolve))$/;

/** Read a signed webhook body. Undefined when it isn't an event we act on. */
export function parsePaystackEvent(raw: Buffer): PaymentEvent | undefined {
  const body = JSON.parse(raw.toString("utf8")) as {
    event?: string;
    data?: { id?: number | string; reference?: string; transaction_reference?: string | null; transaction?: { reference?: string } };
  };
  const type = body.event ?? "";
  if (!HANDLED.test(type)) return undefined;
  const d = body.data ?? {};
  const reference = type === "charge.success" ? d.reference : (d.transaction_reference ?? d.transaction?.reference);
  if (!reference) return undefined;
  return {
    id: createHash("sha256").update(raw).digest("hex"),
    type,
    reference: normaliseReference(String(reference)),
    disputeId: type.startsWith("charge.dispute.") && d.id !== undefined ? String(d.id) : undefined,
  };
}

/** Act on an event. Throws when it should be tried again. */
export async function handlePaymentEvent(checkout: Checkout, e: PaymentEvent): Promise<ToolResult> {
  const reference = e.reference!;
  let result: ToolResult;
  if (e.type === "charge.success") {
    result = await checkout.verifyPayment(reference, "webhook");
    // Paystack announced a success its own API doesn't show yet.
    if (result.status === "not_paid_yet" || result.status === "replaced") throw new Error("paystack: success announced but not visible yet");
  } else if (e.type.startsWith("charge.dispute.")) {
    result = await checkout.recordDispute(reference, e.disputeId ?? "");
  } else {
    result = await checkout.recheckPaid(reference, e.type === "refund.failed" ? "refund_failed" : undefined);
  }
  if (!result.ok && result.error === "payment_provider_unavailable") throw new Error(String(result.detail ?? result.error));
  return result;
}

/**
 * Paystack's webhooks, kept until they've been acted on. An event is saved before it's
 * acknowledged and retried with backoff (30s, 1m, 2m … capped at 1h), so an outage at Paystack,
 * in our database or in this process can't lose a payment.
 */
export class PaymentEvents {
  private entries = new Map<string, EventEntry>();
  private current?: Promise<void>;
  private timer?: NodeJS.Timeout;

  constructor(
    private handle: (e: PaymentEvent) => Promise<unknown>,
    private opts: { journal?: EventJournal; now?: () => number; maxAttempts?: number; log?: (msg: string, extra?: Record<string, unknown>) => void } = {},
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  /** On start: pick up events that were waiting before the restart. */
  async load() {
    const waiting = (await this.opts.journal?.load()) ?? [];
    for (const e of waiting) this.entries.set(e.event.id, { ...e, nextAt: Math.min(e.nextAt, this.now()) });
    return waiting.length;
  }

  /**
   * Take an event in. Resolves true once it's safe to acknowledge: saved, when the journal
   * survives restarts, or otherwise acted on. False means Paystack should send it again.
   * Rejects when it couldn't be saved.
   */
  async receive(event: PaymentEvent): Promise<boolean> {
    let entry = this.entries.get(event.id);
    if (!entry || entry.state === "dead") {
      entry = { event, attempts: 0, nextAt: this.now(), state: "pending" };
      await this.opts.journal?.save(entry);
      this.entries.set(event.id, entry);
    }
    if (this.opts.journal?.durable) {
      void this.flush();
      return true;
    }
    if (entry.state === "pending") entry.nextAt = Math.min(entry.nextAt, this.now());
    await this.flush();
    return entry.state === "done";
  }

  /** Try every event that's due. Calls queue behind each other. */
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
    for (const e of [...this.entries.values()]) if (e.state === "pending" && e.nextAt <= this.now()) await this.attempt(e);
    // Remember recent finished events so a repeat is acknowledged without another lookup.
    const finished = [...this.entries.values()].filter((e) => e.state !== "pending");
    for (const e of finished.slice(0, Math.max(0, finished.length - 500))) this.entries.delete(e.event.id);
  }

  private async attempt(e: EventEntry) {
    e.attempts++;
    const about = { event: e.event.type, reference: e.event.reference, attempts: e.attempts };
    try {
      await this.handle(e.event);
      e.state = "done";
      e.lastError = undefined;
    } catch (err) {
      e.lastError = err instanceof Error ? err.message : String(err);
      if (e.attempts >= (this.opts.maxAttempts ?? 12)) {
        e.state = "dead"; // reconciliation still checks the order against Paystack
        this.opts.log?.("paystack_event_dead", { ...about, error: e.lastError });
      } else {
        e.nextAt = this.now() + Math.min(3600_000, 30_000 * 2 ** (e.attempts - 1));
        this.opts.log?.("paystack_event_retry", { ...about, error: e.lastError });
      }
    }
    // If this write fails the saved copy stays pending, and the event is handled again after a restart: every handler is safe to repeat.
    await this.opts.journal?.save(e).catch((err: unknown) => this.opts.log?.("paystack_event_save_failed", { ...about, error: err instanceof Error ? err.message : String(err) }));
  }

  status() {
    const count = (s: EventEntry["state"]) => [...this.entries.values()].filter((e) => e.state === s).length;
    return { pending: count("pending"), failed: count("dead") };
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
