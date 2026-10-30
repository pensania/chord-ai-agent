import { describe, expect, it } from "vitest";
import type { Order } from "../src/domain.js";
import { MemoryOpsStore } from "../src/ops/memory.js";
import { Operations } from "../src/ops/operations.js";
import { Kitchen, monthRange } from "../src/stock/kitchen.js";
import { MemoryStockStore } from "../src/stock/memory.js";
import { MemoryStore } from "../src/store/memory.js";

const NOW = new Date("2026-11-05T09:00:00Z");

function order(ref: string, lines: Order["lines"]): Order {
  return {
    reference: ref,
    createdAt: "2026-11-05T08:00:00Z",
    customerName: "Ada Obi",
    customerPhone: "+2348031234567",
    lines,
    deliveryZone: "Yaba",
    deliveryAddress: "12 Herbert Macaulay Way",
    subtotalNgn: 50000,
    deliveryFeeNgn: 3000,
    totalNgn: 53000,
    status: "paid",
    paidAt: "2026-11-05T08:05:00Z",
  };
}

const jollof = (qty: number) => ({ sku: "JOL-SMALL", name: "Party jollof tray (small, serves 10)", qty, unitPriceNgn: 25000, lineTotalNgn: 25000 * qty });

function setup() {
  const store = new MemoryStore();
  const opsStore = new MemoryOpsStore();
  const stock = new MemoryStockStore();
  const kitchen = new Kitchen(stock, opsStore, { now: () => NOW, menu: () => store.listMenu() });
  const ops = new Operations(store, opsStore, { now: () => NOW, stock: kitchen });
  return { store, opsStore, stock, kitchen, ops };
}

const onHand = async (k: Kitchen, id: string) => (await k.ingredients()).find((i) => i.id === id)!.onHand;

describe("ingredients", () => {
  it("takes an order's ingredients out of stock when cooking starts, once", async () => {
    const { store, kitchen, ops } = setup();
    await store.createOrder(order("MTK-1", [jollof(2)]));
    const owner = { kind: "owner" } as const;
    await ops.move("MTK-1", "accepted", owner);
    expect(await onHand(kitchen, "rice")).toBe(40);
    await ops.move("MTK-1", "cooking", owner);
    expect(await onHand(kitchen, "rice")).toBe(36); // 2 trays × 2 kg
    expect(await onHand(kitchen, "tray")).toBe(28);
    // A repeat call for the same order changes nothing.
    await kitchen.consumeForOrder((await store.getOrder("MTK-1"))!, "owner");
    expect(await onHand(kitchen, "rice")).toBe(36);
    const used = await kitchen.ingredientsUsed("2026-11");
    expect(used.orders).toBe(1);
    expect(used.costNgn).toBeGreaterThan(0);
  });

  it("reports what just ran low, and lets stock go negative rather than block cooking", async () => {
    const { kitchen } = setup();
    await kitchen.count("pepper", 2.4, "owner");
    const { nowLow } = await kitchen.consumeForOrder(order("MTK-2", [jollof(1)]), "kemi");
    expect(nowLow.map((i) => i.id)).toContain("pepper");
    await kitchen.consumeForOrder(order("MTK-3", [jollof(10)]), "kemi");
    expect(await onHand(kitchen, "pepper")).toBeLessThan(0);
    expect((await kitchen.lowStock()).map((i) => i.id)).toContain("pepper");
  });

  it("records a physical count as an adjustment", async () => {
    const { kitchen } = setup();
    await kitchen.count("oil", 20, "kemi", "spilled a bottle");
    expect(await onHand(kitchen, "oil")).toBe(20);
    const [m] = await kitchen.moves(1);
    expect(m).toMatchObject({ reason: "adjust", delta: -5, by: "kemi", note: "spilled a bottle" });
    await expect(kitchen.count("oil", -1, "kemi")).rejects.toMatchObject({ code: "bad_input" });
  });

  it("costs each menu item from its recipe", async () => {
    const { kitchen } = setup();
    const costs = await kitchen.unitCosts();
    // 2×1800 + 1.5×1500 + 0.5×2000 + 0.5×1200 + 0.5×2800 + 6×60 + 900
    expect(costs["JOL-SMALL"]).toBe(10110);
  });
});

describe("expenses", () => {
  it("restocks ingredients from a purchase and updates their price", async () => {
    const { kitchen } = setup();
    const e = await kitchen.addExpense({ category: "ingredients", description: "", purchases: [{ ingredientId: "rice", qty: 50, costNgn: 95000 }, { ingredientId: "oil", qty: 10, costNgn: 30000 }] }, "owner");
    expect(e).toMatchObject({ amountNgn: 125000, description: "Ingredient purchase", date: "2026-11-05" });
    expect(await onHand(kitchen, "rice")).toBe(90);
    expect((await kitchen.ingredients()).find((i) => i.id === "rice")!.costPerUnitNgn).toBe(1900);
    const month = await kitchen.expenses("2026-11");
    expect(month.total).toBe(125000);
    expect(month.byCategory.ingredients).toBe(125000);
  });

  it("logs plain spending and rejects bad input", async () => {
    const { kitchen } = setup();
    await kitchen.addExpense({ category: "gas", description: "12.5 kg gas refill", amountNgn: 18000, date: "2026-11-02" }, "owner");
    expect((await kitchen.expenses("2026-11")).byCategory.gas).toBe(18000);
    await expect(kitchen.addExpense({ category: "gas", description: "x", amountNgn: 0 }, "owner")).rejects.toMatchObject({ code: "bad_input" });
    await expect(kitchen.addExpense({ category: "party", description: "x", amountNgn: 10 }, "owner")).rejects.toMatchObject({ code: "bad_input" });
    await expect(kitchen.addExpense({ category: "gas", description: "x", amountNgn: 10, date: "2026-12-01" }, "owner")).rejects.toMatchObject({ code: "bad_input" });
  });
});

describe("pay", () => {
  it("pays per shift from the rota and monthly as a fixed amount", async () => {
    const { kitchen, opsStore } = setup();
    // Default rota puts Kemi on kitchen every day: 30 days in November.
    const nov = await kitchen.payroll("2026-11");
    const kemi = nov.lines.find((l) => l.staff.id === "kemi")!;
    expect(kemi.shifts).toBe(30);
    expect(kemi.amountNgn).toBe(30 * 7000);
    // Ifeoma is on two roles a day by default, but a day counts once.
    expect(nov.lines.find((l) => l.staff.id === "ifeoma")!.shifts).toBe(30);
    // Take Kemi off one day, put Tola on a monthly salary.
    await opsStore.setRota("2026-11-10", "kitchen", ["segun"]);
    await opsStore.setRota("2026-11-10", "intake", ["ifeoma"]);
    await kitchen.setPayRate("tola", "monthly", 250000);
    const after = await kitchen.payroll("2026-11");
    expect(after.lines.find((l) => l.staff.id === "kemi")!.shifts).toBe(29);
    expect(after.lines.find((l) => l.staff.id === "tola")!.amountNgn).toBe(250000);
    expect(after.total).toBe(after.lines.reduce((n, l) => n + l.amountNgn, 0));
  });

  it("knows month boundaries", () => {
    expect(monthRange("2026-02")).toEqual(["2026-02-01", "2026-02-28"]);
    expect(monthRange("2028-02")).toEqual(["2028-02-01", "2028-02-29"]);
  });
});
