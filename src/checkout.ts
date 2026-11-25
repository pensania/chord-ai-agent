import { CANCELLATION_POLICY, DELIVERY_WINDOW, isCalendarDate, isClockTime, MAX_ORDER_NGN, menuOn, newReference, normalisePhone, normaliseReference, OPEN_STATUSES, openIssue, paidKobo, quote, refundKobo, sameBasket, type Order, type PaymentIssue, type RequestedItem } from "./domain.js";
import { KeyedLock } from "./lock.js";
import { Paystack, PaystackError, type VerifyResult } from "./paystack.js";
import type { Store } from "./store/types.js";

const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString("en-NG")}`;

/** Why a payment is held, in words the owner can act on. */
export function explainHold(order: Pick<Order, "note" | "lines">): string {
  const note = order.note ?? "";
  const replaced = /paid on a replaced order: replaced by (\S+), paid (\d+) (\w+)/.exec(note);
  if (replaced) {
    const paid = replaced[3] === "NGN" ? naira(Number(replaced[2])) : `${Number(replaced[2]) / 100} ${replaced[3]}`;
    return `Paid ${paid} on an old link. The customer's newer order is ${replaced[1]}, so check whether they paid twice.`;
  }
  const mismatch = /amount mismatch: paid (\d+) (\w+), expected (\d+)/.exec(note);
  if (mismatch) {
    const paid = mismatch[2] === "NGN" ? naira(Number(mismatch[1])) : `${Number(mismatch[1]) / 100} ${mismatch[2]}`;
    return `Paid ${paid}, but the order is ${naira(Number(mismatch[3]))}.`;
  }
  const oversold = /paid but oversold: ([^(]+)/.exec(note);
  if (oversold) {
    const skus = oversold[1].split(",").map((x) => x.trim());
    const names = skus.map((sku) => order.lines.find((l) => l.sku === sku)?.name ?? sku);
    return `Paid, but sold out before payment landed: ${names.join(", ")}. Offer a swap or a refund.`;
  }
  if (/paystack: reversed/.test(note)) return "The payment was reversed by the bank or card issuer. No money is held.";
  return note || "Held for a check.";
}

/** What was received on a held payment, in kobo, when it's known. Nothing for a reversed one: that money went back. */
export function heldKobo(order: Order): number | undefined {
  const note = order.note ?? "";
  if (/paystack: reversed/.test(note)) return undefined;
  const received = order.paidKobo ?? Number(/paid (\d+) NGN/.exec(note)?.[1] ?? (/paid but oversold/.test(note) ? order.totalNgn * 100 : NaN));
  return Number.isFinite(received) && received > (order.refundedKobo ?? 0) ? received : undefined;
}

/** What the agent says when Tola takes over. The agent sends it as an ordinary reply: Chord's own
 * "connect to a teammate" handoff keeps its message internal and the customer sees nothing. */
export const PASS_TO_TOLA = "Let me get Tola to look at this personally. She'll reply here within 2 hours (8am to 8pm).";

/**
 * Every result carries `ok` and a plain-English `next_step` so the model
 * knows what to tell the customer without guessing.
 */
export type ToolResult = Record<string, unknown> & { ok: boolean; next_step: string };

const OVER_LIMIT = `Orders over ${naira(MAX_ORDER_NGN * 100)} are agreed with Tola. Reply to the customer yourself with: "${PASS_TO_TOLA}" Do not create a link, do not split the order to get under the limit, and do not transfer or escalate the conversation.`;

// The webhook usually settles an order before the customer says "paid", so this is often the first
// the chat hears of it. Only the model can see whether it has told the customer, so it has to choose.
const ALREADY_CONFIRMED =
  "This order is paid and confirmed. If your messages in this chat haven't told the customer yet, confirm it once, with the delivery zone and day, and remind them it can't be cancelled once cooking starts. If they have, it stands: don't announce it again, don't repeat the order, and don't apologise for or mention checking. Just answer what they said in one short line. Do not charge again.";

/** How a payment came to our attention. */
type Source = "chat" | "webhook" | "reconcile";

const PENDING_REUSE_MS = 30 * 60 * 1000;
const RECENT_MS = 24 * 60 * 60 * 1000;

export class Checkout {
  private lock = new KeyedLock();

  constructor(
    private store: Store,
    private paystack: Paystack,
    private opts: { callbackUrl?: string; placeholderEmailDomain?: string; now?: () => Date; /** Called once when an order becomes paid. Must not throw. */ onPaid?: (order: Order) => void;
      /** Called once when a payment is held for the owner (needs_review). Must not throw. */ onHeld?: (order: Order) => void;
      /** Called when the refund on a paid order changes. Must not throw. */ onRefund?: (order: Order) => void;
      /** Called once when a confirmed payment is reversed, disputed or refunded in full. Must not throw. */ onIssue?: (order: Order) => void;
      /** Called when Paystack couldn't complete a refund. Must not throw. */ onRefundFailed?: (order: Order) => void;
    } = {},
  ) {}

  /** Reporting must never undo a payment or change what the customer is told. */
  private notify(name: "onPaid" | "onHeld" | "onRefund" | "onIssue" | "onRefundFailed", order: Order) {
    try {
      this.opts[name]?.(order);
    } catch (e) {
      console.error(`${name} failed`, e);
    }
  }

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  /** Serialise work per order so the webhook and the chat can't both settle it. The key is the normalised reference. */
  private withOrderLock<T>(reference: string, fn: (reference: string) => Promise<T>) {
    const ref = normaliseReference(reference);
    return this.lock.run(`order:${ref}`, () => fn(ref));
  }

  /** Lagos date and weekday, so the model can turn "Saturday" into a calendar date. */
  private today() {
    const d = new Date(this.now().getTime() + 60 * 60 * 1000);
    return `${d.toISOString().slice(0, 10)} (${d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })})`;
  }

  /** Why an order can't be taken for this day, or undefined when it can. */
  private dateProblem(neededBy: string): ToolResult | undefined {
    const today = this.today();
    if (!isCalendarDate(neededBy)) {
      return { ok: false, error: "bad_date", today, next_step: "needed_by must be a date like 2026-11-07. Work out the calendar date the customer means and call again." };
    }
    if (neededBy < today.slice(0, 10)) {
      return { ok: false, error: "date_in_past", today, next_step: "That date has already passed. Check the day with the customer, using today's date given here." };
    }
    // The kitchen needs a day to shop and cook, so the rule is "tomorrow or later" by Lagos calendar
    // date. A rule in hours ("24 hours' notice") made the model refuse an evening order for
    // tomorrow afternoon, which the kitchen does take.
    if (neededBy === today.slice(0, 10)) {
      return { ok: false, error: "same_day", today, next_step: `Same-day orders need Tola. Reply to the customer yourself with: "${PASS_TO_TOLA}" Do not create a link, and do not transfer or escalate the conversation.` };
    }
    return undefined;
  }

  /** Why this delivery time can't be taken, or undefined when it can. */
  private timeProblem(deliverBy: string): ToolResult | undefined {
    if (!isClockTime(deliverBy)) {
      return { ok: false, error: "bad_time", next_step: "deliver_by must be a 24-hour time like 13:00. Work out the time the customer means and call again. No link was created." };
    }
    if (deliverBy < DELIVERY_WINDOW.from || deliverBy > DELIVERY_WINDOW.to) {
      return { ok: false, error: "outside_delivery_window", window: DELIVERY_WINDOW, next_step: "Delivery is between 10am and 6pm. Ask the customer for a time in that window, then call again. No link was created." };
    }
    return undefined;
  }

  /** Prices, zones, and what can be made. With a day, `in_stock` is what's left for it; without one, the most the kitchen makes in a day. */
  async checkStock(items?: RequestedItem[], deliveryZone?: string, neededByInput?: string): Promise<ToolResult> {
    const neededBy = neededByInput?.trim() || undefined;
    const problem = neededBy && this.dateProblem(neededBy);
    if (problem) return problem;
    const [all, zones, day] = await Promise.all([this.store.listMenu(), this.store.listZones(), neededBy ? this.store.dayPlan(neededBy) : undefined]);
    if (all.length === 0) {
      return { ok: false, error: "menu_empty", next_step: "The menu could not be loaded. Apologise and say a staff member will reply shortly. Do not invent items or prices." };
    }
    const menu = day ? menuOn(all, day) : all;
    const when = { today: this.today(), needed_by: neededBy };
    const askDay = "in_stock is the most the kitchen makes in a day, not what's left. Ask which day they need it, and call check_stock again with needed_by before asking them to confirm.";
    const available = menu.filter((m) => m.active).map((m) => ({ sku: m.sku, name: m.name, price_ngn: m.priceNgn, in_stock: m.stock }));
    if (!items || items.length === 0) {
      return { ok: true, ...when, menu: available, delivery_zones: zones.map((z) => ({ zone: z.zone, fee_ngn: z.feeNgn })), next_step: `Help the customer choose. Only offer items with in_stock > 0. ${neededBy ? `in_stock is what's left for ${neededBy}.` : askDay}` };
    }
    const q = quote(menu, zones, items, deliveryZone ?? "Pickup");
    if (!q.ok) {
      return { ok: false, ...when, problems: q.problems, menu: available, next_step: `Explain each problem briefly and suggest the closest in-stock alternative${neededBy ? ", or another day" : ""}. Do not create a payment link yet.` };
    }
    const priced = { lines: q.lines, subtotal_ngn: q.subtotalNgn, delivery_fee_ngn: q.deliveryFeeNgn, total_ngn: q.totalNgn, zone: q.zone, ...when };
    if (q.totalNgn > MAX_ORDER_NGN) return { ok: true, ...priced, over_limit: true, limit_ngn: MAX_ORDER_NGN, next_step: OVER_LIMIT };
    return {
      ok: true,
      ...priced,
      cancellation_policy: CANCELLATION_POLICY,
      next_step: neededBy ? "Read the order, day and total back to the customer, tell them the cancellation_policy, and ask them to confirm before creating a payment link." : `The prices and total are right. ${askDay}`,
    };
  }

  async createPaymentLink(input: {
    customerName: string;
    customerPhone: string;
    customerEmail?: string;
    items: RequestedItem[];
    deliveryZone: string;
    deliveryAddress: string;
    neededBy?: string;
    deliverBy?: string;
  }): Promise<ToolResult> {
    const phone = normalisePhone(input.customerPhone);
    const neededBy = input.neededBy?.trim() ?? "";
    if (!neededBy) {
      return { ok: false, error: "date_required", today: this.today(), next_step: "Ask which day the customer needs the order, then call again with needed_by as a date like 2026-11-07. No link was created." };
    }
    const problem = this.dateProblem(neededBy);
    if (problem) return problem;
    const deliverBy = input.deliverBy?.trim() || undefined;
    const badTime = deliverBy && this.timeProblem(deliverBy);
    if (badTime) return badTime;
    const [menu, zones, day] = await Promise.all([this.store.listMenu(), this.store.listZones(), this.store.dayPlan(neededBy)]);
    const q = quote(menuOn(menu, day), zones, input.items, input.deliveryZone);
    if (!q.ok) {
      return { ok: false, needed_by: neededBy, problems: q.problems, next_step: "Something changed since the quote, or that day is full. Explain the problem and offer alternatives or another day. No link was created." };
    }
    if (q.totalNgn > MAX_ORDER_NGN) {
      return { ok: false, error: "over_limit", total_ngn: q.totalNgn, limit_ngn: MAX_ORDER_NGN, next_step: OVER_LIMIT };
    }

    // One request at a time per customer: two at once would otherwise each find no open order and make one.
    return this.lock.run(`phone:${phone}`, () => this.linkFor(phone, neededBy, deliverBy, q, input));
  }

  private async linkFor(
    phone: string,
    neededBy: string,
    deliverBy: string | undefined,
    q: Extract<ReturnType<typeof quote>, { ok: true }>,
    input: { customerName: string; customerEmail?: string; deliveryAddress: string },
  ): Promise<ToolResult> {
    const details = { customerName: input.customerName.trim(), deliveryAddress: input.deliveryAddress.trim(), neededBy, ...(deliverBy ? { deliverBy } : {}) };
    const open = (await this.store.openOrdersByPhone(phone)).filter((o) => o.paymentUrl);

    // Same customer, same basket, still unpaid and recent: the same link, with the latest day and address on the order.
    const same = open.find((o) => o.status === "pending_payment" && sameBasket(o, q.lines, q.zone, q.totalNgn) && this.now().getTime() - Date.parse(o.createdAt) < PENDING_REUSE_MS);
    if (same) {
      const changed = same.neededBy !== details.neededBy || same.deliveryAddress !== details.deliveryAddress || same.customerName !== details.customerName || (deliverBy !== undefined && same.deliverBy !== deliverBy);
      const now = changed ? await this.store.transact(same.reference, async (o) => (o.status === "pending_payment" ? details : undefined)) : same;
      if (now?.status === "pending_payment") {
        return {
          ok: true,
          reused: true,
          updated: changed || undefined,
          reference: same.reference,
          payment_url: same.paymentUrl,
          total_ngn: same.totalNgn,
          needed_by: details.neededBy,
          deliver_by: now.deliverBy,
          next_step: changed
            ? "This is the same unpaid order, now with the new day, time, address or name. Read those back to the customer and resend the same link. Do not create another one."
            : "This is the same unpaid order as before. Resend the same link. Do not create another one.",
        };
      }
    }

    // A different basket replaces the earlier link, so first make sure that one wasn't paid already.
    if (open[0] && this.now().getTime() - Date.parse(open[0].createdAt) < RECENT_MS) {
      const earlier = await this.verifyPayment(open[0].reference, "chat");
      if (earlier.status === "paid" || earlier.status === "needs_review") {
        return {
          ok: false,
          error: earlier.status === "paid" ? "earlier_order_paid" : "earlier_payment_held",
          reference: open[0].reference,
          next_step:
            earlier.status === "paid"
              ? `No link was created: the customer has just paid for their earlier order ${open[0].reference}. Confirm that order. If they want this one as well, call create_payment_link again; if they meant to change the paid order, pass to Tola by replying: "${PASS_TO_TOLA}"`
              : `No link was created: a payment on their earlier order ${open[0].reference} is being checked by a staff member. Tell the customer they'll hear back shortly. Only create another link if they say this is a separate order.`,
        };
      }
      if (!earlier.ok) {
        return { ok: false, error: "payment_provider_unavailable", detail: earlier.detail, next_step: "The payment system is not responding. Apologise, keep the order details, and offer to try again in a few minutes." };
      }
    }

    const reference = newReference(this.now());
    const order: Order = {
      reference,
      createdAt: this.now().toISOString(),
      customerPhone: phone,
      lines: q.lines,
      deliveryZone: q.zone,
      subtotalNgn: q.subtotalNgn,
      deliveryFeeNgn: q.deliveryFeeNgn,
      totalNgn: q.totalNgn,
      status: "pending_payment",
      ...details,
    };
    await this.store.createOrder(order);

    let paymentUrl: string;
    try {
      paymentUrl = (
        await this.paystack.initialize({
          // Paystack requires an email. WhatsApp customers often don't give one, so use a placeholder per phone.
          // The domain must have a real TLD: Paystack rejects reserved ones like ".example".
          email: input.customerEmail?.trim() || `${phone.replace(/\D/g, "")}@${this.opts.placeholderEmailDomain ?? "example.com"}`,
          amountKobo: q.totalNgn * 100,
          reference,
          callbackUrl: this.opts.callbackUrl,
          metadata: { customer_name: order.customerName, customer_phone: phone, zone: q.zone },
        })
      ).authorizationUrl;
    } catch (e) {
      const err = e instanceof PaystackError ? e : new PaystackError(String(e), "provider_down");
      await this.store.updateOrder(reference, { status: "payment_failed", note: `link not created: ${err.message}` });
      return {
        ok: false,
        error: err.kind === "provider_down" ? "payment_provider_unavailable" : "payment_link_rejected",
        detail: err.message,
        next_step:
          err.kind === "provider_down"
            ? "The payment system is not responding. Apologise, keep the order details, and offer to try again in a few minutes."
            : "The payment link could not be created. Apologise and say a staff member will follow up. Do not retry more than once.",
      };
    }
    // The link is live: from here the customer's earlier unpaid links are replaced by it.
    const live = await this.store.activateOrder(reference, paymentUrl);
    if (live?.order.status !== "pending_payment") {
      // Another server made a newer link for this customer while we were waiting on Paystack.
      const newer = live?.order.replacedBy ? await this.store.getOrder(live.order.replacedBy) : undefined;
      if (newer?.paymentUrl && newer.status === "pending_payment" && sameBasket(newer, q.lines, q.zone, q.totalNgn) && newer.neededBy === neededBy && newer.deliveryAddress === details.deliveryAddress && (deliverBy === undefined || newer.deliverBy === deliverBy)) {
        return { ok: true, reused: true, reference: newer.reference, payment_url: newer.paymentUrl, total_ngn: newer.totalNgn, next_step: "Send this payment link and reference. Do not create another one." };
      }
      return { ok: false, error: "replaced", next_step: "Another link was made for this customer at the same moment. Call create_payment_link once more to get the current one." };
    }
    return {
      ok: true,
      reference,
      payment_url: paymentUrl,
      total_ngn: q.totalNgn,
      needed_by: neededBy,
      deliver_by: deliverBy,
      cancellation_policy: CANCELLATION_POLICY,
      replaced: live.replaced.length ? live.replaced : undefined,
      next_step: `Send the payment link and the reference. ${live.replaced.length ? `It replaces their earlier unpaid order (${live.replaced.join(", ")}): tell them not to pay the old link. ` : ""}If you haven't told them the cancellation_policy yet, tell them with the link, before they pay. Tell the customer to reply 'paid' when done. Never mark the order as confirmed yourself.`,
    };
  }

  /** Payments waiting for the owner, oldest first. */
  async heldPayments(): Promise<Order[]> {
    const orders = await this.store.listOrders();
    return orders.filter((o) => o.status === "needs_review").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Confirmed orders whose payment was then reversed, disputed or refunded, oldest first. */
  async paymentIssues(): Promise<Order[]> {
    const orders = await this.store.listOrders();
    return orders.filter((o) => o.status === "paid" && openIssue(o)).sort((a, b) => a.paymentIssue!.at.localeCompare(b.paymentIssue!.at));
  }

  /**
   * The owner's call on a held payment. "accept" puts it in the kitchen queue as paid (after a swap
   * is agreed, or a short payment is settled another way) and takes its day's capacity; "close" ends it
   * without confirming (refund given, or the payment was reversed).
   *
   * `receivedKobo` is what the owner has in hand when that isn't what Paystack reported.
   * `withoutStock` accepts an order its day has no capacity for, e.g. after agreeing a swap.
   */
  async review(reference: string, decision: "accept" | "close", by: string, opts: { receivedKobo?: number; withoutStock?: boolean } = {}): Promise<Order> {
    return this.withOrderLock(reference, async (ref) => {
      const settled = await this.store.transact(ref, async (order, shortOn) => {
        if (order.status !== "needs_review") throw new ReviewError("This payment isn't waiting for a review any more");
        const why = order.note ? `: ${order.note}` : "";
        if (decision === "close") {
          return { status: "closed", stockTaken: false, note: `closed after review by ${by}${why}` };
        }
        const received = opts.receivedKobo ?? heldKobo(order);
        if (received === undefined) throw new ReviewError("Enter the amount received for this order first");
        if (!Number.isInteger(received) || received <= 0) throw new ReviewError("The amount received must be more than 0");
        const short = order.stockTaken ? [] : await shortOn();
        if (short.length && !opts.withoutStock) {
          const names = short.map((sku) => order.lines.find((l) => l.sku === sku)?.name ?? sku);
          throw new ReviewError(`Not enough capacity on ${order.neededBy ?? "that day"} for ${names.join(", ")}. Raise it on the Capacity page, or tick "accept without stock" if you've agreed a swap.`);
        }
        return {
          status: "paid",
          paidAt: order.paidAt ?? this.now().toISOString(),
          paidKobo: received,
          stockTaken: short.length === 0,
          // Money Paystack already returned belongs to the old payment, not to what was received now.
          refundBaseKobo: order.refundedKobo ?? (/paystack: reversed/.test(order.note ?? "") ? order.totalNgn * 100 : undefined),
          refundedKobo: undefined,
          note: `accepted after review by ${by}${short.length ? " without stock" : ""}${why}`,
        };
      });
      if (!settled) throw new ReviewError("No order with that reference");
      if (decision === "accept") {
        // Paid on an old link: the newer one must not stay payable as well.
        if (settled.replacedBy) await this.store.transact(settled.replacedBy, async (o) => (OPEN_STATUSES.includes(o.status) ? { status: "replaced", replacedBy: ref } : undefined));
        this.notify("onPaid", settled);
      }
      return settled;
    });
  }

  async verifyPayment(reference: string, source: Source = "chat"): Promise<ToolResult> {
    return this.withOrderLock(reference, (ref) => this.verifyUnlocked(ref, source));
  }

  /** What to say about an order that's already settled, or undefined while it isn't. */
  private settled(order: Order): ToolResult | undefined {
    const { reference } = order;
    if (order.status === "paid" && openIssue(order)) {
      return { ok: true, status: "paid", reference, payment_issue: openIssue(order)!.kind, already_confirmed: true, next_step: `There is a problem with this payment after it was confirmed. Do not promise delivery or a refund. Reply to the customer yourself with: "${PASS_TO_TOLA}"` };
    }
    if (order.status === "paid" && order.cancelledAt) {
      return { ok: true, status: "paid", reference, cancelled: true, already_confirmed: true, next_step: "This order was paid and then cancelled. Say Tola will reply about the refund herself, in your own reply. Do not promise anything else." };
    }
    if (order.status === "paid") {
      return { ok: true, status: "paid", reference, total_ngn: order.totalNgn, lines: order.lines, zone: order.deliveryZone, needed_by: order.neededBy, deliver_by: order.deliverBy, already_confirmed: true, next_step: ALREADY_CONFIRMED };
    }
    if (order.status === "needs_review") {
      return { ok: true, status: "needs_review", reference, note: order.note, next_step: "A staff member is reviewing this payment. Tell the customer they will hear back shortly." };
    }
    if (order.status === "closed") {
      return { ok: true, status: "closed", reference, next_step: "Tola reviewed this payment and closed the order. Do not confirm it or send a new link for it. Say Tola will reply about it herself. Send that as your own reply; do not transfer or escalate the conversation." };
    }
    return undefined;
  }

  private async verifyUnlocked(reference: string, source: Source): Promise<ToolResult> {
    const order = await this.store.getOrder(reference);
    if (!order) {
      return { ok: false, error: "unknown_reference", next_step: "No order has this reference. Ask the customer to check it, or look at the reference you sent them earlier." };
    }
    const done = this.settled(order);
    if (done) return done;

    let v: VerifyResult;
    try {
      v = await this.paystack.verify(reference);
    } catch (e) {
      if (e instanceof PaystackError && e.kind === "not_found") return this.notPaidYet(order);
      return this.unavailable(e);
    }
    if (v.status === "success") return this.settleSuccess(reference, v, source);

    // A background check leaves a declined order as it is: the customer may be retrying on the same page.
    if ((v.status === "failed" && source !== "reconcile") || v.status === "reversed") {
      const note = `paystack: ${v.status} ${v.gatewayResponse ?? ""}`.trim();
      const failed = v.status === "failed";
      let wrote = false;
      const now = await this.store.transact(reference, async (o) => {
        wrote = false;
        // A replaced order stays replaced: a declined card on an old link changes nothing.
        if (failed ? !OPEN_STATUSES.includes(o.status) : this.settled(o)) return undefined;
        wrote = true;
        return failed ? { status: "payment_failed", note } : { status: "needs_review", note, paidKobo: v.amountKobo, refundedKobo: v.amountKobo };
      });
      if (!wrote && now) return this.settled(now) ?? this.notPaidYet(now);
      if (!failed && now) this.notify("onHeld", now);
      return {
        ok: true,
        status: failed ? "payment_failed" : "needs_review",
        reason: v.gatewayResponse,
        reference,
        next_step: failed
          ? "The payment failed. Tell the customer kindly, give the reason if it's clear, and offer a fresh payment link with create_payment_link."
          : "The payment was reversed. A staff member must handle this. Do not confirm.",
      };
    }

    // abandoned / ongoing / pending / queued, or a decline seen in the background: not paid yet, link may still work
    return this.notPaidYet(order, v.status);
  }

  private async notPaidYet(order: Order, paystackStatus?: string): Promise<ToolResult> {
    if (order.status === "replaced") {
      const newer = order.replacedBy ? await this.store.getOrder(order.replacedBy) : undefined;
      return { ok: true, status: "replaced", reference: order.reference, replaced_by: order.replacedBy, payment_url: newer?.paymentUrl, next_step: `This order was replaced by ${order.replacedBy} and hasn't been paid. Tell the customer not to use the old link, and send the newer order's link if they still want it.` };
    }
    return paystackStatus === undefined
      ? { ok: true, status: "not_paid_yet", reference: order.reference, payment_url: order.paymentUrl, next_step: "No payment yet. Resend the link and ask the customer to complete it." }
      : { ok: true, status: "not_paid_yet", paystack_status: paystackStatus, reference: order.reference, payment_url: order.paymentUrl, next_step: "Payment not completed yet. Resend the link and ask them to finish, then say 'paid'." };
  }

  private unavailable(e: unknown): ToolResult {
    return { ok: false, error: "payment_provider_unavailable", detail: e instanceof Error ? e.message : String(e), next_step: "Could not reach the payment system. Do not confirm the order. Ask the customer to wait a minute and try again." };
  }

  /** Paystack has the money. The day's capacity and the status are decided and saved in one write, so a crash can't leave one without the other. */
  private async settleSuccess(reference: string, v: VerifyResult, source: Source): Promise<ToolResult> {
    let result: ToolResult | undefined;
    const after = await this.store.transact(reference, async (o, shortOn) => {
      result = this.settled(o); // another server may have settled it while we asked Paystack
      if (result) return undefined;
      const expectedKobo = o.totalNgn * 100;
      const paid: Partial<Order> = { paidAt: v.paidAt ?? this.now().toISOString(), paidKobo: v.currency === "NGN" ? v.amountKobo : undefined };
      const hold = (note: string): Partial<Order> => ({ ...paid, status: "needs_review", note });
      if (o.status === "replaced") return hold(`paid on a replaced order: replaced by ${o.replacedBy}, paid ${v.amountKobo} ${v.currency}, expected ${expectedKobo} NGN`);
      if (v.amountKobo !== expectedKobo || v.currency !== "NGN") return hold(`amount mismatch: paid ${v.amountKobo} ${v.currency}, expected ${expectedKobo} NGN`);
      const short = await shortOn();
      if (short.length) return hold(`paid but oversold: ${short.join(", ")} (${source})`);
      return { ...paid, status: "paid", stockTaken: true, note: `verified via ${source}` };
    });
    if (result) return result;
    if (!after) return { ok: false, error: "unknown_reference", next_step: "No order has this reference. Ask the customer to check it." };

    if (after.status === "paid") {
      this.notify("onPaid", after);
      return {
        ok: true,
        status: "paid",
        reference,
        total_ngn: after.totalNgn,
        lines: after.lines,
        zone: after.deliveryZone,
        needed_by: after.neededBy,
        deliver_by: after.deliverBy,
        next_step: "Payment verified. Confirm the order, the delivery zone, and that the kitchen will message on dispatch. Remind them it can't be cancelled once cooking starts.",
      };
    }
    this.notify("onHeld", after);
    const note = after.note ?? "";
    return {
      ok: true,
      status: "needs_review",
      reference,
      note,
      next_step: note.startsWith("paid but oversold")
        ? "Payment received but an item sold out. Apologise, say the owner will call to offer a swap or a refund. Do not promise delivery."
        : note.startsWith("paid on a replaced order")
          ? "This was paid on an old link that a newer order replaced. Do not confirm it, and tell the customer not to pay the newer link. Say a staff member will check and reply shortly."
          : "Do not confirm. Tell the customer a staff member will check their payment and reply shortly.",
    };
  }

  /** Look again at an order that was paid: has money gone back to the customer since? Safe to repeat. */
  async recheckPaid(reference: string, because?: "refund_failed"): Promise<ToolResult> {
    return this.withOrderLock(reference, async (ref) => {
      const order = await this.store.getOrder(ref);
      if (!order) return { ok: false, error: "unknown_reference", next_step: "No order has this reference." };
      if (!this.settled(order)) return this.verifyUnlocked(ref, "webhook");
      let v: VerifyResult;
      let refunds = { processedKobo: 0, pendingKobo: 0 };
      try {
        v = await this.paystack.verify(ref);
        if (v.id !== undefined) refunds = await this.paystack.refunds(v.id);
      } catch (e) {
        if (e instanceof PaystackError && e.kind === "not_found") return { ok: true, status: order.status, reference: ref, changed: false, next_step: "" };
        return this.unavailable(e);
      }
      if (because === "refund_failed") this.notify("onRefundFailed", order);
      // "reversed" with no refund on record is a chargeback or a bank reversal: all of it went back.
      const reversed = v.status === "reversed" && refunds.processedKobo + refunds.pendingKobo === 0;
      return this.recordReturned(ref, reversed ? v.amountKobo : refunds.processedKobo, v.amountKobo, reversed ? `The bank or card issuer reversed the payment of ${naira(v.amountKobo)}.` : undefined);
    });
  }

  /** Save how much of `amount` has gone back in total. All of it going back, unasked, pauses the order for the owner. */
  private async recordReturned(reference: string, totalReturned: number, amount: number, reversedDetail?: string, lostDispute?: PaymentIssue): Promise<ToolResult> {
    let changed = false;
    let refundChanged = false;
    let raised = false;
    const after = await this.store.transact(reference, async (o) => {
      const refundedKobo = Math.max(o.refundedKobo ?? 0, totalReturned - (o.refundBaseKobo ?? 0));
      changed = refundedKobo !== (o.refundedKobo ?? 0);
      const next: Order = { ...o, refundedKobo: refundedKobo || undefined };
      refundChanged = refundKobo(next) !== refundKobo(o);
      const patch: Partial<Order> = changed ? { refundedKobo, refundSeq: (o.refundSeq ?? 0) + (refundChanged ? 1 : 0) } : {};
      // The owner already agreed to return this much, or cancelled the order: nothing new to decide.
      const expected = Boolean(o.cancelledAt) || (o.refundDueKobo ?? 0) >= refundedKobo;
      const all = refundedKobo > 0 && totalReturned >= amount;
      raised = o.status === "paid" && (lostDispute ? o.paymentIssue?.detail !== lostDispute.detail : changed && all && !expected);
      if (raised) {
        patch.paymentIssue = lostDispute ?? { kind: reversedDetail ? "reversed" : "refunded", at: this.now().toISOString(), detail: reversedDetail ?? `The payment of ${naira(amount)} was refunded in full.` };
      }
      return Object.keys(patch).length ? patch : undefined;
    });
    if (!after) return { ok: false, error: "unknown_reference", next_step: "No order has this reference." };
    if (after.status === "paid" && refundChanged) this.notify("onRefund", after);
    if (raised) this.notify("onIssue", after);
    return { ok: true, status: after.status, reference, changed: changed || raised, next_step: "" };
  }

  /** A dispute was opened, updated or settled. Paystack is asked for its state. Safe to repeat. */
  async recordDispute(reference: string, disputeId: string): Promise<ToolResult> {
    return this.withOrderLock(reference, async (ref) => {
      const order = await this.store.getOrder(ref);
      if (!order) return { ok: false, error: "unknown_reference", next_step: "No order has this reference." };
      let d;
      try {
        d = await this.paystack.dispute(disputeId);
      } catch (e) {
        if (e instanceof PaystackError && e.kind === "not_found") return { ok: true, status: order.status, reference: ref, changed: false, next_step: "" };
        return this.unavailable(e);
      }
      if (d.reference && normaliseReference(d.reference) !== ref) return { ok: true, status: order.status, reference: ref, changed: false, next_step: "" };

      const amount = order.paidKobo ?? order.totalNgn * 100;
      if (d.status === "resolved" && /accepted/.test(d.resolution ?? "")) {
        const lost = d.refundKobo || amount;
        const at = this.now().toISOString();
        // Earlier refunds and the dispute's amount can overlap, so the larger is kept, not the sum.
        return this.recordReturned(ref, lost + (order.refundBaseKobo ?? 0), amount, undefined, { kind: "disputed", at, detail: `Dispute lost: ${naira(lost)} goes back to the customer.`, disputeId });
      }
      let raised = false;
      const after = await this.store.transact(ref, async (o) => {
        raised = false;
        if (o.status !== "paid") return undefined;
        const mine = o.paymentIssue?.disputeId === disputeId ? o.paymentIssue : undefined;
        if (d.status === "resolved") return d.resolution === "declined" && mine && !mine.resolvedAt ? { paymentIssue: { ...mine, resolvedAt: this.now().toISOString(), resolvedBy: "paystack" } } : undefined;
        if (mine) return undefined; // a reminder, or already settled by the owner
        raised = true;
        return { paymentIssue: { kind: "disputed", at: this.now().toISOString(), detail: `The customer's bank opened a dispute${d.refundKobo ? ` for ${naira(d.refundKobo)}` : ""}. Answer it on the Paystack dashboard before its deadline.`, disputeId } };
      });
      if (raised && after) this.notify("onIssue", after);
      return { ok: true, status: after?.status, reference: ref, changed: raised, next_step: "" };
    });
  }

  /** The owner has dealt with a payment issue and the kitchen may carry on. */
  async clearIssue(reference: string, by: string): Promise<Order> {
    return this.withOrderLock(reference, async (ref) => {
      const after = await this.store.transact(ref, async (o) => {
        const issue = openIssue(o);
        if (!issue) throw new ReviewError("This order has no open payment problem");
        return { paymentIssue: { ...issue, resolvedAt: this.now().toISOString(), resolvedBy: by } };
      });
      if (!after) throw new ReviewError("No order with that reference");
      return after;
    });
  }

  /** The owner records what is being returned in total on a paid order. The money itself is sent outside this app. */
  async setRefund(reference: string, kobo: number): Promise<Order> {
    return this.withOrderLock(reference, async (ref) => {
      let changed = false;
      const after = await this.store.transact(ref, async (o) => {
        if (o.status !== "paid") throw new ReviewError("Only a paid order can have a refund");
        if (!Number.isInteger(kobo) || kobo < 0) throw new ReviewError("Enter the refund, 0 or more");
        if (kobo > paidKobo(o)) throw new ReviewError(`The refund can't be more than the ${naira(paidKobo(o))} received`);
        if (kobo < (o.refundedKobo ?? 0)) throw new ReviewError(`Paystack has already returned ${naira(o.refundedKobo ?? 0)}`);
        changed = refundKobo({ ...o, refundDueKobo: kobo }) !== refundKobo(o);
        return { refundDueKobo: kobo, refundSeq: (o.refundSeq ?? 0) + (changed ? 1 : 0) };
      });
      if (!after) throw new ReviewError("No order with that reference");
      if (changed) this.notify("onRefund", after);
      return after;
    });
  }
}

export class ReviewError extends Error {}
