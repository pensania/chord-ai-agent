import type { Checkout, ToolResult } from "./checkout.js";
import { refundKobo, paidKobo, type Order } from "./domain.js";
import type { Store } from "./store/types.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Compares our orders with Paystack, for when a webhook never arrives:
 * unpaid orders that were in fact paid, and paid orders whose money went back.
 */
export class Reconciler {
  /** When each order was last compared with Paystack, and last tried (which counts failures too). */
  private checked = new Map<string, number>();
  private tried = new Map<string, number>();
  private running?: Promise<{ checked: number; found: string[] }>;
  private timer?: NodeJS.Timeout;

  constructor(
    private store: Store,
    private checkout: Checkout,
    private opts: { now?: () => Date; log?: (msg: string, extra?: Record<string, unknown>) => void; onFound?: (result: ToolResult) => void | Promise<void>; /** Most orders to check in one run. */ limit?: number } = {},
  ) {}

  private now() {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  /** How long to leave an order between checks, or undefined to leave it alone. */
  private interval(o: Order): number | undefined {
    const age = this.now() - Date.parse(o.createdAt);
    if (o.status === "pending_payment" || o.status === "payment_failed" || o.status === "replaced") {
      if (!o.paymentUrl || age > 7 * DAY) return undefined;
      return age < DAY ? 4 * MIN : 6 * HOUR; // a fresh order on every 5-minute pass
    }
    if (o.status === "paid" && refundKobo(o) < paidKobo(o)) return this.now() - Date.parse(o.paidAt ?? o.createdAt) < 14 * DAY ? DAY : undefined;
    return undefined;
  }

  /** One pass. A call while one is running waits for that one. */
  run() {
    this.running ??= this.pass().finally(() => (this.running = undefined));
    return this.running;
  }

  private async pass() {
    const orders = await this.store.listOrders();
    const last = (o: Order) => this.checked.get(o.reference) ?? 0;
    const tried = (o: Order) => this.tried.get(o.reference) ?? 0;
    const due = orders
      .filter((o) => {
        const every = this.interval(o);
        return every !== undefined && this.now() - last(o) >= every;
      })
      // Unpaid first, then whichever has waited longest.
      .sort((a, b) => Number(a.status === "paid") - Number(b.status === "paid") || tried(a) - tried(b))
      .slice(0, this.opts.limit ?? 100);
    const known = new Set(orders.map((o) => o.reference));
    for (const map of [this.checked, this.tried]) for (const ref of map.keys()) if (!known.has(ref)) map.delete(ref);

    const found: string[] = [];
    let checked = 0;
    let failures = 0;
    for (const o of due) {
      this.tried.set(o.reference, this.now());
      let r: ToolResult;
      try {
        r = o.status === "paid" ? await this.checkout.recheckPaid(o.reference) : await this.checkout.verifyPayment(o.reference, "reconcile");
      } catch (e) {
        r = { ok: false, error: "payment_provider_unavailable", detail: e instanceof Error ? e.message : String(e), next_step: "" };
      }
      checked++;
      if (!r.ok && r.error === "payment_provider_unavailable") {
        if (++failures >= 3) break; // it's down, not just this order; these stay due for the next pass
        continue;
      }
      failures = 0;
      this.checked.set(o.reference, this.now());
      const changed = o.status === "paid" ? r.changed === true : r.status === "paid" || r.status === "needs_review";
      if (!changed) continue;
      found.push(o.reference);
      this.opts.log?.("reconcile_found", { reference: o.reference, was: o.status, now: r.status });
      try {
        await this.opts.onFound?.(r);
      } catch (e) {
        this.opts.log?.("reconcile_notify_failed", { reference: o.reference, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (failures) this.opts.log?.("reconcile_provider_down", { checked, failures });
    return { checked, found };
  }

  /** Run now and then every `ms`. The timer doesn't keep the process alive. */
  start(ms = 5 * MIN) {
    const go = () => void this.run().catch((e) => this.opts.log?.("reconcile_failed", { error: e instanceof Error ? e.message : String(e) }));
    go();
    this.timer ??= setInterval(go, ms);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
