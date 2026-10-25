import { describe, expect, it } from "vitest";
import seed from "../data/seed.json" with { type: "json" };
import { normalisePhone, quote } from "../src/domain.js";

describe("quote", () => {
  it("prices from the menu and adds the zone fee", () => {
    const q = quote(seed.menu, seed.deliveryZones, [{ sku: "jol-small", qty: 2 }, { sku: "PUFF-50", qty: 1 }], "yaba");
    expect(q).toMatchObject({ ok: true, subtotalNgn: 58000, deliveryFeeNgn: 3000, totalNgn: 61000, zone: "Yaba" });
  });

  it("merges duplicate lines before checking stock", () => {
    const q = quote(seed.menu, seed.deliveryZones, [{ sku: "JOL-LARGE", qty: 2 }, { sku: "JOL-LARGE", qty: 2 }], "Pickup");
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.problems[0]).toMatchObject({ kind: "out_of_stock", requested: 4, available: 3 });
  });

  it("reports unknown items, sold-out items and unknown zones together", () => {
    const q = quote(seed.menu, seed.deliveryZones, [{ sku: "PIZZA", qty: 1 }, { sku: "MOIMOI-20", qty: 1 }], "Abuja");
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.problems.map((p) => p.kind)).toEqual(["unknown_item", "out_of_stock", "unknown_zone"]);
  });
});

describe("normalisePhone", () => {
  it("turns local Nigerian numbers into +234", () => {
    expect(normalisePhone("0803 123 4567")).toBe("+2348031234567");
    expect(normalisePhone("+234 803 123 4567")).toBe("+2348031234567");
  });
});
