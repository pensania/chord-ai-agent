import request from "supertest";
import { describe, expect, it } from "vitest";
import { hashPin, readSession, signSession, verifyPin } from "../src/admin/auth.js";
import { esc } from "../src/admin/views.js";
import { Checkout } from "../src/checkout.js";
import type { Order } from "../src/domain.js";
import { MemoryOpsStore } from "../src/ops/memory.js";
import { lagosDate, Operations } from "../src/ops/operations.js";
import { Paystack } from "../src/paystack.js";
import { createApp } from "../src/server.js";
import { MemoryStore } from "../src/store/memory.js";
import { fakeFetch, TEST_KEY } from "./helpers.js";

const PASSWORD = "correct-horse-battery";

const paid: Order = {
  reference: "MTK-261105-TEST1",
  createdAt: "2026-11-05T08:00:00Z",
  customerName: "Ada <script>",
  customerPhone: "+2348031234567",
  lines: [{ sku: "JOL-SMALL", name: "Party jollof tray (small, serves 10)", qty: 2, unitPriceNgn: 25000, lineTotalNgn: 50000 }],
  deliveryZone: "Yaba",
  deliveryAddress: "12 Herbert Macaulay Way",
  subtotalNgn: 50000,
  deliveryFeeNgn: 3000,
  totalNgn: 53000,
  status: "paid",
  paidAt: "2026-11-05T08:05:00Z",
};

async function setup(withAdmin = true) {
  const store = new MemoryStore();
  await store.createOrder(paid);
  const opsStore = new MemoryOpsStore();
  const operations = new Operations(store, opsStore);
  await opsStore.setRota(lagosDate(new Date()), "rider", ["musa"]);
  const { f } = fakeFetch(() => ({ status: 500, body: {} }));
  const checkout = new Checkout(store, new Paystack({ secretKey: TEST_KEY, fetchImpl: f }));
  const app = createApp({
    checkout,
    mcpBearerToken: "tok",
    paystackSecretKey: TEST_KEY,
    operations,
    admin: withAdmin ? { operations, opsStore, ownerPassword: PASSWORD, sessionSecret: "s3cret" } : undefined,
    log: () => {},
  });
  return { app, opsStore, operations };
}

async function ownerAgent(app: Parameters<typeof request.agent>[0]) {
  const agent = request.agent(app);
  await agent.post("/admin/login").type("form").send({ who: "owner", secret: PASSWORD }).expect(303);
  return agent;
}

describe("admin portal", () => {
  it("is off without a password", async () => {
    const { app } = await setup(false);
    await request(app).get("/admin").expect(404);
  });

  it("sends signed-out visitors to the login page", async () => {
    const { app } = await setup();
    const res = await request(app).get("/admin").expect(303);
    expect(res.headers.location).toBe("/admin/login");
  });

  it("rejects a wrong password and locks out after five tries", async () => {
    const { app } = await setup();
    for (let i = 0; i < 5; i++) await request(app).post("/admin/login").type("form").send({ who: "owner", secret: "nope" }).expect(401);
    await request(app).post("/admin/login").type("form").send({ who: "owner", secret: PASSWORD }).expect(429);
  });

  it("shows the paid order on the board, escaped", async () => {
    const { app } = await setup();
    const agent = await ownerAgent(app);
    const res = await agent.get("/admin").expect(200);
    expect(res.text).toContain("MTK-261105-TEST1");
    expect(res.text).toContain("Ada &lt;script&gt;");
    expect(res.text).not.toContain("Ada <script>");
  });

  it("moves an order and offers the WhatsApp update", async () => {
    const { app, operations } = await setup();
    const agent = await ownerAgent(app);
    await agent.post(`/admin/orders/${paid.reference}/move`).type("form").send({ to: "accepted" }).expect(303);
    expect((await operations.detail(paid.reference, { kind: "owner" })).ops.stage).toBe("accepted");
    const page = await agent.get(`/admin/orders/${paid.reference}`).expect(200);
    expect(page.text).toContain("https://wa.me/2348031234567?text=");
  });

  it("refuses cross-site form posts", async () => {
    const { app } = await setup();
    const agent = await ownerAgent(app);
    await agent.post(`/admin/orders/${paid.reference}/move`).set("Origin", "https://evil.example").type("form").send({ to: "accepted" }).expect(403);
  });

  it("lets the owner set a staff PIN, and that staff member sign in with limited rights", async () => {
    const { app, opsStore } = await setup();
    const owner = await ownerAgent(app);
    await owner.post("/admin/staff").type("form").send({ id: "musa", name: "Musa (rider)", phone: "0803 000 0005", roles: "rider", active: "1", pin: "4321" }).expect(303);
    expect((await opsStore.getStaff("musa"))?.pinHash).toBeTruthy();

    const musa = request.agent(app);
    await musa.post("/admin/login").type("form").send({ who: "08030000005", secret: "4321" }).expect(303);
    await musa.get("/admin").expect(200);
    await musa.post("/admin/rota").type("form").send({ week: "2026-11-02" }).expect(403);
    const moved = await musa.post(`/admin/orders/${paid.reference}/move`).type("form").send({ to: "accepted" }).expect(303);
    const page = await musa.get(moved.headers.location).expect(200);
    expect(page.text).toContain("Your role can&#39;t make this change");
  });

  it("saves the rota for the people who hold each role", async () => {
    const { app, opsStore } = await setup();
    const owner = await ownerAgent(app);
    await owner.post("/admin/rota").type("form").send({ week: "2026-11-02", "2026-11-03|kitchen": ["kemi", "musa"] }).expect(303);
    const rota = await opsStore.listRota("2026-11-03", "2026-11-03");
    expect(rota.filter((r) => r.role === "kitchen").map((r) => r.staffId)).toEqual(["kemi"]);
  });
});

describe("auth helpers", () => {
  it("hashes and checks PINs", () => {
    const h = hashPin("1234");
    expect(verifyPin("1234", h)).toBe(true);
    expect(verifyPin("1235", h)).toBe(false);
    expect(verifyPin("1234", undefined)).toBe(false);
  });
  it("rejects tampered and expired sessions", () => {
    const t = signSession("owner", "k", 0);
    expect(readSession(t, "k", 1000)?.sub).toBe("owner");
    expect(readSession(t, "other", 1000)).toBeUndefined();
    expect(readSession(t, "k", 13 * 3600_000)).toBeUndefined();
    expect(readSession(`${t.split(".")[0]}x.${t.split(".")[1]}`, "k", 1000)).toBeUndefined();
  });
  it("escapes HTML", () => {
    expect(esc(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  });
});

describe("admin origin check", () => {
  it("treats a null origin as cross-site", async () => {
    const { app } = await setup();
    const agent = await ownerAgent(app);
    await agent.post(`/admin/orders/${paid.reference}/move`).set("Origin", "null").type("form").send({ to: "accepted" }).expect(403);
  });
});

describe("MCP with operations", () => {
  it("adds order_status", async () => {
    const { app } = await setup();
    const res = await request(app)
      .post("/mcp")
      .set({ Authorization: "Bearer tok", Accept: "application/json, text/event-stream", "Content-Type": "application/json" })
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      .expect(200);
    expect(res.body.result.tools.map((t: { name: string }) => t.name)).toContain("order_status");
  });
});
