import express, { type NextFunction, type Request, type Response, Router } from "express";
import { normalisePhone } from "../domain.js";
import { addDays, OpsError, type Actor, type Operations } from "../ops/operations.js";
import { ROLES, STAGES, type OpsStore, type Role, type Stage, type Staff } from "../ops/types.js";
import { hashPin, LoginLimiter, parseCookies, readSession, safeEqual, signSession, verifyPin } from "./auth.js";
import { explainLeadautError, LeadautError, type LeadautLink } from "../revenue/connection.js";
import { Kitchen, StockError } from "../stock/kitchen.js";
import type { AlertHub } from "../ops/alerts.js";
import { ReviewError, type Checkout } from "../checkout.js";
import { actorName, donePage, heldPanel, integrationsPage, layout, loginPage, orderPage, queuePage, rotaPage, showLive, showMoneyNav, staffPage } from "./views.js";
import { expensesPage, lowStockBanner, payPage, recipePage, stockPage } from "./views-money.js";

export type AdminDeps = {
  operations: Operations;
  opsStore: OpsStore;
  ownerPassword: string;
  sessionSecret: string;
  /** The Leadaut link the owner sets up on the Integrations page. */
  leadaut?: LeadautLink;
  /** Live board updates and order alerts. */
  alerts?: AlertHub;
  /** Stock, expenses and pay. Optional so the portal still runs without it. */
  kitchen?: Kitchen;
  /** For payments held for the owner (needs_review): listing them and settling them. */
  checkout?: Checkout;
};

const COOKIE = "mtk_admin";

type AuthedRequest = Request & { actor?: Actor };

/** Monday of the week that holds `date`. */
function weekStart(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}

const asList = (v: unknown): string[] => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

export function adminRouter(deps: AdminDeps): Router {
  const r = Router();
  const limiter = new LoginLimiter();
  showMoneyNav(Boolean(deps.kitchen));
  r.use(express.urlencoded({ extended: false, limit: "64kb" }));

  const setCookie = (req: Request, res: Response, value: string, maxAge: number) => {
    const secure = req.secure || req.header("x-forwarded-proto") === "https";
    res.setHeader("Set-Cookie", `${COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);
  };

  // Forms only: refuse cross-site posts when the browser tells us the origin.
  r.use((req, res, next) => {
    const origin = req.header("origin");
    let sameSite = true;
    if (origin) {
      try {
        sameSite = new URL(origin).host === req.header("host");
      } catch {
        sameSite = false; // e.g. "null" from a sandboxed page
      }
    }
    if (req.method === "POST" && !sameSite) {
      res.status(403).send("Cross-site request refused");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  r.get("/login", (_req, res) => {
    res.send(loginPage());
  });

  r.post("/login", async (req, res) => {
    const key = req.ip ?? "unknown";
    if (limiter.blocked(key)) {
      res.status(429).send(loginPage("Too many attempts. Try again in 15 minutes.", req.body.mode === "owner" ? "owner" : "staff"));
      return;
    }
    // The page sends mode=owner from its Staff/Owner switch, but we don't rely on it: the owner password
    // (10+ characters) can never be a staff PIN (4-8 digits), so it signs the owner in whichever tab is picked.
    const mode = req.body.mode === "owner" ? "owner" : "staff";
    const who = String(req.body.who ?? "").trim();
    // Trim and normalise what was typed: autofill and copy-paste often add a trailing space.
    const secret = String(req.body.secret ?? "").trim().normalize("NFC");
    let sub: string | undefined;
    if (safeEqual(secret, deps.ownerPassword.normalize("NFC"))) sub = "owner";
    else if (who && who.toLowerCase() !== "owner" && mode === "staff") {
      // Staff can type their phone number in any common format, or their staff id (e.g. "kemi").
      const phone = normalisePhone(who);
      const id = who.toLowerCase();
      const staff = (await deps.opsStore.listStaff()).find((s) => s.active && (s.id === id || normalisePhone(s.phone) === phone));
      if (staff && verifyPin(secret, staff.pinHash)) sub = `staff:${staff.id}`;
    }
    const ownerTry = mode === "owner" || !who || who.toLowerCase() === "owner";
    if (!sub) {
      // Lengths only, never the text: lets the owner compare against the ADMIN_PASSWORD they think they set.
      console.warn(JSON.stringify({ msg: "admin_login_failed", as: ownerTry ? "owner" : "staff", typed_length: secret.length, ...(ownerTry ? { expected_length: deps.ownerPassword.length } : {}) }));
      limiter.fail(key);
      res.status(401).send(loginPage(ownerTry ? "That password didn't match ADMIN_PASSWORD on the server." : "That number and PIN don't match.", ownerTry ? "owner" : "staff"));
      return;
    }
    limiter.clear(key);
    setCookie(req, res, signSession(sub, deps.sessionSecret), 12 * 3600);
    res.redirect(303, "/admin");
  });

  r.post("/logout", (req, res) => {
    setCookie(req, res, "", 0);
    res.redirect(303, "/admin/login");
  });

  const requireActor = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const s = readSession(parseCookies(req.header("cookie"))[COOKIE], deps.sessionSecret);
    if (s?.sub === "owner") req.actor = { kind: "owner" };
    else if (s?.sub.startsWith("staff:")) {
      const staff = await deps.opsStore.getStaff(s.sub.slice(6));
      if (staff?.active) req.actor = { kind: "staff", staff };
    }
    if (!req.actor) {
      res.redirect(303, "/admin/login");
      return;
    }
    next();
  };
  r.use(requireActor);

  const flashOf = (req: Request) => (typeof req.query.msg === "string" ? req.query.msg.slice(0, 200) : undefined);
  const isOwner = (a: Actor) => a.kind === "owner";
  const actorKey = (a: Actor) => (a.kind === "owner" ? "owner" : `staff:${a.staff.id}`);
  showLive(Boolean(deps.alerts));

  // Server-sent events: the page refreshes its data on any change and shows the alerts meant for this person.
  r.get("/live", (req: AuthedRequest, res) => {
    const hub = deps.alerts;
    if (!hub) return void res.status(404).end();
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 5000\n\n");
    const stop = hub.subscribe(actorKey(req.actor!), (m) => res.write(`event: ${m.type}\ndata: ${JSON.stringify(m.type === "alert" ? m.alert : {})}\n\n`));
    // Proxies close quiet connections; a comment every 25 s keeps it open.
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      stop();
    });
  });

  r.get("/alerts", (req: AuthedRequest, res) => {
    res.json(deps.alerts ? deps.alerts.recent(actorKey(req.actor!)) : []);
  });

  async function dutyToday() {
    const today = deps.operations.today();
    const entries = await Promise.all(ROLES.map(async (role) => [role, await deps.operations.onDuty(today, role)] as const));
    return Object.fromEntries(entries) as Record<Role, Staff[]>;
  }

  async function riders() {
    const today = deps.operations.today();
    const duty = await deps.operations.onDuty(today, "rider");
    const all = (await deps.opsStore.listStaff()).filter((s) => s.active && s.roles.includes("rider"));
    // On-duty riders first, then the rest, so dispatch can still send someone off-rota.
    return [...duty, ...all.filter((s) => !duty.some((d) => d.id === s.id))];
  }

  r.get("/", async (req: AuthedRequest, res) => {
    const actor = req.actor!;
    const [items, duty, rs] = await Promise.all([deps.operations.queue(actor), dutyToday(), riders()]);
    const held = deps.checkout ? heldPanel(await deps.checkout.heldPayments(), isOwner(actor)) : "";
    const banner = held + (deps.kitchen ? lowStockBanner(await deps.kitchen.lowStock()) : "");
    res.send(queuePage(items, deps.operations.today(), duty, rs, actorName(actor), flashOf(req), banner));
  });

  r.get("/done", async (req: AuthedRequest, res) => {
    const actor = req.actor!;
    res.send(donePage(await deps.operations.queue(actor, { includeDone: true }), actorName(actor)));
  });

  r.get("/orders/:ref", async (req: AuthedRequest, res) => {
    const actor = req.actor!;
    try {
      const item = await deps.operations.detail(String(req.params.ref), actor);
      const staff = await deps.opsStore.listStaff();
      res.send(orderPage(item, new Map(staff.map((s) => [s.id, s])), await riders(), deps.operations.today(), actorName(actor), flashOf(req), isOwner(actor) && Boolean(deps.checkout)));
    } catch (e) {
      if (e instanceof OpsError && e.code === "not_found") {
        res.status(404).send(layout("Not found", "<h1>No order with that reference</h1>", actorName(actor)));
        return;
      }
      throw e;
    }
  });

  r.post("/orders/:ref/review", async (req: AuthedRequest, res) => {
    const ref = String(req.params.ref);
    const back = (msg: string) => res.redirect(303, `/admin/orders/${encodeURIComponent(ref)}?msg=${encodeURIComponent(msg)}`);
    if (!isOwner(req.actor!) || !deps.checkout) {
      res.status(403).send(layout("Not allowed", "<h1>Only the owner can settle a held payment</h1>", actorName(req.actor!)));
      return;
    }
    const decision = String(req.body.decision ?? "");
    if (decision !== "accept" && decision !== "close") return back("Pick put in the queue or close it");
    try {
      await deps.checkout.review(ref, decision, "owner");
    } catch (e) {
      if (e instanceof ReviewError) return back(e.message);
      throw e;
    }
    // Accepting raises a new-order alert, which refreshes every board; closing needs its own refresh.
    if (decision === "close") deps.alerts?.refresh();
    back(decision === "accept" ? "In the queue. Intake has been told." : "Closed. It won't be confirmed.");
  });

  r.post("/orders/:ref/move", async (req: AuthedRequest, res) => {
    const ref = String(req.params.ref);
    const to = String(req.body.to ?? "") as Stage;
    const back = `/admin/orders/${encodeURIComponent(ref)}`;
    if (!STAGES.includes(to)) {
      res.redirect(303, `${back}?msg=${encodeURIComponent("Unknown stage")}`);
      return;
    }
    try {
      await deps.operations.move(ref, to, req.actor!, { riderId: req.body.riderId ? String(req.body.riderId) : undefined, note: req.body.note ? String(req.body.note) : undefined });
      res.redirect(303, back);
    } catch (e) {
      if (e instanceof OpsError) {
        res.redirect(303, `${back}?msg=${encodeURIComponent(e.message)}`);
        return;
      }
      throw e;
    }
  });

  r.get("/rota", async (req: AuthedRequest, res) => {
    const actor = req.actor!;
    const asked = typeof req.query.week === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.week) ? req.query.week : deps.operations.today();
    const start = weekStart(asked);
    const week = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const [rota, staff] = await Promise.all([deps.opsStore.listRota(week[0], week[6]), deps.opsStore.listStaff()]);
    res.send(rotaPage(week, rota, staff, isOwner(actor), actorName(actor), flashOf(req)));
  });

  r.post("/rota", async (req: AuthedRequest, res) => {
    if (!isOwner(req.actor!)) {
      res.status(403).send(layout("Not allowed", "<h1>Only the owner can change the rota</h1>", actorName(req.actor!)));
      return;
    }
    const start = String(req.body.week ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
      res.redirect(303, "/admin/rota");
      return;
    }
    const staff = await deps.opsStore.listStaff();
    for (let i = 0; i < 7; i++) {
      const date = addDays(start, i);
      for (const role of ROLES) {
        // Only people who hold the role can be put on it.
        const ids = asList(req.body[`${date}|${role}`]).filter((id) => staff.some((s) => s.id === id && s.roles.includes(role)));
        await deps.opsStore.setRota(date, role, ids);
      }
    }
    res.redirect(303, `/admin/rota?week=${start}&msg=${encodeURIComponent("Rota saved")}`);
  });

  r.get("/staff", async (req: AuthedRequest, res) => {
    const actor = req.actor!;
    const staff = await deps.opsStore.listStaff();
    const editing = typeof req.query.edit === "string" ? staff.find((s) => s.id === req.query.edit) : undefined;
    res.send(staffPage(staff, isOwner(actor), actorName(actor), flashOf(req), editing));
  });

  r.post("/staff", async (req: AuthedRequest, res) => {
    if (!isOwner(req.actor!)) {
      res.status(403).send(layout("Not allowed", "<h1>Only the owner can change staff</h1>", actorName(req.actor!)));
      return;
    }
    const name = String(req.body.name ?? "").trim();
    const phone = normalisePhone(String(req.body.phone ?? ""));
    const roles = asList(req.body.roles).filter((x): x is Role => (ROLES as readonly string[]).includes(x));
    const pin = String(req.body.pin ?? "").trim();
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const fail = (m: string) => res.redirect(303, `/admin/staff?msg=${encodeURIComponent(m)}`);
    if (!name || phone.replace(/\D/g, "").length < 10) return fail("Name and a full phone number are needed");
    if (pin && !/^\d{4,8}$/.test(pin)) return fail("PIN must be 4 to 8 digits");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("That email address doesn't look right");

    const all = await deps.opsStore.listStaff();
    const id = String(req.body.id ?? "").trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `staff-${Date.now()}`;
    const existing = all.find((s) => s.id === id);
    if (all.some((s) => s.id !== id && normalisePhone(s.phone) === phone)) return fail("Another staff member already has that number");
    await deps.opsStore.saveStaff({
      id: existing ? existing.id : all.some((s) => s.id === id) ? `${id}-${Date.now()}` : id,
      name,
      phone,
      roles,
      active: req.body.active === "1",
      pinHash: pin ? hashPin(pin) : existing?.pinHash,
      email: email || undefined,
    });
    fail(`Saved ${name}`);
  });

  if (deps.kitchen) mountMoney(r, deps.kitchen, isOwner);

  // Integrations: owner only.
  const ownerOnly = (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (isOwner(req.actor!)) return next();
    res.status(403).send(layout("Not allowed", "<h1>Only the owner can change integrations</h1>", actorName(req.actor!)));
  };
  const toIntegrations = (res: Response, msg: string) => res.redirect(303, `/admin/integrations?msg=${encodeURIComponent(msg)}`);
  const leadaut = deps.leadaut;

  r.get("/integrations", ownerOnly, (req: AuthedRequest, res) => {
    if (!leadaut) {
      res.status(404).send(layout("Integrations", "<h1>Integrations aren't available on this server</h1>", actorName(req.actor!), undefined, "Integrations"));
      return;
    }
    res.send(integrationsPage(leadaut.view(), explainLeadautError, actorName(req.actor!), flashOf(req)));
  });

  r.post("/integrations/leadaut", ownerOnly, async (req: AuthedRequest, res) => {
    if (!leadaut) return toIntegrations(res, "Integrations aren't available on this server");
    const url = String(req.body.url ?? "").trim();
    // An empty secret keeps the one in use, so the owner can fix a URL without finding the secret again.
    const typed = String(req.body.secret ?? "").trim();
    const current = leadaut.connected ? leadaut.secret() : undefined;
    const secret = typed || current || "";
    const again = (msg: string) => res.status(400).send(integrationsPage(leadaut.view(), explainLeadautError, actorName(req.actor!), msg, { url }));
    try {
      const checked = await leadaut.check({ url, secret });
      if (!checked.ok) return again(`Not saved. ${explainLeadautError(checked.error)}`);
      await leadaut.save(url, secret, checked);
      console.log(JSON.stringify({ msg: "leadaut_connected", source: "portal" }));
      toIntegrations(res, "Leadaut connected. New paid orders will be sent there.");
    } catch (e) {
      if (e instanceof LeadautError) return again(e.message);
      throw e;
    }
  });

  r.post("/integrations/leadaut/check", ownerOnly, async (_req, res) => {
    if (!leadaut?.connected) return toIntegrations(res, "Leadaut isn't connected yet.");
    const checked = await leadaut.check();
    toIntegrations(res, checked.ok ? "Leadaut accepted the connection check." : explainLeadautError(checked.error));
  });

  r.post("/integrations/leadaut/retry", ownerOnly, (_req, res) => {
    if (!leadaut?.connected) return toIntegrations(res, "Leadaut isn't connected yet.");
    const n = leadaut.retryFailed();
    toIntegrations(res, n ? `Resending ${n} failed ${n === 1 ? "order" : "orders"}.` : "Nothing to resend.");
  });

  r.post("/integrations/leadaut/disconnect", ownerOnly, async (_req, res) => {
    if (!leadaut) return toIntegrations(res, "Integrations aren't available on this server");
    await leadaut.turnOff();
    console.log(JSON.stringify({ msg: "leadaut_disconnected" }));
    toIntegrations(res, "Leadaut disconnected. New orders won't be sent until you connect it again.");
  });

  return r;
}

const MONTH = /^\d{4}-\d{2}$/;
const num = (v: unknown) => (v === undefined || String(v).trim() === "" ? NaN : Number(String(v).replace(/[,₦\s]/g, "")));
const back = (res: Response, to: string, msg: string) => res.redirect(303, `${to}${to.includes("?") ? "&" : "?"}msg=${encodeURIComponent(msg)}`);

/** Stock (everyone can see it; owner and kitchen staff can count), expenses and pay (owner only). */
function mountMoney(r: Router, kitchen: Kitchen, isOwner: (a: Actor) => boolean) {
  const canCount = (a: Actor) => isOwner(a) || (a.kind === "staff" && a.staff.roles.includes("kitchen"));
  const ownerOnly = (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (isOwner(req.actor!)) return next();
    res.status(403).send(layout("Not allowed", "<h1>Only the owner can see this page</h1>", actorName(req.actor!)));
  };
  const by = (a: Actor) => (a.kind === "owner" ? "owner" : a.staff.id);
  const month = (req: Request) => (typeof req.query.month === "string" && MONTH.test(req.query.month) ? req.query.month : kitchen.today().slice(0, 7));
  const flash = (req: Request) => (typeof req.query.msg === "string" ? req.query.msg.slice(0, 200) : undefined);
  const guard = (to: string, fn: (req: AuthedRequest, res: Response) => Promise<void>) => async (req: AuthedRequest, res: Response) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof StockError) return back(res, to, e.message);
      throw e;
    }
  };

  r.get("/stock", async (req: AuthedRequest, res) => {
    const actor = req.actor!;
    const [ingredients, menu, recipes, unitCosts, moves] = await Promise.all([kitchen.ingredients(), kitchen.menu(), kitchen.recipes(), kitchen.unitCosts(), kitchen.moves(200)]);
    const editing = isOwner(actor) && typeof req.query.edit === "string" ? ingredients.find((i) => i.id === req.query.edit) : undefined;
    res.send(stockPage({ ingredients, menu, recipes, unitCosts, moves, canCount: canCount(actor), isOwner: isOwner(actor), editing, who: actorName(actor), flash: flash(req) }));
  });

  r.post(
    "/stock/count",
    guard("/admin/stock", async (req, res) => {
      if (!canCount(req.actor!)) return void res.status(403).send(layout("Not allowed", "<h1>Only the owner and kitchen staff can count stock</h1>", actorName(req.actor!)));
      const ing = await kitchen.count(String(req.body.id ?? ""), num(req.body.counted), by(req.actor!), req.body.note ? String(req.body.note) : undefined);
      back(res, "/admin/stock", `${ing.name}: now ${ing.onHand} ${ing.unit}`);
    }),
  );

  r.post(
    "/stock/ingredient",
    ownerOnly,
    guard("/admin/stock", async (req, res) => {
      const ing = await kitchen.saveIngredient({ id: req.body.id ? String(req.body.id) : undefined, name: String(req.body.name ?? ""), unit: String(req.body.unit ?? ""), lowAt: num(req.body.lowAt), costPerUnitNgn: num(req.body.costPerUnitNgn) });
      back(res, "/admin/stock", `Saved ${ing.name}`);
    }),
  );

  const menuItem = async (sku: string) => (await kitchen.menu()).find((m) => m.sku === sku);

  r.get("/stock/recipe/:sku", ownerOnly, async (req: AuthedRequest, res) => {
    const item = await menuItem(String(req.params.sku));
    if (!item) return void res.status(404).send(layout("Not found", "<h1>No menu item with that code</h1>", actorName(req.actor!)));
    res.send(recipePage(item, (await kitchen.recipes())[item.sku] ?? [], await kitchen.ingredients(), actorName(req.actor!), flash(req)));
  });

  r.post("/stock/recipe/:sku", ownerOnly, async (req: AuthedRequest, res) => {
    const item = await menuItem(String(req.params.sku));
    if (!item) return void res.status(404).send(layout("Not found", "<h1>No menu item with that code</h1>", actorName(req.actor!)));
    const lines = Object.entries(req.body as Record<string, unknown>)
      .filter(([k]) => k.startsWith("qty:"))
      .map(([k, v]) => ({ ingredientId: k.slice(4), qty: num(v) }))
      .filter((l) => l.qty > 0);
    await kitchen.setRecipe(item.sku, lines);
    back(res, "/admin/stock", `Saved the recipe for ${item.name}`);
  });

  r.get("/expenses", ownerOnly, async (req: AuthedRequest, res) => {
    const m = month(req);
    const [exp, used, ingredients] = await Promise.all([kitchen.expenses(m), kitchen.ingredientsUsed(m), kitchen.ingredients()]);
    res.send(expensesPage({ month: m, today: kitchen.today(), ...exp, ingredientsUsedNgn: used.costNgn, ingredients, who: actorName(req.actor!), flash: flash(req) }));
  });

  r.post(
    "/expenses",
    ownerOnly,
    guard("/admin/expenses", async (req, res) => {
      const purchases = [0, 1, 2, 3, 4, 5]
        .map((n) => ({ ingredientId: String(req.body[`p${n}_id`] ?? ""), qty: num(req.body[`p${n}_qty`]), costNgn: num(req.body[`p${n}_cost`]) }))
        .filter((p) => p.ingredientId && p.qty > 0);
      const e = await kitchen.addExpense({ date: req.body.date ? String(req.body.date) : undefined, category: String(req.body.category ?? ""), description: String(req.body.description ?? ""), amountNgn: num(req.body.amountNgn), purchases }, by(req.actor!));
      back(res, `/admin/expenses?month=${e.date.slice(0, 7)}`, `Logged ${e.description}`);
    }),
  );

  r.get("/pay", ownerOnly, async (req: AuthedRequest, res) => {
    const m = month(req);
    res.send(payPage({ month: m, ...(await kitchen.payroll(m)), who: actorName(req.actor!), flash: flash(req) }));
  });

  r.post(
    "/pay",
    ownerOnly,
    guard("/admin/pay", async (req, res) => {
      const m = MONTH.test(String(req.body.month)) ? String(req.body.month) : kitchen.today().slice(0, 7);
      await kitchen.setPayRate(String(req.body.staffId ?? ""), String(req.body.basis ?? ""), num(req.body.amountNgn));
      back(res, `/admin/pay?month=${m}`, "Pay rate saved");
    }),
  );
}
