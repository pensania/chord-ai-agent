import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Order } from "../src/domain.js";
import { Operations, type Actor } from "../src/ops/operations.js";
import { LeadautLink } from "../src/revenue/connection.js";
import { RevenueOutbox } from "../src/revenue/outbox.js";
import { Kitchen } from "../src/stock/kitchen.js";
import { PostgresDb, PostgresOpsStore, PostgresOutboxJournal, PostgresSettings, PostgresStockStore, PostgresStore } from "../src/store/postgres.js";

/**
 * Runs against a real Postgres when TEST_DATABASE_URL is set (CI starts one). Each run gets its
 * own schema, dropped at the end, so it never touches other data in that database.
 */
const URL_ = process.env.TEST_DATABASE_URL;
const schema = `mtk_test_${process.pid}_${Date.now()}`;
const pools: pg.Pool[] = [];

async function fresh() {
  const admin = new pg.Pool({ connectionString: URL_ });
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: URL_, options: `-c search_path=${schema}` });
  pools.push(pool);
  const db = new PostgresDb(pool);
  await db.migrate();
  return db;
}

const order = (ref: string, patch: Partial<Order> = {}): Order => ({
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
  status: "pending_payment",
  ...patch,
});

describe.skipIf(!URL_)("postgres store", () => {
  let db: PostgresDb;
  beforeEach(async () => {
    db = await fresh();
  });
  afterAll(async () => {
    for (const p of pools) await p.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: URL_ });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("seeds empty tables once, and a second start keeps the owner's edits", async () => {
    const store = new PostgresStore(db);
    const ops = new PostgresOpsStore(db);
    expect((await store.listMenu()).map((m) => m.sku)[0]).toBe("JOL-SMALL");
    expect((await store.listZones()).length).toBeGreaterThan(3);
    const kemi = (await ops.getStaff("kemi"))!;
    await ops.saveStaff({ ...kemi, phone: "+2348099999999" });
    await db.migrate();
    expect((await ops.getStaff("kemi"))!.phone).toBe("+2348099999999");
    expect((await ops.listStaff())[0].id).toBe("tola"); // seed order kept
  });

  it("stores, updates and finds orders", async () => {
    const store = new PostgresStore(db);
    await store.createOrder(order("A", { createdAt: "2026-11-05T08:00:00Z" }));
    await store.createOrder(order("B", { createdAt: "2026-11-05T09:00:00Z" }));
    expect((await store.findOpenOrderByPhone("+2348031234567"))!.reference).toBe("B");
    const paid = await store.updateOrder("B", { status: "paid", paidAt: "2026-11-05T09:05:00Z" });
    expect(paid).toMatchObject({ reference: "B", status: "paid", totalNgn: 53000 });
    expect((await store.findOpenOrderByPhone("+2348031234567"))!.reference).toBe("A");
    expect(await store.updateOrder("nope", { status: "paid" })).toBeUndefined();
    expect((await store.listOrders()).map((o) => o.reference)).toEqual(["A", "B"]);
  });

  it("never sells the last tray twice when two payments land together", async () => {
    const store = new PostgresStore(db);
    const before = (await store.listMenu()).find((m) => m.sku === "JOL-LARGE")!.stock; // 3 in the seed
    const results = await Promise.all(Array.from({ length: before + 2 }, () => store.consumeStock([{ sku: "JOL-LARGE", qty: 1 }])));
    expect(results.filter((short) => short.length === 0)).toHaveLength(before);
    expect((await store.listMenu()).find((m) => m.sku === "JOL-LARGE")!.stock).toBe(0);
  });

  it("keeps the rota: the default applies until the owner sets a day, even to nobody", async () => {
    const ops = new PostgresOpsStore(db, { rider: ["musa"] });
    expect(await ops.listRota("2026-11-05", "2026-11-05")).toEqual([{ date: "2026-11-05", role: "rider", staffId: "musa" }]);
    await ops.setRota("2026-11-05", "rider", []);
    await ops.setRota("2026-11-06", "rider", ["chidi", "chidi"]);
    expect(await ops.listRota("2026-11-05", "2026-11-06")).toEqual([{ date: "2026-11-06", role: "rider", staffId: "chidi" }]);
  });

  it("runs the kitchen flow end to end: stage changes, stock used, expenses, pay", async () => {
    const store = new PostgresStore(db);
    const opsStore = new PostgresOpsStore(db);
    const stock = new PostgresStockStore(db);
    const now = () => new Date("2026-11-05T09:00:00Z");
    const kitchen = new Kitchen(stock, opsStore, { now, menu: () => store.listMenu() });
    const ops = new Operations(store, opsStore, { now, stock: kitchen });
    await store.createOrder(order("MTK-1", { status: "paid", paidAt: "2026-11-05T08:05:00Z" }));
    const owner: Actor = { kind: "owner" };
    await ops.move("MTK-1", "accepted", owner);
    await ops.move("MTK-1", "cooking", owner);
    const rice = (await stock.listIngredients()).find((i) => i.id === "rice")!;
    const used = (await stock.listMoves()).filter((m) => m.ref === "MTK-1");
    expect(used.length).toBeGreaterThan(0);
    expect((await opsStore.getOrderOps("MTK-1"))!.history.map((h) => h.to)).toEqual(["accepted", "cooking"]);

    // A fresh set of stores (as after a restart) sees the same data.
    const again = new PostgresStockStore(db);
    expect((await again.getIngredient("rice"))!.onHand).toBe(rice.onHand);

    await stock.addExpense({ id: "e1", date: "2026-11-05", category: "gas", description: "Gas refill", amountNgn: 18000, by: "owner" });
    expect(await stock.listExpenses("2026-11-01", "2026-11-30")).toHaveLength(1);
    await stock.setRecipe("PUFF-50", [{ ingredientId: "flour", qty: 1.5 }]);
    expect((await stock.recipes())["PUFF-50"]).toEqual([{ ingredientId: "flour", qty: 1.5 }]);
    await stock.setPayRate({ staffId: "musa", remove: true });
    expect((await stock.listPayRates()).some((r) => r.staffId === "musa")).toBe(false);
  });

  it("remembers the Leadaut connection, and a disconnect, across restarts", async () => {
    const settings = new PostgresSettings(db);
    const env = { url: "https://render.example/hook", secret: "lds_wc_from_render_0000" };
    const boot = async () => {
      const link = new LeadautLink({ settings, outbox: new RevenueOutbox() });
      await link.restore(env);
      return link;
    };
    expect((await boot()).view()).toMatchObject({ connected: true, source: "render", persistent: true });

    await (await boot()).save("https://portal.example/hook", "lds_wc_from_portal_1111");
    expect((await boot()).view()).toMatchObject({ connected: true, source: "portal", url: "https://portal.example/hook", secretEnd: "1111" });

    await (await boot()).turnOff();
    expect((await boot()).connected).toBe(false);
  });

  it("keeps orders waiting for Leadaut through a restart, in order, and doesn't resend delivered ones", async () => {
    const journal = new PostgresOutboxJournal(db);
    let up = false;
    const sent: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      if (!up) return new Response("down", { status: 503 });
      sent.push((init.headers as Record<string, string>)["X-WC-Webhook-Delivery-ID"]);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const target = { url: "https://leadaut.test/hook", secret: "lds_wc_0123456789abcdef" };
    const ev = (id: string, key: string) => ({ event_id: id, topic: "order.created" as const, key, occurred_at: "x", body: { id: key } });

    const before = new RevenueOutbox({ ...target, fetchImpl, journal });
    before.enqueue(ev("A:processing", "A"));
    before.enqueue(ev("A:refunded", "A"));
    await before.flush();
    await before.saved();
    expect(before.status().pending).toBe(2);

    // Restart while Leadaut is still down, then it comes back.
    up = true;
    const after = new RevenueOutbox({ ...target, fetchImpl, journal });
    expect(await after.load()).toBe(2);
    await after.flush();
    await after.saved();
    expect(sent).toEqual(["A:processing", "A:refunded"]);

    const third = new RevenueOutbox({ ...target, fetchImpl, journal });
    expect(await third.load()).toBe(0);
    expect(third.enqueue(ev("A:processing", "A"))).toBe(false);
  });
});
