import { describe, expect, it } from "vitest";
import type { Order } from "../src/domain.js";
import { MemoryOpsStore } from "../src/ops/memory.js";
import { customerMessage, lagosDate, Operations, OpsError, type Actor, type StageEvent } from "../src/ops/operations.js";
import { MemoryStore } from "../src/store/memory.js";

const NOW = new Date("2026-11-05T09:00:00Z"); // Thursday, 10:00 in Lagos
const TODAY = "2026-11-05";

function order(ref: string, patch: Partial<Order> = {}): Order {
  return {
    reference: ref,
    createdAt: "2026-11-05T08:00:00Z",
    customerName: "Ada Obi",
    customerPhone: "+2348031234567",
    lines: [{ sku: "JOL-SMALL", name: "Party jollof tray (small, serves 10)", qty: 2, unitPriceNgn: 25000, lineTotalNgn: 50000 }],
    deliveryZone: "Yaba",
    deliveryAddress: "12 Herbert Macaulay Way",
    subtotalNgn: 50000,
    deliveryFeeNgn: 3000,
    totalNgn: 53000,
    status: "paid",
    paidAt: "2026-11-05T08:05:00Z",
    ...patch,
  };
}

async function setup() {
  const store = new MemoryStore();
  const opsStore = new MemoryOpsStore();
  const events: StageEvent[] = [];
  const ops = new Operations(store, opsStore, { now: () => NOW, onStageChange: (e) => void events.push(e) });
  await opsStore.setRota(TODAY, "kitchen", ["kemi", "segun"]);
  await opsStore.setRota(TODAY, "rider", ["musa", "chidi"]);
  await opsStore.setRota(TODAY, "intake", ["ifeoma"]);
  const staff = async (id: string): Promise<Actor> => ({ kind: "staff", staff: (await opsStore.getStaff(id))! });
  return { store, opsStore, ops, events, staff, owner: { kind: "owner" } as Actor };
}

describe("order stages", () => {
  it("runs a delivery order from new to delivered, assigning a cook and a rider from the rota", async () => {
    const { store, ops, events, staff } = await setup();
    await store.createOrder(order("MTK-1"));

    expect((await ops.queue(await staff("ifeoma")))[0].ops.stage).toBe("new");
    await ops.move("MTK-1", "accepted", await staff("ifeoma"));
    const cooking = await ops.move("MTK-1", "cooking", await staff("kemi"));
    expect(cooking.cook?.id).toMatch(/kemi|segun/);
    await ops.move("MTK-1", "ready", await staff("segun"));
    const out = await ops.move("MTK-1", "out_for_delivery", { kind: "owner" });
    expect(["musa", "chidi"]).toContain(out.rider?.id);
    const done = await ops.move("MTK-1", "delivered", await staff(out.rider!.id));
    expect(done.ops.stage).toBe("delivered");
    expect(done.ops.history.map((h) => h.to)).toEqual(["accepted", "cooking", "ready", "out_for_delivery", "delivered"]);
    expect(events.map((e) => e.to)).toEqual(["accepted", "cooking", "ready", "out_for_delivery", "delivered"]);
    expect(events[3].customerMessage).toContain("on the way with");
  });

  it("spreads new orders across the cooks on duty", async () => {
    const { store, ops, staff } = await setup();
    await store.createOrder(order("MTK-A"));
    await store.createOrder(order("MTK-B"));
    const a = await ops.move("MTK-A", "accepted", await staff("ifeoma"));
    const b = await ops.move("MTK-B", "accepted", await staff("ifeoma"));
    expect(new Set([a.cook?.id, b.cook?.id])).toEqual(new Set(["kemi", "segun"]));
  });

  it("refuses moves the role doesn't allow, and skipped stages", async () => {
    const { store, ops, staff } = await setup();
    await store.createOrder(order("MTK-2"));
    await expect(ops.move("MTK-2", "accepted", await staff("musa"))).rejects.toMatchObject({ code: "forbidden" });
    await expect(ops.move("MTK-2", "ready", { kind: "owner" })).rejects.toMatchObject({ code: "bad_move" });
    await expect(ops.move("MTK-2", "cancelled", await staff("kemi"))).rejects.toBeInstanceOf(OpsError);
  });

  it("only lets the assigned rider close a delivery", async () => {
    const { store, ops, owner, staff } = await setup();
    await store.createOrder(order("MTK-3"));
    for (const s of ["accepted", "cooking", "ready"] as const) await ops.move("MTK-3", s, owner);
    await ops.move("MTK-3", "out_for_delivery", owner, { riderId: "musa" });
    await expect(ops.move("MTK-3", "delivered", await staff("chidi"))).rejects.toMatchObject({ code: "forbidden" });
    expect((await ops.move("MTK-3", "delivered", await staff("musa"))).ops.stage).toBe("delivered");
  });

  it("sends pickup orders to picked_up, never out for delivery", async () => {
    const { store, ops, owner } = await setup();
    await store.createOrder(order("MTK-4", { deliveryZone: "Pickup", deliveryAddress: "Pickup", deliveryFeeNgn: 0, totalNgn: 50000 }));
    for (const s of ["accepted", "cooking", "ready"] as const) await ops.move("MTK-4", s, owner);
    const item = await ops.detail("MTK-4", owner);
    expect(item.nextStages).toContain("picked_up");
    expect(item.nextStages).not.toContain("out_for_delivery");
  });

  it("keeps unpaid orders out of the kitchen", async () => {
    const { store, ops, owner } = await setup();
    await store.createOrder(order("MTK-5", { status: "pending_payment", paidAt: undefined }));
    expect(await ops.queue(owner)).toHaveLength(0);
    await expect(ops.move("MTK-5", "accepted", owner)).rejects.toMatchObject({ code: "not_paid" });
  });

  it("orders the queue by the day the customer needs it", async () => {
    const { store, ops, owner } = await setup();
    await store.createOrder(order("MTK-LATE", { neededBy: "2026-11-09" }));
    await store.createOrder(order("MTK-SOON", { neededBy: "2026-11-06" }));
    await store.createOrder(order("MTK-NODATE"));
    expect((await ops.queue(owner)).map((i) => i.order.reference)).toEqual(["MTK-SOON", "MTK-LATE", "MTK-NODATE"]);
  });

  it("still moves the order when the notification fails", async () => {
    const store = new MemoryStore();
    const ops = new Operations(store, new MemoryOpsStore(), { now: () => NOW, onStageChange: () => { throw new Error("down"); } });
    await store.createOrder(order("MTK-6"));
    expect((await ops.move("MTK-6", "accepted", { kind: "owner" })).ops.stage).toBe("accepted");
  });
});

describe("customer status", () => {
  it("shares the rider only once the order is out", async () => {
    const { store, ops, owner } = await setup();
    await store.createOrder(order("MTK-7"));
    expect((await ops.customerStatus("mtk-7")).rider).toBeUndefined();
    for (const s of ["accepted", "cooking", "ready"] as const) await ops.move("MTK-7", s, owner);
    await ops.move("MTK-7", "out_for_delivery", owner, { riderId: "musa" });
    const s = await ops.customerStatus("MTK-7");
    expect(s).toMatchObject({ ok: true, stage: "out_for_delivery", rider: { name: "Musa", phone: "+2348030000005" } });
  });

  it("sends unpaid orders back to verify_payment", async () => {
    const { store, ops } = await setup();
    await store.createOrder(order("MTK-8", { status: "pending_payment" }));
    const s = await ops.customerStatus("MTK-8");
    expect(s.next_step).toContain("verify_payment");
    expect(s.stage).toBeUndefined();
  });
});

describe("helpers", () => {
  it("uses Lagos dates", () => {
    expect(lagosDate(new Date("2026-11-05T23:30:00Z"))).toBe("2026-11-06");
  });
  it("words pickup and delivery updates differently", () => {
    expect(customerMessage(order("R", { deliveryZone: "Pickup" }), "ready")).toContain("ready for pickup");
    expect(customerMessage(order("R"), "ready")).toContain("waiting for a rider");
  });
});

describe("default rota", () => {
  it("fills days the owner hasn't set, and respects a day set to nobody", async () => {
    const opsStore = new MemoryOpsStore();
    const ops = new Operations(new MemoryStore(), opsStore, { now: () => NOW });
    expect((await ops.onDuty("2026-11-10", "rider")).map((s) => s.id).sort()).toEqual(["chidi", "musa"]);
    await opsStore.setRota("2026-11-10", "rider", []);
    expect(await ops.onDuty("2026-11-10", "rider")).toEqual([]);
    expect((await ops.onDuty("2026-11-11", "rider")).length).toBe(2);
  });
});
