import type { MenuItem, Order } from "../domain.js";
import { lagosDate } from "../ops/operations.js";
import type { OpsStore, Staff } from "../ops/types.js";
import { EXPENSE_CATEGORIES, type Expense, type ExpenseCategory, type Ingredient, type PayRate, type PurchaseLine, type StockMove, type StockStore } from "./types.js";

export class StockError extends Error {
  constructor(message: string, readonly code: "not_found" | "bad_input") {
    super(message);
  }
}

/** Round to 3 decimals so 0.1 + 0.2 kg doesn't show as 0.30000000000000004. */
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export type PayLine = { staff: Staff; rate?: PayRate; shifts: number; amountNgn: number };

/** First and last Lagos date of a "YYYY-MM" month. */
export function monthRange(month: string): [string, string] {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${month}-01`, `${month}-${String(last).padStart(2, "0")}`];
}

/** Ingredients, purchases, spending and pay. */
export class Kitchen {
  constructor(
    private stock: StockStore,
    private ops: OpsStore,
    private opts: { now?: () => Date; menu?: () => Promise<MenuItem[]> } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  async menu(): Promise<MenuItem[]> {
    return (await this.opts.menu?.()) ?? [];
  }

  today() {
    return lagosDate(this.now());
  }

  async ingredients() {
    return (await this.stock.listIngredients()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async lowStock(): Promise<Ingredient[]> {
    return (await this.ingredients()).filter((i) => i.onHand <= i.lowAt);
  }

  recipes() {
    return this.stock.recipes();
  }

  /** Ingredient cost of one unit of each menu item, from current prices. */
  async unitCosts(): Promise<Record<string, number>> {
    const [recipes, ings] = await Promise.all([this.stock.recipes(), this.stock.listIngredients()]);
    const price = new Map(ings.map((i) => [i.id, i.costPerUnitNgn]));
    return Object.fromEntries(Object.entries(recipes).map(([sku, lines]) => [sku, Math.round(lines.reduce((n, l) => n + l.qty * (price.get(l.ingredientId) ?? 0), 0))]));
  }

  /**
   * Take an order's ingredients out of stock. Called when cooking starts.
   * Runs once per order: a second call (say the order went back and forth) changes nothing.
   */
  async consumeForOrder(order: Order, by: string): Promise<{ moves: StockMove[]; nowLow: Ingredient[] }> {
    const done = (await this.stock.listMoves()).some((m) => m.reason === "order" && m.ref === order.reference);
    if (done) return { moves: [], nowLow: [] };
    const recipes = await this.stock.recipes();
    const need = new Map<string, number>();
    for (const line of order.lines) {
      for (const r of recipes[line.sku] ?? []) need.set(r.ingredientId, (need.get(r.ingredientId) ?? 0) + r.qty * line.qty);
    }
    const at = this.now().toISOString();
    const moves: StockMove[] = [];
    const nowLow: Ingredient[] = [];
    for (const [id, qty] of need) {
      const ing = await this.stock.getIngredient(id);
      if (!ing) continue; // a recipe pointing at a removed ingredient shouldn't stop the kitchen
      const wasLow = ing.onHand <= ing.lowAt;
      ing.onHand = r3(ing.onHand - qty);
      await this.stock.saveIngredient(ing);
      moves.push({ at, ingredientId: id, delta: -r3(qty), reason: "order", ref: order.reference, by, costNgn: Math.round(qty * ing.costPerUnitNgn) });
      if (!wasLow && ing.onHand <= ing.lowAt) nowLow.push(ing);
    }
    await this.stock.addMoves(moves);
    return { moves, nowLow };
  }

  /** Set an ingredient to what was physically counted. */
  async count(ingredientId: string, counted: number, by: string, note?: string) {
    if (!Number.isFinite(counted) || counted < 0) throw new StockError("Enter the amount you counted, 0 or more", "bad_input");
    const ing = await this.stock.getIngredient(ingredientId);
    if (!ing) throw new StockError("No such ingredient", "not_found");
    const delta = r3(counted - ing.onHand);
    if (delta === 0) return ing;
    ing.onHand = r3(counted);
    await this.stock.saveIngredient(ing);
    await this.stock.addMoves([{ at: this.now().toISOString(), ingredientId: ing.id, delta, reason: "adjust", by, costNgn: Math.round(delta * ing.costPerUnitNgn), note: note?.trim() || undefined }]);
    return ing;
  }

  async saveIngredient(input: { id?: string; name: string; unit: string; lowAt: number; costPerUnitNgn: number }) {
    const name = input.name.trim();
    const unit = input.unit.trim();
    if (!name || !unit) throw new StockError("Name and unit are needed", "bad_input");
    if (!(input.lowAt >= 0) || !(input.costPerUnitNgn >= 0)) throw new StockError("Low-stock level and cost must be 0 or more", "bad_input");
    const existing = input.id ? await this.stock.getIngredient(input.id) : undefined;
    if (input.id && !existing) throw new StockError("No such ingredient", "not_found");
    const id = existing?.id ?? (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `ing-${Date.now()}`);
    if (!existing && (await this.stock.getIngredient(id))) throw new StockError("An ingredient with that name already exists", "bad_input");
    const ing: Ingredient = { id, name, unit, onHand: existing?.onHand ?? 0, lowAt: r3(input.lowAt), costPerUnitNgn: Math.round(input.costPerUnitNgn) };
    await this.stock.saveIngredient(ing);
    return ing;
  }

  async setRecipe(sku: string, lines: { ingredientId: string; qty: number }[]) {
    const ings = new Set((await this.stock.listIngredients()).map((i) => i.id));
    const clean = lines.filter((l) => l.qty > 0 && ings.has(l.ingredientId)).map((l) => ({ ingredientId: l.ingredientId, qty: r3(l.qty) }));
    await this.stock.setRecipe(sku, clean);
  }

  /** Log money spent. Ingredient purchases also restock and update the price per unit. */
  async addExpense(input: { date?: string; category: string; description: string; amountNgn?: number; purchases?: PurchaseLine[] }, by: string): Promise<Expense> {
    const category = input.category as ExpenseCategory;
    if (!EXPENSE_CATEGORIES.includes(category)) throw new StockError("Pick a category", "bad_input");
    const date = input.date?.trim() || this.today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new StockError("Date must look like 2026-11-05", "bad_input");
    if (date > this.today()) throw new StockError("That date is in the future", "bad_input");
    const purchases = (input.purchases ?? []).filter((p) => p.ingredientId && p.qty > 0);
    for (const p of purchases) {
      if (!(p.costNgn >= 0)) throw new StockError("Each purchase needs what it cost", "bad_input");
      if (!(await this.stock.getIngredient(p.ingredientId))) throw new StockError("No such ingredient", "not_found");
    }
    const amountNgn = purchases.length ? purchases.reduce((n, p) => n + Math.round(p.costNgn), 0) : Math.round(input.amountNgn ?? NaN);
    if (!(amountNgn > 0)) throw new StockError("Enter how much was spent", "bad_input");
    const description = input.description.trim() || (purchases.length ? "Ingredient purchase" : "");
    if (!description) throw new StockError("Say what the money was for", "bad_input");

    const expense: Expense = { id: `EXP-${date.replace(/-/g, "").slice(2)}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`, date, category, description, amountNgn, by, purchases: purchases.length ? purchases : undefined };
    const at = this.now().toISOString();
    const moves: StockMove[] = [];
    for (const p of purchases) {
      const ing = (await this.stock.getIngredient(p.ingredientId))!;
      ing.onHand = r3(ing.onHand + p.qty);
      ing.costPerUnitNgn = Math.round(p.costNgn / p.qty); // latest price wins
      await this.stock.saveIngredient(ing);
      moves.push({ at, ingredientId: ing.id, delta: r3(p.qty), reason: "purchase", ref: expense.id, by, costNgn: Math.round(p.costNgn) });
    }
    await this.stock.addMoves(moves);
    await this.stock.addExpense(expense);
    return expense;
  }

  async expenses(month: string) {
    const [from, to] = monthRange(month);
    const list = (await this.stock.listExpenses(from, to)).sort((a, b) => b.date.localeCompare(a.date));
    const byCategory = Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c, 0])) as Record<ExpenseCategory, number>;
    for (const e of list) byCategory[e.category] += e.amountNgn;
    return { list, total: list.reduce((n, e) => n + e.amountNgn, 0), byCategory };
  }

  /** Value of ingredients used by orders in a month, at the price when they were used. */
  async ingredientsUsed(month: string) {
    const [from, to] = monthRange(month);
    const moves = (await this.stock.listMoves()).filter((m) => m.reason === "order" && lagosDate(new Date(m.at)) >= from && lagosDate(new Date(m.at)) <= to);
    return { costNgn: moves.reduce((n, m) => n + m.costNgn, 0), orders: new Set(moves.map((m) => m.ref)).size };
  }

  async moves(limit = 50) {
    return (await this.stock.listMoves()).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }

  async setPayRate(staffId: string, basis: string, amountNgn: number) {
    if (!(await this.ops.getStaff(staffId))) throw new StockError("No such staff member", "not_found");
    if (basis === "none") return this.stock.setPayRate({ staffId, remove: true });
    if (basis !== "per_shift" && basis !== "monthly") throw new StockError("Pick per shift or monthly", "bad_input");
    if (!(amountNgn > 0)) throw new StockError("Enter the amount", "bad_input");
    await this.stock.setPayRate({ staffId, basis, amountNgn: Math.round(amountNgn) });
  }

  /**
   * What each person is owed for a month. Per-shift pay counts the days they were on the rota
   * (any role, once per day). Monthly pay is the fixed amount.
   */
  async payroll(month: string): Promise<{ lines: PayLine[]; total: number }> {
    const [from, to] = monthRange(month);
    const [staff, rates, rota] = await Promise.all([this.ops.listStaff(), this.stock.listPayRates(), this.ops.listRota(from, to)]);
    const rateOf = new Map(rates.map((r) => [r.staffId, r]));
    const lines = staff.map((s) => {
      const shifts = new Set(rota.filter((r) => r.staffId === s.id).map((r) => r.date)).size;
      const rate = rateOf.get(s.id);
      const amountNgn = !rate ? 0 : rate.basis === "monthly" ? rate.amountNgn : rate.amountNgn * shifts;
      return { staff: s, rate, shifts, amountNgn };
    });
    return { lines, total: lines.reduce((n, l) => n + l.amountNgn, 0) };
  }
}
