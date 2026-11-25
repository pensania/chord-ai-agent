import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { hashPin } from "../src/admin/auth.js";
import { Checkout } from "../src/checkout.js";
import { MemoryOpsStore } from "../src/ops/memory.js";
import { Operations } from "../src/ops/operations.js";
import { createApp } from "../src/server.js";
import { Catalogue } from "../src/stock/catalogue.js";
import { fakePaystack, IN_A_WEEK } from "./helpers.js";
import { pgSchema, STORES } from "./stores.js";

const PASSWORD = "correct-horse-battery";
const schema = pgSchema("menu");
afterAll(async () => {
  if (process.env.TEST_DATABASE_URL) await schema.drop();
});

describe.each(STORES)("menu and zone pages on $name (D-08)", ({ name, skip, make }) => {
  async function setup() {
    const store = make(name === "postgres" ? await schema.fresh() : undefined);
    const opsStore = new MemoryOpsStore();
    const kemi = (await opsStore.getStaff("kemi"))!;
    await opsStore.saveStaff({ ...kemi, pinHash: hashPin("1111") });
    const operations = new Operations(store, opsStore);
    const ps = fakePaystack();
    const checkout = new Checkout(store, ps.paystack);
    const app = createApp({
      checkout,
      mcpBearerToken: "tok",
      paystackSecretKey: "sk_test_x",
      operations,
      admin: { operations, opsStore, checkout, catalogue: new Catalogue(store), ownerPassword: PASSWORD, sessionSecret: "s" },
      log: () => {},
    });
    const owner = request.agent(app);
    await owner.post("/admin/login").type("form").send({ who: "owner", secret: PASSWORD }).expect(303);
    const post = async (path: string, body: Record<string, string>) => {
      const r = await owner.post(path).type("form").send(body).expect(303);
      return new URL(r.headers.location, "http://x").searchParams.get("msg");
    };
    const item = async (sku: string) => (await store.listMenu()).find((m) => m.sku === sku);
    return { store, app, owner, post, item, checkout, ps };
  }

  it.skipIf(skip)("lets the owner change price, name, stock and visibility, and the agent sees it", async () => {
    const { owner, post, item, checkout } = await setup();
    expect((await owner.get("/admin/menu").expect(200)).text).toContain("JOL-SMALL");
    expect(await post("/admin/menu/JOL-SMALL", { name: "Small jollof <b>", priceNgn: "27,500", active: "1" })).toBe("Saved Small jollof <b>");
    expect(await item("JOL-SMALL")).toEqual({ sku: "JOL-SMALL", name: "Small jollof <b>", priceNgn: 27500, stock: 6, active: true });
    expect((await owner.get("/admin/menu")).text).toContain("Small jollof &lt;b&gt;");
    expect(await checkout.checkStock([{ sku: "JOL-SMALL", qty: 1 }], "Pickup")).toMatchObject({ total_ngn: 27500 });

    await post("/admin/menu/JOL-SMALL/stock", { stock: "9", was: "6" });
    expect((await item("JOL-SMALL"))!.stock).toBe(9);
    await post("/admin/menu/JOL-SMALL", { name: "Small jollof", priceNgn: "27500" }); // box unticked
    expect(await checkout.checkStock([{ sku: "JOL-SMALL", qty: 1 }])).toMatchObject({ ok: false });
  });

  it.skipIf(skip)("doesn't undo a sale made while the owner was editing", async () => {
    const { post, item, checkout, ps } = await setup();
    const r = await checkout.createPaymentLink({ customerName: "Ada", customerPhone: "08031234567", items: [{ sku: "JOL-SMALL", qty: 2 }], deliveryZone: "Pickup", deliveryAddress: "Pickup", neededBy: IN_A_WEEK });
    ps.set(String(r.reference), { status: "success" });
    await checkout.verifyPayment(String(r.reference));
    expect(await post("/admin/menu/JOL-SMALL/stock", { stock: "6", was: "6" })).toMatch(/changed to 4 while you were editing/);
    await post("/admin/menu/JOL-SMALL", { name: "Small jollof", priceNgn: "25000", active: "1" });
    expect((await item("JOL-SMALL"))!.stock).toBe(4);
  });

  it.skipIf(skip)("adds items, and refuses bad ones", async () => {
    const { post, item, store } = await setup();
    const good = { sku: "jol-medium", name: "Medium jollof", priceNgn: "40000", stock: "3", active: "1" };
    expect(await post("/admin/menu", good)).toBe("Added Medium jollof");
    expect(await item("JOL-MEDIUM")).toEqual({ sku: "JOL-MEDIUM", name: "Medium jollof", priceNgn: 40000, stock: 3, active: true });
    expect((await store.listMenu()).at(-1)!.sku).toBe("JOL-MEDIUM");
    expect(await post("/admin/menu", good)).toMatch(/already an item/);
    expect(await post("/admin/menu", { ...good, sku: "a b" })).toMatch(/code must be/);
    expect(await post("/admin/menu", { ...good, sku: "NEW-1", priceNgn: "-5" })).toMatch(/price must be/);
    expect(await post("/admin/menu", { ...good, sku: "NEW-1", priceNgn: "12.5" })).toMatch(/price must be/);
    expect(await post("/admin/menu", { ...good, sku: "NEW-1", stock: "" })).toMatch(/Stock must be/);
    expect(await post("/admin/menu", { ...good, sku: "NEW-1", name: " " })).toMatch(/name must be/);
    expect(await post("/admin/menu/NOPE/stock", { stock: "1", was: "1" })).toMatch(/No menu item/);
    expect(await store.listMenu()).toHaveLength(7);
  });

  it.skipIf(skip)("edits zones, and keeps Pickup free and in place", async () => {
    const { owner, post, store } = await setup();
    expect((await owner.get("/admin/zones").expect(200)).text).toContain("Surulere");
    expect(await post("/admin/zones", { zone: "yaba", feeNgn: "3,500" })).toBe("Saved Yaba");
    expect(await post("/admin/zones", { zone: "Maryland", feeNgn: "4000" })).toBe("Saved Maryland");
    expect(await post("/admin/zones/remove", { zone: "Lekki" })).toBe("Removed Lekki");
    const zones = await store.listZones();
    expect(zones.find((z) => z.zone === "Yaba")).toEqual({ zone: "Yaba", feeNgn: 3500 });
    expect(zones.map((z) => z.zone)).toEqual(["Yaba", "Surulere", "Ikeja", "Victoria Island", "Pickup", "Maryland"]);
    expect(await post("/admin/zones/remove", { zone: "Pickup" })).toMatch(/can't be removed/);
    expect(await post("/admin/zones", { zone: "pickup", feeNgn: "500" })).toMatch(/always free/);
    expect(await post("/admin/zones", { zone: "X", feeNgn: "lots" })).toMatch(/fee must be/);
    expect(await post("/admin/zones/remove", { zone: "Nowhere" })).toMatch(/No such zone/);
  });

  it.skipIf(skip)("is for the owner only", async () => {
    const { app, item } = await setup();
    await request(app).get("/admin/menu").expect(303);
    const staff = request.agent(app);
    await staff.post("/admin/login").type("form").send({ who: "kemi", secret: "1111" }).expect(303);
    await staff.get("/admin/menu").expect(403);
    await staff.get("/admin/zones").expect(403);
    await staff.post("/admin/menu/JOL-SMALL").type("form").send({ name: "Free", priceNgn: "1", active: "1" }).expect(403);
    await staff.post("/admin/zones/remove").type("form").send({ zone: "Yaba" }).expect(403);
    expect((await item("JOL-SMALL"))!.priceNgn).toBe(25000);
    expect((await staff.get("/admin")).text).not.toContain("/admin/menu");
  });
});
