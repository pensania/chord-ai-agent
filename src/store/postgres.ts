import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import seed from "../../data/seed.json" with { type: "json" };
import staffSeed from "../../data/staff.json" with { type: "json" };
import kitchenSeed from "../../data/kitchen.json" with { type: "json" };
import { OPEN_STATUSES, replaceable, shortFor, soldOn, type DayPlan, type DeliveryZone, type MenuItem, type Order } from "../domain.js";
import type { OpsStore, OrderOps, RotaEntry, Role, Staff } from "../ops/types.js";
import type { Expense, Ingredient, PayRate, RecipeLine, StockMove, StockStore } from "../stock/types.js";
import type { OutboxEntry, OutboxJournal } from "../revenue/outbox.js";
import type { EventEntry, EventJournal } from "../payment-events.js";
import type { Store } from "./types.js";

/**
 * Postgres storage for everything the app keeps: orders, menu stock, staff, rota, order stages,
 * ingredients, recipes, expenses, pay rates and settings.
 *
 * Each record is stored whole as JSONB, next to the few columns we filter or sort on. The app's
 * types stay the source of truth, so adding a field to an order needs no migration.
 */

type Queryable = Pick<pg.Pool, "query"> | pg.PoolClient;

/** Tables are created on start and never dropped. Every statement is safe to run again. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS menu_items (sku text PRIMARY KEY, position int NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS delivery_zones (zone text PRIMARY KEY, position int NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS orders (
  reference text PRIMARY KEY,
  customer_phone text NOT NULL,
  status text NOT NULL,
  created_at text NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_phone_status ON orders (customer_phone, status);
CREATE INDEX IF NOT EXISTS orders_needed_by ON orders ((data->>'neededBy'));
-- How many of an item can be made for one day, where that isn't the usual number.
CREATE TABLE IF NOT EXISTS day_capacity (date text NOT NULL, sku text NOT NULL, capacity int NOT NULL, PRIMARY KEY (date, sku));
CREATE TABLE IF NOT EXISTS staff (id text PRIMARY KEY, seq bigserial, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS rota (date text NOT NULL, role text NOT NULL, staff_id text NOT NULL, PRIMARY KEY (date, role, staff_id));
-- A day and role the owner has set, even to nobody. Others fall back to the default rota.
CREATE TABLE IF NOT EXISTS rota_set (date text NOT NULL, role text NOT NULL, PRIMARY KEY (date, role));
CREATE TABLE IF NOT EXISTS order_ops (reference text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS ingredients (id text PRIMARY KEY, seq bigserial, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS recipes (sku text PRIMARY KEY, lines jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS stock_moves (id bigserial PRIMARY KEY, at text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS expenses (id text PRIMARY KEY, date text NOT NULL, data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS expenses_date ON expenses (date);
CREATE TABLE IF NOT EXISTS pay_rates (staff_id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS revenue_outbox (event_id text PRIMARY KEY, seq bigserial, state text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS payment_events (id text PRIMARY KEY, seq bigserial, state text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
`;

export type PostgresSeed = {
  menu: MenuItem[];
  deliveryZones: DeliveryZone[];
  staff: Staff[];
  defaultRota: Partial<Record<Role, string[]>>;
  ingredients: Ingredient[];
  recipes: Record<string, [string, number][]>;
  payRates: PayRate[];
};

export const DEFAULT_SEED: PostgresSeed = {
  menu: seed.menu,
  deliveryZones: seed.deliveryZones,
  staff: (staffSeed as { staff: Staff[] }).staff,
  defaultRota: (staffSeed as { defaultRota?: Partial<Record<Role, string[]>> }).defaultRota ?? {},
  ...(kitchenSeed as unknown as Pick<PostgresSeed, "ingredients" | "recipes" | "payRates">),
};

export class PostgresDb {
  readonly pool: pg.Pool;
  private current = new AsyncLocalStorage<pg.PoolClient>();

  constructor(urlOrPool: string | pg.Pool) {
    this.pool = typeof urlOrPool === "string" ? new pg.Pool({ connectionString: urlOrPool, max: 5, connectionTimeoutMillis: 10_000 }) : urlOrPool;
    // An idle connection dropped by the database shouldn't crash the app; the pool reconnects.
    this.pool.on("error", (e) => console.warn(JSON.stringify({ msg: "postgres_idle_error", error: e.message })));
  }

  /**
   * Create the tables, and fill each empty one from the seed files. A table that already has rows
   * is left alone, so the owner's edits are never overwritten by a deploy.
   */
  async migrate(s: PostgresSeed = DEFAULT_SEED) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      // Two instances starting at once would race to seed; this lock makes the second one wait.
      await c.query("SELECT pg_advisory_xact_lock(4242001)");
      await c.query(SCHEMA);
      const empty = async (table: string) => (await c.query(`SELECT 1 FROM ${table} LIMIT 1`)).rowCount === 0;
      if (await empty("menu_items")) for (const [i, m] of s.menu.entries()) await c.query("INSERT INTO menu_items VALUES ($1,$2,$3)", [m.sku, i, m]);
      if (await empty("delivery_zones")) for (const [i, z] of s.deliveryZones.entries()) await c.query("INSERT INTO delivery_zones VALUES ($1,$2,$3)", [z.zone, i, z]);
      if (await empty("staff")) for (const st of s.staff) await c.query("INSERT INTO staff (id, data) VALUES ($1,$2)", [st.id, st]);
      if (await empty("ingredients")) for (const ing of s.ingredients) await c.query("INSERT INTO ingredients (id, data) VALUES ($1,$2)", [ing.id, ing]);
      if (await empty("recipes"))
        for (const [sku, lines] of Object.entries(s.recipes)) await c.query("INSERT INTO recipes VALUES ($1,$2)", [sku, JSON.stringify(lines.map(([ingredientId, qty]) => ({ ingredientId, qty })))]);
      if (await empty("pay_rates")) for (const r of s.payRates) await c.query("INSERT INTO pay_rates VALUES ($1,$2)", [r.staffId, r]);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  /** Where to run a query: the transaction this code is in, if it's in one. */
  get q(): Queryable {
    return this.current.getStore() ?? this.pool;
  }

  /** Run `fn` in one transaction. Inside another, it joins that one, so several stores can change together. */
  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const outer = this.current.getStore();
    if (outer) return fn(outer);
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const out = await this.current.run(c, () => fn(c));
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

const rows = async <T>(q: Queryable, sql: string, params: unknown[] = []) => (await q.query(sql, params)).rows as T[];
const datas = async <T>(q: Queryable, sql: string, params: unknown[] = []) => (await rows<{ data: T }>(q, sql, params)).map((r) => r.data);

/** Orders, menu and delivery zones. */
export class PostgresStore implements Store {
  constructor(private db: PostgresDb) {}

  listMenu() {
    return datas<MenuItem>(this.db.q, "SELECT data FROM menu_items ORDER BY position");
  }
  listZones() {
    return datas<DeliveryZone>(this.db.q, "SELECT data FROM delivery_zones ORDER BY position");
  }
  async createOrder(o: Order) {
    await this.db.q.query("INSERT INTO orders VALUES ($1,$2,$3,$4,$5)", [o.reference, o.customerPhone, o.status, o.createdAt, o]);
  }
  async getOrder(reference: string) {
    return (await datas<Order>(this.db.q, "SELECT data FROM orders WHERE reference = $1", [reference]))[0];
  }
  updateOrder(reference: string, patch: Partial<Order>) {
    return this.transact(reference, async () => patch);
  }

  /** One database transaction: the order row is locked first, then its delivery day. */
  transact(reference: string, fn: (order: Order, short: () => Promise<string[]>) => Promise<Partial<Order> | undefined>) {
    return this.db.tx(async (c) => {
      const [o] = await datas<Order>(c, "SELECT data FROM orders WHERE reference = $1 FOR UPDATE", [reference]);
      if (!o) return undefined;
      const patch = await fn(o, async () => {
        // Two orders for the same day are checked one after the other, so both can't take the last tray.
        if (o.neededBy) await c.query("SELECT pg_advisory_xact_lock(4242003, hashtext($1))", [o.neededBy]);
        return shortFor(o.lines, await this.listMenu(), o.neededBy ? await this.dayPlan(o.neededBy) : { sold: {}, capacity: {} });
      });
      if (!patch) return o;
      return this.saveOrder(c, { ...o, ...patch });
    });
  }

  async dayPlan(date: string): Promise<DayPlan> {
    const paid = await datas<Order>(this.db.q, "SELECT data FROM orders WHERE data->>'neededBy' = $1 AND status = 'paid'", [date]);
    const set = await rows<{ sku: string; capacity: number }>(this.db.q, "SELECT sku, capacity FROM day_capacity WHERE date = $1", [date]);
    return { sold: soldOn(date, paid), capacity: Object.fromEntries(set.map((r) => [r.sku, r.capacity])) };
  }
  async setDayCapacity(date: string, sku: string, capacity: number | undefined) {
    if (capacity === undefined) await this.db.q.query("DELETE FROM day_capacity WHERE date = $1 AND sku = $2", [date, sku]);
    else await this.db.q.query("INSERT INTO day_capacity VALUES ($1,$2,$3) ON CONFLICT (date, sku) DO UPDATE SET capacity = EXCLUDED.capacity", [date, sku, capacity]);
  }

  private async saveOrder(c: Queryable, o: Order) {
    await c.query("UPDATE orders SET customer_phone = $2, status = $3, data = $4 WHERE reference = $1", [o.reference, o.customerPhone, o.status, o]);
    return o;
  }

  openOrdersByPhone(phone: string) {
    return datas<Order>(this.db.q, "SELECT data FROM orders WHERE customer_phone = $1 AND status = ANY($2) ORDER BY created_at DESC", [phone, OPEN_STATUSES]);
  }

  activateOrder(reference: string, paymentUrl: string) {
    return this.db.tx(async (c) => {
      const [found] = await datas<Order>(c, "SELECT data FROM orders WHERE reference = $1", [reference]);
      if (!found) return undefined;
      // One activation per customer at a time, across instances too.
      await c.query("SELECT pg_advisory_xact_lock(4242002, hashtext($1))", [found.customerPhone]);
      const [o] = await datas<Order>(c, "SELECT data FROM orders WHERE reference = $1 FOR UPDATE", [reference]);
      if (o.status !== "pending_payment") return { order: o, replaced: [] as string[] };
      const order = await this.saveOrder(c, { ...o, paymentUrl });
      const others = (await datas<Order>(c, "SELECT data FROM orders WHERE customer_phone = $1 AND status = ANY($2) AND reference <> $3 ORDER BY reference FOR UPDATE", [o.customerPhone, OPEN_STATUSES, reference])).filter(replaceable);
      for (const old of others) await this.saveOrder(c, { ...old, status: "replaced", replacedBy: reference });
      return { order, replaced: others.map((x) => x.reference) };
    });
  }

  listOrders() {
    return datas<Order>(this.db.q, "SELECT data FROM orders ORDER BY created_at");
  }

  async addMenuItem(item: MenuItem) {
    const r = await this.db.q.query("INSERT INTO menu_items SELECT $1::text, COALESCE(MAX(position), -1) + 1, $2::jsonb FROM menu_items ON CONFLICT (sku) DO NOTHING", [item.sku, item]);
    return r.rowCount === 1;
  }
  async updateMenuItem(sku: string, patch: Partial<Omit<MenuItem, "sku">>) {
    return (await datas<MenuItem>(this.db.q, "UPDATE menu_items SET data = data || $2::jsonb WHERE sku = $1 RETURNING data", [sku, JSON.stringify(patch)]))[0];
  }
  async saveZone(z: DeliveryZone) {
    await this.db.q.query(
      "INSERT INTO delivery_zones SELECT $1::text, COALESCE(MAX(position), -1) + 1, $2::jsonb FROM delivery_zones ON CONFLICT (zone) DO UPDATE SET data = EXCLUDED.data",
      [z.zone, z],
    );
  }
  async removeZone(zone: string) {
    return (await this.db.q.query("DELETE FROM delivery_zones WHERE zone = $1", [zone])).rowCount === 1;
  }
}

/** Staff, rota and order stages. */
export class PostgresOpsStore implements OpsStore {
  constructor(
    private db: PostgresDb,
    private defaultRota: Partial<Record<Role, string[]>> = DEFAULT_SEED.defaultRota,
  ) {}

  listStaff() {
    return datas<Staff>(this.db.q, "SELECT data FROM staff ORDER BY seq");
  }
  async getStaff(id: string) {
    return (await datas<Staff>(this.db.q, "SELECT data FROM staff WHERE id = $1", [id]))[0];
  }
  async saveStaff(s: Staff) {
    await this.db.q.query("INSERT INTO staff (id, data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data", [s.id, s]);
  }
  async listRota(fromDate: string, toDate: string) {
    const out = (await rows<{ date: string; role: Role; staff_id: string }>(this.db.q, "SELECT date, role, staff_id FROM rota WHERE date BETWEEN $1 AND $2", [fromDate, toDate])).map(
      (r): RotaEntry => ({ date: r.date, role: r.role, staffId: r.staff_id }),
    );
    const set = new Set((await rows<{ date: string; role: string }>(this.db.q, "SELECT date, role FROM rota_set WHERE date BETWEEN $1 AND $2", [fromDate, toDate])).map((r) => `${r.date}|${r.role}`));
    for (let d = fromDate; d <= toDate; d = nextDay(d)) {
      for (const [role, ids] of Object.entries(this.defaultRota) as [Role, string[]][]) {
        if (!set.has(`${d}|${role}`)) for (const staffId of ids) out.push({ date: d, role, staffId });
      }
    }
    return out;
  }
  async setRota(date: string, role: Role, staffIds: string[]) {
    await this.db.tx(async (c) => {
      await c.query("INSERT INTO rota_set VALUES ($1,$2) ON CONFLICT DO NOTHING", [date, role]);
      await c.query("DELETE FROM rota WHERE date = $1 AND role = $2", [date, role]);
      for (const id of new Set(staffIds)) await c.query("INSERT INTO rota VALUES ($1,$2,$3)", [date, role, id]);
    });
  }
  async getOrderOps(reference: string) {
    return (await datas<OrderOps>(this.db.q, "SELECT data FROM order_ops WHERE reference = $1", [reference]))[0];
  }
  listOrderOps() {
    return datas<OrderOps>(this.db.q, "SELECT data FROM order_ops");
  }
  async saveOrderOps(o: OrderOps) {
    const was = o.version ?? 0;
    // Only when nobody saved it since it was read. A row from before versions counts as 0.
    const r = await this.db.q.query(
      "INSERT INTO order_ops AS cur VALUES ($1,$2) ON CONFLICT (reference) DO UPDATE SET data = EXCLUDED.data WHERE COALESCE((cur.data->>'version')::int, 0) = $3",
      [o.reference, { ...o, version: was + 1 }, was],
    );
    return r.rowCount === 1;
  }
}

/** Ingredients, recipes, stock moves, expenses and pay rates. */
export class PostgresStockStore implements StockStore {
  constructor(private db: PostgresDb) {}

  listIngredients() {
    return datas<Ingredient>(this.db.q, "SELECT data FROM ingredients ORDER BY seq");
  }
  async getIngredient(id: string) {
    return (await datas<Ingredient>(this.db.q, "SELECT data FROM ingredients WHERE id = $1", [id]))[0];
  }
  async saveIngredient(i: Ingredient) {
    await this.db.q.query("INSERT INTO ingredients (id, data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data", [i.id, i]);
  }
  async recipes() {
    const out: Record<string, RecipeLine[]> = {};
    for (const r of await rows<{ sku: string; lines: RecipeLine[] }>(this.db.q, "SELECT sku, lines FROM recipes")) out[r.sku] = r.lines;
    return out;
  }
  async setRecipe(sku: string, lines: RecipeLine[]) {
    await this.db.q.query("INSERT INTO recipes VALUES ($1,$2) ON CONFLICT (sku) DO UPDATE SET lines = EXCLUDED.lines", [sku, JSON.stringify(lines)]);
  }
  async addMoves(moves: StockMove[]) {
    if (!moves.length) return;
    await this.db.tx(async (c) => {
      for (const m of moves) await c.query("INSERT INTO stock_moves (at, data) VALUES ($1,$2)", [m.at, m]);
    });
  }
  listMoves() {
    return datas<StockMove>(this.db.q, "SELECT data FROM stock_moves ORDER BY id");
  }
  async addExpense(e: Expense) {
    await this.db.q.query("INSERT INTO expenses VALUES ($1,$2,$3)", [e.id, e.date, e]);
  }
  listExpenses(fromDate: string, toDate: string) {
    return datas<Expense>(this.db.q, "SELECT data FROM expenses WHERE date BETWEEN $1 AND $2 ORDER BY date, id", [fromDate, toDate]);
  }
  listPayRates() {
    return datas<PayRate>(this.db.q, "SELECT data FROM pay_rates ORDER BY staff_id");
  }
  async setPayRate(rate: PayRate | { staffId: string; remove: true }) {
    if ("remove" in rate) await this.db.q.query("DELETE FROM pay_rates WHERE staff_id = $1", [rate.staffId]);
    else await this.db.q.query("INSERT INTO pay_rates VALUES ($1,$2) ON CONFLICT (staff_id) DO UPDATE SET data = EXCLUDED.data", [rate.staffId, rate]);
  }
}

/** Small settings saved from the portal, such as the Leadaut connection. */
export interface SettingsStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export class PostgresSettings implements SettingsStore {
  constructor(private db: PostgresDb) {}

  async get<T>(key: string) {
    return (await rows<{ value: T }>(this.db.q, "SELECT value FROM settings WHERE key = $1", [key]))[0]?.value;
  }
  async set(key: string, value: unknown) {
    await this.db.q.query("INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [key, JSON.stringify(value)]);
  }
  async delete(key: string) {
    await this.db.q.query("DELETE FROM settings WHERE key = $1", [key]);
  }
}

/** The Leadaut outbox queue, so orders waiting to be sent survive a restart. */
export class PostgresOutboxJournal implements OutboxJournal {
  constructor(private db: PostgresDb) {}

  /** Waiting and failed events, plus delivered and skipped ones from the last 30 days so they aren't sent twice. */
  load() {
    return datas<OutboxEntry>(this.db.q, "SELECT data FROM revenue_outbox WHERE state NOT IN ('sent','skipped') OR updated_at > now() - interval '30 days' ORDER BY seq");
  }
  async save(e: OutboxEntry) {
    await this.db.q.query(
      "INSERT INTO revenue_outbox (event_id, state, data) VALUES ($1,$2,$3) ON CONFLICT (event_id) DO UPDATE SET state = EXCLUDED.state, data = EXCLUDED.data, updated_at = now()",
      [e.event.event_id, e.state, e],
    );
  }
}

/** Paystack webhook events, kept before they're acknowledged so a crash or an outage can't lose one. */
export class PostgresEventJournal implements EventJournal {
  readonly durable = true;
  constructor(private db: PostgresDb) {}

  load() {
    return datas<EventEntry>(this.db.q, "SELECT data FROM payment_events WHERE state = 'pending' ORDER BY seq");
  }
  async save(e: EventEntry) {
    await this.db.q.query(
      "INSERT INTO payment_events (id, state, data) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, data = EXCLUDED.data, updated_at = now()",
      [e.event.id, e.state, e],
    );
  }
}

function nextDay(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
