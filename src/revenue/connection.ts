import type { Order } from "../domain.js";
import type { StageEvent } from "../ops/operations.js";
import { RevenueOutbox, type OutboxStatus } from "./outbox.js";
import { RevenueSync } from "./sync.js";

export type LeadautSource = "portal" | "render";

export type LeadautView = {
  connected: boolean;
  source?: LeadautSource;
  url?: string;
  /** The end of the secret, so the owner can tell which one is in use without seeing it. */
  secretEnd?: string;
  connectedAt?: string;
  lastCheck?: { at: string; ok: boolean; error?: string };
  outbox: OutboxStatus;
};

export class LeadautError extends Error {}

/** What Leadaut's refusals mean, in words the owner can act on. */
export function explainLeadautError(error: string) {
  if (error === "bad_signature") return "Leadaut didn't accept the secret. Copy it again from Leadaut's E-commerce page.";
  if (error === "unknown_integration") return "Leadaut doesn't know that webhook URL. Check the ID at the end, or connect the store again in Leadaut.";
  if (error === "integration_paused") return "The store is paused in Leadaut. Reconnect it there.";
  if (error === "feature_disabled") return "Store is switched off for this Leadaut account.";
  if (error === "not_leadaut") return "That URL answered, but not like Leadaut's store webhook. Check the URL.";
  if (/^HTTP 404/.test(error)) return "Nothing at that URL (404). Check the webhook URL.";
  if (/^HTTP 401|^HTTP 403/.test(error)) return "That URL refused the request. Check it's the webhook URL, not a Leadaut page link.";
  return `Leadaut couldn't be reached: ${error}`;
}

export function validateLeadaut(url: string, secret: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new LeadautError("That isn't a web address. Paste the full webhook URL from Leadaut.");
  }
  if (u.protocol !== "https:") throw new LeadautError("The webhook URL must start with https://");
  if (secret.length < 16) throw new LeadautError("The secret looks too short. Paste the full secret from Leadaut (it starts with lds_wc_).");
}

/**
 * The link to Leadaut. Set on the admin portal's Integrations page, or from LEADAUT_WEBHOOK_URL and
 * LEADAUT_WEBHOOK_SECRET on Render. Settings saved on the portal live in memory until the storage
 * layer lands; after a restart the Render values (if any) apply again.
 */
export class LeadautLink {
  readonly outbox: RevenueOutbox;
  private sync: RevenueSync;
  private target?: { url: string; secret: string; source: LeadautSource; at: string };
  private lastCheck?: LeadautView["lastCheck"];

  constructor(opts: { outbox?: RevenueOutbox; log?: (msg: string, extra?: Record<string, unknown>) => void; now?: () => Date } = {}) {
    this.outbox = opts.outbox ?? new RevenueOutbox({ log: opts.log });
    this.sync = new RevenueSync(this.outbox, { now: opts.now });
    this.now = opts.now ?? (() => new Date());
  }

  private now: () => Date;

  get connected() {
    return Boolean(this.target);
  }

  /** Use these settings from now on. Events already waiting go to the new target. */
  connect(url: string, secret: string, source: LeadautSource, checked?: { ok: true }) {
    validateLeadaut(url, secret);
    const at = this.now().toISOString();
    this.target = { url, secret, source, at };
    this.outbox.setTarget({ url, secret });
    this.lastCheck = checked ? { at, ok: true } : undefined;
  }

  /** The secret in use, for keeping it when only the URL changes. Never shown on a page. */
  secret() {
    return this.target?.secret;
  }

  disconnect() {
    this.target = undefined;
    this.lastCheck = undefined;
    this.outbox.setTarget(undefined);
  }

  /** Check settings with Leadaut before saving them, or the saved ones when none are given. */
  async check(candidate?: { url: string; secret: string }) {
    const t = candidate ?? this.target;
    if (!t) throw new LeadautError("Leadaut isn't connected yet.");
    validateLeadaut(t.url, t.secret);
    const r = await this.outbox.check(t);
    const result = { at: this.now().toISOString(), ok: r.ok, ...(r.ok ? {} : { error: r.error }) };
    if (!candidate || (candidate.url === this.target?.url && candidate.secret === this.target?.secret)) this.lastCheck = result;
    return r;
  }

  retryFailed() {
    return this.outbox.retryDead();
  }

  view(): LeadautView {
    const t = this.target;
    return {
      connected: Boolean(t),
      source: t?.source,
      url: t?.url,
      secretEnd: t ? t.secret.slice(-4) : undefined,
      connectedAt: t?.at,
      lastCheck: this.lastCheck,
      outbox: this.outbox.status(),
    };
  }

  /** Paid orders and revenue stage changes are only queued while connected. */
  paid(order: Order) {
    if (this.target) this.sync.paid(order);
  }

  stage(e: StageEvent, order: Order) {
    if (this.target) this.sync.stage(e, order);
  }
}
