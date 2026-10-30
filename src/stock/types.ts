/** Ingredients, recipes, spending and pay. Kept apart from checkout and order stages so each can change alone. */

export type Ingredient = {
  id: string;
  name: string;
  unit: string;
  /** Can go below zero: the kitchen cooks anyway, and a negative number shows the count is off. */
  onHand: number;
  /** Warn when onHand is at or below this. */
  lowAt: number;
  /** Latest purchase price per unit, used to cost what each order consumed. */
  costPerUnitNgn: number;
};

/** How much of one ingredient one unit of a menu item uses. */
export type RecipeLine = { ingredientId: string; qty: number };

export type StockMove = {
  at: string;
  ingredientId: string;
  /** Negative = used, positive = bought or counted up. */
  delta: number;
  reason: "order" | "purchase" | "adjust";
  /** Order reference or expense id. */
  ref?: string;
  by: string;
  /** Value of the move at the cost per unit at the time. */
  costNgn: number;
  note?: string;
};

export const EXPENSE_CATEGORIES = ["ingredients", "gas", "packaging", "transport", "rent", "utilities", "equipment", "other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export type PurchaseLine = { ingredientId: string; qty: number; costNgn: number };

export type Expense = {
  id: string;
  /** Lagos date the money was spent, YYYY-MM-DD. */
  date: string;
  category: ExpenseCategory;
  description: string;
  amountNgn: number;
  by: string;
  /** Ingredients this spend restocked, if any. */
  purchases?: PurchaseLine[];
};

export type PayRate = { staffId: string; basis: "per_shift" | "monthly"; amountNgn: number };

export interface StockStore {
  listIngredients(): Promise<Ingredient[]>;
  getIngredient(id: string): Promise<Ingredient | undefined>;
  saveIngredient(i: Ingredient): Promise<void>;
  recipes(): Promise<Record<string, RecipeLine[]>>;
  setRecipe(sku: string, lines: RecipeLine[]): Promise<void>;
  addMoves(moves: StockMove[]): Promise<void>;
  listMoves(): Promise<StockMove[]>;
  addExpense(e: Expense): Promise<void>;
  listExpenses(fromDate: string, toDate: string): Promise<Expense[]>;
  listPayRates(): Promise<PayRate[]>;
  setPayRate(rate: PayRate | { staffId: string; remove: true }): Promise<void>;
}
