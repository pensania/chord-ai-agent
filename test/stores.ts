import pg from "pg";
import seed from "../data/seed.json" with { type: "json" };
import { MemoryStore } from "../src/store/memory.js";
import { PostgresDb, PostgresStore } from "../src/store/postgres.js";
import { SheetsStore } from "../src/store/sheets.js";
import type { Store } from "../src/store/types.js";

export const PG_URL = process.env.TEST_DATABASE_URL;

/** A Postgres schema of its own, so test files running side by side never see each other's rows. */
export function pgSchema(name: string) {
  const schema = `mtk_${name}_${process.pid}_${Date.now()}`;
  const pools: pg.Pool[] = [];
  const admin = async (sql: string) => {
    const pool = new pg.Pool({ connectionString: PG_URL });
    await pool.query(sql);
    await pool.end();
  };
  return {
    async fresh() {
      await admin(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
      const pool = new pg.Pool({ connectionString: PG_URL, options: `-c search_path=${schema}` });
      pools.push(pool);
      const db = new PostgresDb(pool);
      await db.migrate();
      return db;
    },
    async drop() {
      for (const p of pools) await p.end().catch(() => {});
      await admin(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    },
  };
}

/** A Google Sheet in memory, behind the real SheetsStore. */
export class FakeSheet extends SheetsStore {
  tabs: Record<string, (string | number | boolean)[][]> = {
    Menu: [["sku"], ...seed.menu.map((m) => [m.sku, m.name, m.priceNgn, m.stock, m.active])],
    Zones: [["zone"], ...seed.deliveryZones.map((z) => [z.zone, z.feeNgn])],
    Orders: [["reference"]],
  };
  /** Requests that wrote something, and the ranges each one wrote. */
  writes: string[][] = [];

  constructor() {
    super("sheet", "{}");
  }

  protected override async call<T>(method: "GET" | "PUT" | "POST", path: string, body?: unknown): Promise<T> {
    await new Promise((r) => setTimeout(r, 1)); // a real call yields, so races show up
    const at = (range: string) => {
      const [, tab, col, row] = /^(\w+)!([A-Z])(\d*)/.exec(range)!;
      return { rows: this.tabs[tab], col: col.charCodeAt(0) - 65, row: Number(row || 1) - 1, end: range.split(":")[1]?.charCodeAt(0) };
    };
    const [, range, append] = /^\/values\/([^:?]+(?:%3A[^:?]*)?)(:append)?/.exec(path) ?? [];
    if (method === "GET") {
      const { rows, col, row, end } = at(decodeURIComponent(range));
      return { values: structuredClone(rows.slice(row).map((r) => r.slice(col, end! - 64))) } as T;
    }
    if (append) {
      const { rows } = at(decodeURIComponent(range));
      rows.push(...(body as { values: typeof rows }).values);
      this.writes.push([decodeURIComponent(range)]);
      return {} as T;
    }
    const { data } = body as { data: { range: string; values: (string | number | boolean)[][] }[] };
    for (const d of data) {
      const { rows, col, row } = at(d.range);
      d.values[0].forEach((v, i) => (rows[row][col + i] = v));
    }
    this.writes.push(data.map((d) => d.range));
    return {} as T;
  }
}

export const STORES: { name: string; skip: boolean; make: (db?: PostgresDb) => Store }[] = [
  { name: "memory", skip: false, make: () => new MemoryStore() },
  { name: "sheets", skip: false, make: () => new FakeSheet() },
  { name: "postgres", skip: !PG_URL, make: (db) => new PostgresStore(db!) },
];
