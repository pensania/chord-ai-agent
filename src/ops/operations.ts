import { CANCELLATION_POLICY, hasStock, normaliseReference, openIssue, paidKobo, policyRefundKobo, refundKobo, type Order } from "../domain.js";
import { KeyedLock } from "../lock.js";
import type { Store } from "../store/types.js";
import { FINAL_STAGES, type OpsStore, type OrderOps, type Role, type Staff, type Stage } from "./types.js";

/** Who may move an order from one stage to the next. The owner may make any move. */
const MOVES: Record<Stage, Partial<Record<Stage, Role[]>>> = {
  new: { accepted: ["intake"], cancelled: [] },
  accepted: { cooking: ["kitchen"], cancelled: [] },
  cooking: { ready: ["kitchen"], cancelled: [] },
  ready: { out_for_delivery: ["dispatch"], picked_up: ["intake", "dispatch"], cancelled: [] },
  out_for_delivery: { delivered: ["rider", "dispatch"], ready: ["dispatch"], cancelled: [] },
  delivered: {},
  picked_up: {},
  cancelled: {},
};

/**
 * A customer may cancel while the order is waiting, not once cooking has started. After that only
 * the owner can, for the kitchen's own reasons (it can't be made or delivered, the payment went
 * bad), and has to say why.
 *
 * Cancelling before cooking starts frees the order's place on its day. After that the food is made, so it stays used.
 */
export const CUSTOMER_CAN_CANCEL: readonly Stage[] = ["new", "accepted"];

export const STAGE_LABEL: Record<Stage, string> = {
  new: "Paid, waiting to be accepted",
  accepted: "Accepted by the kitchen",
  cooking: "Cooking",
  ready: "Ready",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  picked_up: "Picked up",
  cancelled: "Cancelled",
};

export type Actor = { kind: "owner" } | { kind: "staff"; staff: Staff };

export type QueueItem = {
  order: Order;
  ops: OrderOps;
  cook?: Staff;
  rider?: Staff;
  /** Moves this actor may make now. */
  nextStages: Stage[];
};

export type StageEvent = {
  reference: string;
  from: Stage;
  to: Stage;
  by: string;
  customerPhone: string;
  customerMessage: string;
};

export class OpsError extends Error {
  constructor(message: string, readonly code: "not_found" | "not_paid" | "bad_move" | "forbidden" | "bad_input" | "conflict") {
    super(message);
  }
}

const isPickup = (o: Order) => o.deliveryZone.toLowerCase() === "pickup";

/** Lagos has no daylight saving: local date = UTC + 1 hour. */
export function lagosDate(d: Date): string {
  return new Date(d.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The text a customer should get when their order reaches a stage. */
export function customerMessage(order: Order, to: Stage, rider?: Staff): string {
  const first = order.customerName.split(/\s+/)[0] || "there";
  const ref = order.reference;
  switch (to) {
    case "accepted":
      return `Hi ${first}, Mama Tola's Kitchen has accepted your order ${ref}. We'll let you know when it's cooking. You can still cancel until then.`;
    case "cooking":
      return `Hi ${first}, your order ${ref} is cooking now, so it can no longer be cancelled.`;
    case "ready":
      return isPickup(order)
        ? `Hi ${first}, your order ${ref} is ready for pickup at our Yaba kitchen.`
        : `Hi ${first}, your order ${ref} is packed and waiting for a rider.`;
    case "out_for_delivery":
      return rider
        ? `Hi ${first}, your order ${ref} is on the way with ${rider.name.replace(/\s*\(.*\)$/, "")} (${rider.phone}).`
        : `Hi ${first}, your order ${ref} is on the way.`;
    case "delivered":
      return `Hi ${first}, your order ${ref} has been delivered. Enjoy, and thank you for choosing Mama Tola's Kitchen!`;
    case "picked_up":
      return `Hi ${first}, thanks for picking up order ${ref}. Enjoy!`;
    case "cancelled":
      return refundKobo(order) > 0
        ? `Hi ${first}, your order ${ref} has been cancelled. A refund of ₦${(refundKobo(order) / 100).toLocaleString("en-NG")} is due to you, and Tola will contact you about it.`
        : `Hi ${first}, your order ${ref} has been cancelled. Tola will contact you about it.`;
    default:
      return `Hi ${first}, update on order ${ref}: ${STAGE_LABEL[to]}.`;
  }
}

export class Operations {
  private lock = new KeyedLock();

  constructor(
    private store: Store,
    private ops: OpsStore,
    private opts: {
      now?: () => Date;
      onStageChange?: (e: StageEvent) => void | Promise<void>;
      /** Runs changes to the order and its stage as one, where the stores can (Postgres). Without it they're saved one after the other. */
      atomic?: <T>(fn: () => Promise<T>) => Promise<T>;
      /** Takes the order's ingredients out of stock when cooking starts. */
      stock?: { consumeForOrder(order: Order, by: string): Promise<unknown> };
    } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  today() {
    return lagosDate(this.now());
  }

  /** Paid orders start at "new" without any write; the ops record is created on the first move. */
  private async opsFor(order: Order): Promise<OrderOps> {
    return (await this.ops.getOrderOps(order.reference)) ?? { reference: order.reference, stage: "new", history: [] };
  }

  allowedMoves(order: Order, current: OrderOps, actor: Actor): Stage[] {
    const moves = MOVES[current.stage];
    return (Object.keys(moves) as Stage[]).filter((to) => {
      if (to === "out_for_delivery" && isPickup(order)) return false;
      if (to === "picked_up" && !isPickup(order)) return false;
      if (actor.kind === "owner") return true;
      if (openIssue(order)) return false; // the payment was reversed or disputed: the owner decides
      const roles = moves[to] ?? [];
      if (!actor.staff.active || !roles.some((r) => actor.staff.roles.includes(r))) return false;
      // A rider may only close their own delivery.
      if (to === "delivered" && !actor.staff.roles.includes("dispatch")) return current.riderId === actor.staff.id;
      return true;
    });
  }

  /** Staff on a role for a date, from the rota. */
  async onDuty(date: string, role: Role): Promise<Staff[]> {
    const [rota, staff] = await Promise.all([this.ops.listRota(date, date), this.ops.listStaff()]);
    const ids = new Set(rota.filter((r) => r.role === role).map((r) => r.staffId));
    return staff.filter((s) => s.active && ids.has(s.id));
  }

  /** Paid orders still in progress (or all, with includeDone), soonest due first. */
  async queue(actor: Actor, opts: { includeDone?: boolean } = {}): Promise<QueueItem[]> {
    const [orders, staff] = await Promise.all([this.store.listOrders(), this.ops.listStaff()]);
    const byId = new Map(staff.map((s) => [s.id, s]));
    const items: QueueItem[] = [];
    for (const order of orders.filter((o) => o.status === "paid")) {
      const ops = await this.opsFor(order);
      if (!opts.includeDone && FINAL_STAGES.includes(ops.stage)) continue;
      items.push({
        order,
        ops,
        cook: ops.cookId ? byId.get(ops.cookId) : undefined,
        rider: ops.riderId ? byId.get(ops.riderId) : undefined,
        nextStages: this.allowedMoves(order, ops, actor),
      });
    }
    const due = (i: QueueItem) => (i.order.neededBy ? `${i.order.neededBy} ${i.order.deliverBy ?? "24:00"}` : "9999");
    return items.sort((a, b) => due(a).localeCompare(due(b)) || (a.order.paidAt ?? "").localeCompare(b.order.paidAt ?? ""));
  }

  async detail(reference: string, actor: Actor): Promise<QueueItem> {
    const order = await this.store.getOrder(normaliseReference(reference));
    if (!order) throw new OpsError("No order with that reference", "not_found");
    const ops = await this.opsFor(order);
    const staff = await this.ops.listStaff();
    const byId = new Map(staff.map((s) => [s.id, s]));
    return {
      order,
      ops,
      cook: ops.cookId ? byId.get(ops.cookId) : undefined,
      rider: ops.riderId ? byId.get(ops.riderId) : undefined,
      nextStages: order.status === "paid" ? this.allowedMoves(order, ops, actor) : [],
    };
  }

  /** Pick the on-duty person on `role` with the fewest open orders of the given stages. */
  private async leastBusy(role: Role, field: "cookId" | "riderId", stages: Stage[]): Promise<Staff | undefined> {
    const duty = await this.onDuty(this.today(), role);
    if (duty.length === 0) return undefined;
    const all = await this.ops.listOrderOps();
    const load = (id: string) => all.filter((o) => o[field] === id && stages.includes(o.stage)).length;
    return [...duty].sort((a, b) => load(a.id) - load(b.id) || a.name.localeCompare(b.name))[0];
  }

  /**
   * What to refund if the order is cancelled now, in kobo. Before cooking it's the policy; after
   * that it's the kitchen cancelling, so all of it. Never less than already went back.
   */
  suggestedRefundKobo(order: Order, stage: Stage = "new") {
    return Math.max(order.refundedKobo ?? 0, CUSTOMER_CAN_CANCEL.includes(stage) ? policyRefundKobo(order, this.now()) : paidKobo(order));
  }

  /**
   * Record the cancellation on the order: the refund the owner agreed, and its day's capacity freed
   * when cooking hasn't started. Safe to repeat: where this can't be saved together with the stage
   * (see `atomic`), a crash in between is fixed by cancelling again.
   */
  private async cancelOrder(order: Order, from: Stage, by: string, agreedKobo?: number): Promise<Order> {
    const after = await this.store.transact(order.reference, async (o) => {
      const due = agreedKobo ?? (o.cancelledAt ? o.refundDueKobo : undefined) ?? Math.max(o.refundDueKobo ?? 0, this.suggestedRefundKobo(o, from));
      if (!Number.isInteger(due) || due < 0) throw new OpsError("Enter the refund, 0 or more", "bad_input");
      if (due > paidKobo(o)) throw new OpsError(`The refund can't be more than the ₦${(paidKobo(o) / 100).toLocaleString("en-NG")} received`, "bad_input");
      if (due < (o.refundedKobo ?? 0)) throw new OpsError(`Paystack has already returned ₦${((o.refundedKobo ?? 0) / 100).toLocaleString("en-NG")}`, "bad_input");
      const restock = CUSTOMER_CAN_CANCEL.includes(from) && hasStock(o);
      const issue = openIssue(o);
      const at = this.now().toISOString();
      return {
        cancelledAt: o.cancelledAt ?? at,
        refundDueKobo: due,
        refundSeq: (o.refundSeq ?? 0) + (refundKobo({ ...o, refundDueKobo: due }) !== refundKobo(o) ? 1 : 0),
        ...(restock ? { stockTaken: false } : {}),
        ...(issue ? { paymentIssue: { ...issue, resolvedAt: at, resolvedBy: by } } : {}),
      };
    });
    if (!after) throw new OpsError("No order with that reference", "not_found");
    return after;
  }

  /**
   * One move at a time per order in this process, and one per version of the order across
   * processes, so two people can't overwrite each other. `version` is the one the person was
   * looking at: a move made from an old page is refused instead of applied to a newer stage.
   */
  move(reference: string, to: Stage, actor: Actor, opts: { riderId?: string; note?: string; /** When cancelling: what the owner is returning. Defaults to the policy. */ refundKobo?: number; version?: number } = {}): Promise<QueueItem> {
    const ref = normaliseReference(reference);
    return this.lock.run(ref, () => this.moveLocked(ref, to, actor, opts));
  }

  /** What to tell someone whose move lost out to another. */
  private async conflict(now: OrderOps) {
    const last = now.history.at(-1);
    const who = !last ? "Someone" : last.by === "owner" ? "The owner" : ((await this.ops.getStaff(last.by))?.name ?? last.by).replace(/\s*\(.*\)$/, "");
    return new OpsError(`${who} already changed this order. It's now: ${STAGE_LABEL[now.stage]}. Check it before you move it.`, "conflict");
  }

  private async moveLocked(reference: string, to: Stage, actor: Actor, opts: { riderId?: string; note?: string; refundKobo?: number; version?: number }): Promise<QueueItem> {
    let order = await this.store.getOrder(reference);
    if (!order) throw new OpsError("No order with that reference", "not_found");
    if (order.status !== "paid") throw new OpsError("Only verified, paid orders can move through the kitchen", "not_paid");
    const current = await this.opsFor(order);
    if (opts.version !== undefined && opts.version !== (current.version ?? 0)) throw await this.conflict(current);
    if (!(to in MOVES[current.stage])) throw new OpsError(`Can't go from ${current.stage} to ${to}`, "bad_move");
    if (actor.kind === "staff" && openIssue(order)) throw new OpsError("This order's payment has a problem. Wait for the owner to settle it.", "forbidden");
    if (!this.allowedMoves(order, current, actor).includes(to)) throw new OpsError("Your role can't make this change", "forbidden");

    if (to === "cancelled" && !CUSTOMER_CAN_CANCEL.includes(current.stage) && !opts.note?.trim()) {
      throw new OpsError("Cooking has started, so the customer can't cancel. To cancel it for the kitchen's own reasons, say why.", "bad_input");
    }

    const next: OrderOps = structuredClone(current);
    if (to === "accepted" && !next.cookId) next.cookId = (await this.leastBusy("kitchen", "cookId", ["accepted", "cooking"]))?.id;
    if (to === "out_for_delivery") {
      let rider: Staff | undefined;
      if (opts.riderId) {
        rider = await this.ops.getStaff(opts.riderId);
        if (!rider || !rider.active || !rider.roles.includes("rider")) throw new OpsError("That rider doesn't exist or isn't active", "bad_input");
      } else {
        rider = await this.leastBusy("rider", "riderId", ["out_for_delivery"]);
      }
      next.riderId = rider?.id;
    }
    if (to === "ready" && current.stage === "out_for_delivery") next.riderId = undefined; // returned to the kitchen
    const by = actor.kind === "owner" ? "owner" : actor.staff.id;
    next.history.push({ at: this.now().toISOString(), from: current.stage, to, by, note: opts.note?.trim() || undefined });
    next.stage = to;
    const before = order;
    order = await (this.opts.atomic ?? ((fn) => fn()))(async () => {
      const after = to === "cancelled" ? await this.cancelOrder(before, current.stage, by, opts.refundKobo) : before;
      // Someone else moved it first: undo the cancellation along with this move.
      if (!(await this.ops.saveOrderOps(next))) throw await this.conflict(await this.opsFor(before));
      return after;
    });
    if (to === "cooking" && this.opts.stock) {
      try {
        await this.opts.stock.consumeForOrder(order, by);
      } catch (e) {
        console.error("stock deduction failed", e); // the kitchen still cooks; the count can be fixed on the Stock page
      }
    }

    const rider = next.riderId ? await this.ops.getStaff(next.riderId) : undefined;
    const event: StageEvent = { reference: order.reference, from: current.stage, to, by, customerPhone: order.customerPhone, customerMessage: customerMessage(order, to, rider) };
    try {
      await this.opts.onStageChange?.(event);
    } catch (e) {
      console.error("stage notify failed", e); // a failed notification must not undo the move
    }
    return this.detail(order.reference, actor);
  }

  /** What the agent may tell a customer about their order. */
  async customerStatus(reference: string): Promise<Record<string, unknown> & { ok: boolean; next_step: string }> {
    const order = await this.store.getOrder(normaliseReference(reference));
    if (!order) return { ok: false, error: "unknown_reference", next_step: "No order has this reference. Ask the customer to check it." };
    if (order.status !== "paid") {
      return { ok: true, reference: order.reference, payment_status: order.status, next_step: "This order isn't confirmed as paid. Call verify_payment before saying anything about payment." };
    }
    if (openIssue(order)) {
      return { ok: true, reference: order.reference, payment_issue: openIssue(order)!.kind, next_step: "There is a problem with this order's payment, so it's paused. Say Tola will reply about it herself, in your own reply (don't transfer or escalate the conversation). Don't promise delivery." };
    }
    const ops = await this.opsFor(order);
    const rider = ops.riderId ? await this.ops.getStaff(ops.riderId) : undefined;
    return {
      ok: true,
      reference: order.reference,
      stage: ops.stage,
      stage_label: STAGE_LABEL[ops.stage],
      needed_by: order.neededBy,
      deliver_by: order.deliverBy,
      pickup: isPickup(order),
      rider: ops.stage === "out_for_delivery" && rider ? { name: rider.name.replace(/\s*\(.*\)$/, ""), phone: rider.phone } : undefined,
      last_update: ops.history.at(-1)?.at,
      can_cancel: CUSTOMER_CAN_CANCEL.includes(ops.stage),
      cancellation_policy: CANCELLATION_POLICY,
      next_step:
        ops.stage === "cancelled"
          ? "The order was cancelled. Say Tola will reply about the refund herself, in your own reply (don't transfer or escalate the conversation). Don't promise anything else."
          : "Tell the customer the stage in one short sentence. Only share the rider's name and number if given here. Don't promise exact times. If they ask to cancel: when can_cancel is true, say Tola will confirm it herself (don't transfer or escalate, and don't say it's cancelled); when it's false, say kindly that cooking has started, so it can't be cancelled.",
    };
  }
}
