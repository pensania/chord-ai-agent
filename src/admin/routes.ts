import express, { type NextFunction, type Request, type Response, Router } from "express";
import { normalisePhone } from "../domain.js";
import { addDays, OpsError, type Actor, type Operations } from "../ops/operations.js";
import { ROLES, STAGES, type OpsStore, type Role, type Stage, type Staff } from "../ops/types.js";
import { hashPin, LoginLimiter, parseCookies, readSession, safeEqual, signSession, verifyPin } from "./auth.js";
import { explainLeadautError, LeadautError, type LeadautLink } from "../revenue/connection.js";
import { actorName, donePage, integrationsPage, layout, loginPage, orderPage, queuePage, rotaPage, staffPage } from "./views.js";

export type AdminDeps = {
  operations: Operations;
  opsStore: OpsStore;
  ownerPassword: string;
  sessionSecret: string;
  /** The Leadaut link the owner sets up on the Integrations page. */
  leadaut?: LeadautLink;
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
    res.send(queuePage(items, deps.operations.today(), duty, rs, actorName(actor), flashOf(req)));
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
      res.send(orderPage(item, new Map(staff.map((s) => [s.id, s])), await riders(), deps.operations.today(), actorName(actor), flashOf(req)));
    } catch (e) {
      if (e instanceof OpsError && e.code === "not_found") {
        res.status(404).send(layout("Not found", "<h1>No order with that reference</h1>", actorName(actor)));
        return;
      }
      throw e;
    }
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
    const fail = (m: string) => res.redirect(303, `/admin/staff?msg=${encodeURIComponent(m)}`);
    if (!name || phone.replace(/\D/g, "").length < 10) return fail("Name and a full phone number are needed");
    if (pin && !/^\d{4,8}$/.test(pin)) return fail("PIN must be 4 to 8 digits");

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
    });
    fail(`Saved ${name}`);
  });

  // Integrations: owner only.
  const ownerOnly = (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (isOwner(req.actor!)) return next();
    res.status(403).send(layout("Not allowed", "<h1>Only the owner can change integrations</h1>", actorName(req.actor!)));
  };
  const back = (res: Response, msg: string) => res.redirect(303, `/admin/integrations?msg=${encodeURIComponent(msg)}`);
  const leadaut = deps.leadaut;

  r.get("/integrations", ownerOnly, (req: AuthedRequest, res) => {
    if (!leadaut) {
      res.status(404).send(layout("Integrations", "<h1>Integrations aren't available on this server</h1>", actorName(req.actor!), undefined, "Integrations"));
      return;
    }
    res.send(integrationsPage(leadaut.view(), explainLeadautError, actorName(req.actor!), flashOf(req)));
  });

  r.post("/integrations/leadaut", ownerOnly, async (req: AuthedRequest, res) => {
    if (!leadaut) return back(res, "Integrations aren't available on this server");
    const url = String(req.body.url ?? "").trim();
    // An empty secret keeps the one in use, so the owner can fix a URL without finding the secret again.
    const typed = String(req.body.secret ?? "").trim();
    const current = leadaut.connected ? leadaut.secret() : undefined;
    const secret = typed || current || "";
    const again = (msg: string) => res.status(400).send(integrationsPage(leadaut.view(), explainLeadautError, actorName(req.actor!), msg, { url }));
    try {
      const checked = await leadaut.check({ url, secret });
      if (!checked.ok) return again(`Not saved. ${explainLeadautError(checked.error)}`);
      leadaut.connect(url, secret, "portal", checked);
      console.log(JSON.stringify({ msg: "leadaut_connected", source: "portal" }));
      back(res, "Leadaut connected. New paid orders will be sent there.");
    } catch (e) {
      if (e instanceof LeadautError) return again(e.message);
      throw e;
    }
  });

  r.post("/integrations/leadaut/check", ownerOnly, async (_req, res) => {
    if (!leadaut?.connected) return back(res, "Leadaut isn't connected yet.");
    const checked = await leadaut.check();
    back(res, checked.ok ? "Leadaut accepted the connection check." : explainLeadautError(checked.error));
  });

  r.post("/integrations/leadaut/retry", ownerOnly, (_req, res) => {
    if (!leadaut?.connected) return back(res, "Leadaut isn't connected yet.");
    const n = leadaut.retryFailed();
    back(res, n ? `Resending ${n} failed ${n === 1 ? "order" : "orders"}.` : "Nothing to resend.");
  });

  r.post("/integrations/leadaut/disconnect", ownerOnly, (_req, res) => {
    if (!leadaut) return back(res, "Integrations aren't available on this server");
    leadaut.disconnect();
    console.log(JSON.stringify({ msg: "leadaut_disconnected" }));
    back(res, "Leadaut disconnected. New orders won't be sent until you connect it again.");
  });

  return r;
}
