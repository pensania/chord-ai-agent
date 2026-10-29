import type { Order } from "../domain.js";
import type { Store } from "../store/types.js";
import { FINAL_STAGES, type OpsStore, type OrderOps, type Role, type Staff, type Stage } from "./types.js";

/** Who may move an order from one stage to the next. The owner may make any move. */
const MOVES: Record<Stage, Partial<Record<Stage, Role[]>>> = {
  new: { accepted: ["intake"], cancelled: [] },
  accepted: { cooking: ["kitchen"], cancelled: [] },
  cooking: { ready: ["kitchen"], cancelled: [] },
  ready: { out_for_delivery: ["dispatch"], picked_up: ["intake", "dispatch"], cancelled: [] },
  out_for_delivery: { delivered: ["rider", "dispatch"], ready: ["dispatch"] },
  delivered: {},
  picked_up: {},
  cancelled: {},
};

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
  constructor(message: string, readonly code: "not_found" | "not_paid" | "bad_move" | "forbidden" | "bad_input") {
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
      return `Hi ${first}, Mama Tola's Kitchen has accepted your order ${ref}. We'll let you know when it's cooking.`;
    case "cooking":
      return `Hi ${first}, your order ${ref} is cooking now.`;
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
      return `Hi ${first}, your order ${ref} has been cancelled. Tola will contact you about a refund.`;
    default:
      return `Hi ${first}, update on order ${ref}: ${STAGE_LABEL[to]}.`;
  }
}

export class Operations {
  constructor(
    private store: Store,
    private ops: OpsStore,
    private opts: { now?: () => Date; onStageChange?: (e: StageEvent) => void | Promise<void> } = {},
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
    const due = (i: QueueItem) => i.order.neededBy ?? "9999";
    return items.sort((a, b) => due(a).localeCompare(due(b)) || (a.order.paidAt ?? "").localeCompare(b.order.paidAt ?? ""));
  }

  async detail(reference: string, actor: Actor): Promise<QueueItem> {
    const order = await this.store.getOrder(reference.trim().toUpperCase());
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

  async move(reference: string, to: Stage, actor: Actor, opts: { riderId?: string; note?: string } = {}): Promise<QueueItem> {
    const order = await this.store.getOrder(reference.trim().toUpperCase());
    if (!order) throw new OpsError("No order with that reference", "not_found");
    if (order.status !== "paid") throw new OpsError("Only verified, paid orders can move through the kitchen", "not_paid");
    const current = await this.opsFor(order);
    if (!(to in MOVES[current.stage])) throw new OpsError(`Can't go from ${current.stage} to ${to}`, "bad_move");
    if (!this.allowedMoves(order, current, actor).includes(to)) throw new OpsError("Your role can't make this change", "forbidden");

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
    await this.ops.saveOrderOps(next);

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
    const order = await this.store.getOrder(reference.trim().toUpperCase());
    if (!order) return { ok: false, error: "unknown_reference", next_step: "No order has this reference. Ask the customer to check it." };
    if (order.status !== "paid") {
      return { ok: true, reference: order.reference, payment_status: order.status, next_step: "This order isn't confirmed as paid. Call verify_payment before saying anything about payment." };
    }
    const ops = await this.opsFor(order);
    const rider = ops.riderId ? await this.ops.getStaff(ops.riderId) : undefined;
    return {
      ok: true,
      reference: order.reference,
      stage: ops.stage,
      stage_label: STAGE_LABEL[ops.stage],
      needed_by: order.neededBy,
      pickup: isPickup(order),
      rider: ops.stage === "out_for_delivery" && rider ? { name: rider.name.replace(/\s*\(.*\)$/, ""), phone: rider.phone } : undefined,
      last_update: ops.history.at(-1)?.at,
      next_step:
        ops.stage === "cancelled"
          ? "The order was cancelled. Hand off to Tola for the refund; don't promise anything else."
          : "Tell the customer the stage in one short sentence. Only share the rider's name and number if given here. Don't promise exact times.",
    };
  }
}
