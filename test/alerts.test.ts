import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { signSession } from "../src/admin/auth.js";
import { Checkout } from "../src/checkout.js";
import type { Order } from "../src/domain.js";
import { AlertHub, type AlertMailer, type LiveMessage, ResendMailer } from "../src/ops/alerts.js";
import { MemoryOpsStore } from "../src/ops/memory.js";
import { Operations, type Actor } from "../src/ops/operations.js";
import { Paystack } from "../src/paystack.js";
import { createApp } from "../src/server.js";
import { MemoryStore } from "../src/store/memory.js";
import { fakeFetch, TEST_KEY } from "./helpers.js";

const NOW = new Date("2026-11-05T09:00:00Z");
const TODAY = "2026-11-05";

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
  status: "paid",
  paidAt: "2026-11-05T08:05:00Z",
  neededBy: "2026-11-07",
  ...patch,
});

async function setup(mailer?: AlertMailer) {
  const store = new MemoryStore();
  const opsStore = new MemoryOpsStore();
  // One job each, so the tests read clearly.
  for (const [id, roles] of [["ifeoma", ["intake"]], ["kemi", ["kitchen"]], ["segun", ["dispatch"]]] as const) {
    await opsStore.saveStaff({ ...(await opsStore.getStaff(id))!, roles: [...roles] });
  }
  await opsStore.setRota(TODAY, "intake", ["ifeoma"]);
  await opsStore.setRota(TODAY, "kitchen", ["kemi"]);
  await opsStore.setRota(TODAY, "dispatch", ["segun"]);
  await opsStore.setRota(TODAY, "rider", ["musa"]);
  let hub!: AlertHub;
  const ops = new Operations(store, opsStore, { now: () => NOW, onStageChange: async (e) => hub.stageChanged(e, (await store.getOrder(e.reference))!) });
  hub = new AlertHub(opsStore, ops, { now: () => NOW, mailer, ownerEmail: "owner@kitchen.test", baseUrl: "https://kitchen.test" });
  const heard = new Map<string, LiveMessage[]>();
  for (const key of ["owner", "staff:ifeoma", "staff:kemi", "staff:segun", "staff:musa", "staff:chidi"]) {
    heard.set(key, []);
    hub.subscribe(key, (m) => heard.get(key)!.push(m));
  }
  const alertsFor = (key: string) => heard.get(key)!.filter((m) => m.type === "alert").map((m) => (m as { alert: { title: string } }).alert.title);
  const clear = () => heard.forEach((v) => (v.length = 0));
  const staff = async (id: string): Promise<Actor> => ({ kind: "staff", staff: (await opsStore.getStaff(id))! });
  return { store, opsStore, ops, hub, heard, alertsFor, clear, staff };
}

describe("order alerts", () => {
  it("tells intake on duty and the owner about a new paid order; everyone else's board just refreshes", async () => {
    const { store, hub, alertsFor, heard } = await setup();
    const o = order("MTK-1");
    await store.createOrder(o);
    await hub.newOrder(o);
    expect(alertsFor("staff:ifeoma")).toEqual(["New order MTK-1 · ₦53,000"]);
    expect(alertsFor("owner")).toHaveLength(1);
    expect(alertsFor("staff:kemi")).toEqual([]);
    expect(heard.get("staff:kemi")).toEqual([{ type: "refresh" }]);
    expect(hub.recent("staff:ifeoma")[0]).toMatchObject({ reference: "MTK-1", url: "/admin/orders/MTK-1" });
    expect(hub.recent("staff:kemi")).toEqual([]);
  });

  it("follows the order: cook, then dispatch, then the rider, then intake; nobody is told about their own move", async () => {
    const { store, ops, alertsFor, clear, staff } = await setup();
    await store.createOrder(order("MTK-2"));
    const step = async (to: Parameters<Operations["move"]>[1], by: Actor) => {
      clear();
      await ops.move("MTK-2", to, by);
    };
    await step("accepted", await staff("ifeoma"));
    expect(alertsFor("staff:kemi")).toEqual(["Cook MTK-2"]);
    expect(alertsFor("staff:ifeoma")).toEqual([]);
    expect(alertsFor("owner")).toEqual(["Cook MTK-2"]);

    await step("cooking", await staff("kemi"));
    expect(alertsFor("staff:kemi")).toEqual([]);
    expect(alertsFor("owner")).toEqual(["MTK-2 is cooking"]);

    await step("ready", await staff("kemi"));
    expect(alertsFor("staff:segun")).toEqual(["MTK-2 is ready for a rider"]);

    await step("out_for_delivery", await staff("segun"));
    expect(alertsFor("staff:musa")).toEqual(["Deliver MTK-2 to Yaba"]);
    expect(alertsFor("staff:segun")).toEqual([]);

    await step("delivered", await staff("musa"));
    expect(alertsFor("staff:ifeoma")).toEqual(["MTK-2 delivered"]);
    expect(alertsFor("staff:musa")).toEqual([]);
    expect(alertsFor("staff:chidi")).toEqual([]); // off duty, not involved
  });

  it("sends pickups back to intake, and tells everyone involved about a cancellation", async () => {
    const { store, ops, alertsFor, clear, staff } = await setup();
    await store.createOrder(order("MTK-3", { deliveryZone: "Pickup" }));
    await ops.move("MTK-3", "accepted", await staff("ifeoma"));
    await ops.move("MTK-3", "cooking", await staff("kemi"));
    clear();
    await ops.move("MTK-3", "ready", await staff("kemi"));
    expect(alertsFor("staff:ifeoma")).toEqual(["MTK-3 is ready for pickup"]);
    expect(alertsFor("staff:segun")).toEqual([]);
    clear();
    await ops.move("MTK-3", "cancelled", { kind: "owner" });
    expect(alertsFor("staff:kemi")).toEqual(["MTK-3 was cancelled"]);
    expect(alertsFor("staff:ifeoma")).toEqual(["MTK-3 was cancelled"]);
    expect(alertsFor("owner")).toEqual([]);
  });

  it("emails the people who have an address, and a mail failure doesn't stop the move", async () => {
    const sent: { to: string; subject: string; url: string }[] = [];
    const mailer = { send: async (to: string, subject: string, _t: string, url: string) => void sent.push({ to, subject, url }) };
    const { store, opsStore, hub } = await setup(mailer);
    const ifeoma = (await opsStore.getStaff("ifeoma"))!;
    await opsStore.saveStaff({ ...ifeoma, email: "ifeoma@kitchen.test" });
    const o = order("MTK-4");
    await store.createOrder(o);
    await hub.newOrder(o);
    expect(sent.map((s) => s.to).sort()).toEqual(["ifeoma@kitchen.test", "owner@kitchen.test"]);
    expect(sent[0]).toMatchObject({ subject: "New order MTK-4 · ₦53,000", url: "https://kitchen.test/admin/orders/MTK-4" });

    const failing = await setup({ send: async () => Promise.reject(new Error("smtp down")) });
    await failing.store.createOrder(o);
    await expect(failing.hub.newOrder(o)).resolves.toBeUndefined();
  });

  it("sends through Resend's API", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, body: { id: "x" } }));
    await new ResendMailer({ apiKey: "re_test", from: "Kitchen <alerts@kitchen.test>", fetchImpl: f }).send("a@b.test", "Hi", "Body", "https://k.test/x");
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ to: ["a@b.test"], subject: "Hi" });
  });
});

describe("live portal", () => {
  it("streams alerts to a signed-in page, and an alert for a new paid order arrives", async () => {
    const { store, opsStore, ops, hub } = await setup();
    const { f } = fakeFetch(() => ({ status: 500, body: {} }));
    const app = createApp({
      checkout: new Checkout(store, new Paystack({ secretKey: TEST_KEY, fetchImpl: f })),
      mcpBearerToken: "tok",
      paystackSecretKey: TEST_KEY,
      operations: ops,
      admin: { operations: ops, opsStore, ownerPassword: "correct-horse-battery", sessionSecret: "s3cret", alerts: hub },
      log: () => {},
    });
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const cookie = `mtk_admin=${signSession("staff:ifeoma", "s3cret")}`;
      const res = await fetch(`http://127.0.0.1:${port}/admin/live`, { headers: { cookie } });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      const before = hub.listeners();
      const o = order("MTK-5");
      await store.createOrder(o);
      await new Promise((r) => setTimeout(r, 50));
      await hub.newOrder(o);
      let text = "";
      while (!text.includes("event: alert")) text += new TextDecoder().decode((await reader.read()).value);
      expect(text).toContain("New order MTK-5");
      await reader.cancel();
      await new Promise((r) => setTimeout(r, 50));
      expect(hub.listeners()).toBe(before - 1);

      const page = await fetch(`http://127.0.0.1:${port}/admin`, { headers: { cookie } });
      const html = await page.text();
      expect(html).toContain('id="bell"');
      expect(html).toContain('new EventSource("/admin/live")');
      const recent = await (await fetch(`http://127.0.0.1:${port}/admin/alerts`, { headers: { cookie } })).json();
      expect(recent[0]).toMatchObject({ reference: "MTK-5" });
    } finally {
      server.close();
    }
  });
});
