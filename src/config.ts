export type Config = {
  port: number;
  mcpBearerToken: string;
  paystackSecretKey: string;
  paystackCallbackUrl?: string;
  placeholderEmailDomain?: string;
  store: "memory" | "sheets" | "postgres";
  /** Postgres connection string, when STORE=postgres. */
  databaseUrl?: string;
  googleSheetId?: string;
  googleServiceAccountJson?: string;
  chordEventUrl?: string;
  chordEventSecret?: string;
  /** Where customer and order events go (Leadaut). Both must be set. */
  revenueWebhookUrl?: string;
  revenueWebhookSecret?: string;
  /** Owner password for /admin. Unset = portal off. */
  adminPassword?: string;
  adminSessionSecret?: string;
  /** "staffId:PIN" pairs from STAFF_PINS, so PINs survive restarts of the memory store. */
  staffPins: { staffId: string; pin: string }[];
  /** Non-fatal problems, logged at startup. */
  warnings: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) missing.push(k);
    return v ?? "";
  };
  const warnings: string[] = [];
  let store = (env.STORE?.trim().toLowerCase() || "memory") as Config["store"];
  if (store !== "memory" && store !== "sheets" && store !== "postgres") {
    warnings.push(`STORE="${env.STORE}" is not "memory", "sheets" or "postgres"; using memory`);
    store = "memory";
  }
  // Postgres is the one store where taking orders without it would lose them, so a missing URL
  // is a startup error, not a quiet fallback to memory.
  if (store === "postgres" && !env.DATABASE_URL?.trim()) missing.push("DATABASE_URL (needed for STORE=postgres)");
  // Sheets is optional: if its settings are missing, run on the memory store instead of refusing to start.
  if (store === "sheets") {
    const absent = ["GOOGLE_SHEET_ID", "GOOGLE_SERVICE_ACCOUNT_JSON"].filter((k) => !env[k]?.trim());
    if (absent.length) {
      warnings.push(`STORE=sheets but ${absent.join(" and ")} not set; using memory store (orders reset on restart)`);
      store = "memory";
    }
  }
  const cfg: Config = {
    port: Number(env.PORT ?? 8080),
    mcpBearerToken: need("MCP_BEARER_TOKEN"),
    paystackSecretKey: need("PAYSTACK_SECRET_KEY"),
    paystackCallbackUrl: env.PAYSTACK_CALLBACK_URL || undefined,
    placeholderEmailDomain: env.PLACEHOLDER_EMAIL_DOMAIN?.trim() || undefined,
    store,
    databaseUrl: store === "postgres" ? env.DATABASE_URL?.trim() : undefined,
    googleSheetId: store === "sheets" ? env.GOOGLE_SHEET_ID!.trim() : undefined,
    googleServiceAccountJson: store === "sheets" ? env.GOOGLE_SERVICE_ACCOUNT_JSON!.trim() : undefined,
    chordEventUrl: env.CHORD_EVENT_WEBHOOK_URL || undefined,
    chordEventSecret: env.CHORD_EVENT_SIGNING_SECRET || undefined,
    revenueWebhookUrl: env.LEADAUT_WEBHOOK_URL?.trim() || undefined,
    revenueWebhookSecret: env.LEADAUT_WEBHOOK_SECRET?.trim() || undefined,
    // Dashboards make it easy to paste a value with quotes around it; drop one matching pair.
    adminPassword: env.ADMIN_PASSWORD?.trim().replace(/^(["'])(.*)\1$/, "$2") || undefined,
    adminSessionSecret: env.ADMIN_SESSION_SECRET?.trim() || undefined,
    staffPins: [],
    warnings,
  };
  for (const pair of (env.STAFF_PINS ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const [staffId, pin] = pair.split(":").map((x) => x?.trim());
    if (staffId && pin && /^\d{4,8}$/.test(pin)) cfg.staffPins.push({ staffId, pin });
    else warnings.push(`STAFF_PINS entry "${staffId ?? pair}" ignored: use id:PIN with a 4 to 8 digit PIN`);
  }
  if (cfg.adminPassword && cfg.adminPassword.length < 10) {
    warnings.push("ADMIN_PASSWORD is shorter than 10 characters; admin portal disabled");
    cfg.adminPassword = undefined;
  }
  if (cfg.revenueWebhookUrl) {
    let okUrl = false;
    try {
      const u = new URL(cfg.revenueWebhookUrl);
      okUrl = u.protocol === "https:" || u.hostname === "localhost" || u.hostname === "127.0.0.1";
    } catch {
      okUrl = false;
    }
    if (!okUrl) {
      warnings.push("LEADAUT_WEBHOOK_URL must be an https URL; Leadaut sync disabled");
      cfg.revenueWebhookUrl = undefined;
    } else if (!cfg.revenueWebhookSecret || cfg.revenueWebhookSecret.length < 16) {
      warnings.push("LEADAUT_WEBHOOK_URL set without LEADAUT_WEBHOOK_SECRET (16+ characters); Leadaut sync disabled");
      cfg.revenueWebhookUrl = undefined;
    }
  }
  if (cfg.chordEventUrl && !cfg.chordEventSecret) {
    warnings.push("CHORD_EVENT_WEBHOOK_URL set without CHORD_EVENT_SIGNING_SECRET; Chord forwarding disabled");
    cfg.chordEventUrl = undefined;
  }
  if (missing.length) throw new Error(`Missing or invalid config: ${missing.join(", ")}`);
  return cfg;
}
