import seed from "../../data/kitchen.json" with { type: "json" };
import type { Expense, Ingredient, PayRate, RecipeLine, StockMove, StockStore } from "./types.js";

type Seed = { ingredients: Ingredient[]; recipes: Record<string, [string, number][]>; payRates: PayRate[] };

export class MemoryStockStore implements StockStore {
  private ingredients = new Map<string, Ingredient>();
  private recipeBook = new Map<string, RecipeLine[]>();
  private moves: StockMove[] = [];
  private expenses: Expense[] = [];
  private rates = new Map<string, PayRate>();

  constructor(data: Seed = seed as unknown as Seed) {
    for (const i of data.ingredients) this.ingredients.set(i.id, structuredClone(i));
    for (const [sku, lines] of Object.entries(data.recipes)) this.recipeBook.set(sku, lines.map(([ingredientId, qty]) => ({ ingredientId, qty })));
    for (const r of data.payRates) this.rates.set(r.staffId, structuredClone(r));
  }

  async listIngredients() {
    return structuredClone([...this.ingredients.values()]);
  }
  async getIngredient(id: string) {
    const i = this.ingredients.get(id);
    return i && structuredClone(i);
  }
  async saveIngredient(i: Ingredient) {
    this.ingredients.set(i.id, structuredClone(i));
  }
  async recipes() {
    return structuredClone(Object.fromEntries(this.recipeBook));
  }
  async setRecipe(sku: string, lines: RecipeLine[]) {
    this.recipeBook.set(sku, structuredClone(lines));
  }
  async addMoves(moves: StockMove[]) {
    this.moves.push(...structuredClone(moves));
  }
  async listMoves() {
    return structuredClone(this.moves);
  }
  async addExpense(e: Expense) {
    this.expenses.push(structuredClone(e));
  }
  async listExpenses(fromDate: string, toDate: string) {
    return structuredClone(this.expenses.filter((e) => e.date >= fromDate && e.date <= toDate));
  }
  async listPayRates() {
    return structuredClone([...this.rates.values()]);
  }
  async setPayRate(rate: PayRate | { staffId: string; remove: true }) {
    if ("remove" in rate) this.rates.delete(rate.staffId);
    else this.rates.set(rate.staffId, structuredClone(rate));
  }
}
