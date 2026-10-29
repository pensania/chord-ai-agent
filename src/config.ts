export type Config = {
  port: number;
  mcpBearerToken: string;
  paystackSecretKey: string;
  paystackCallbackUrl?: string;
  store: "memory" | "sheets";
  googleSheetId?: string;
  googleServiceAccountJson?: string;
  chordEventUrl?: string;
  chordEventSecret?: string;
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
  if (store !== "memory" && store !== "sheets") {
    warnings.push(`STORE="${env.STORE}" is not "memory" or "sheets"; using memory`);
    store = "memory";
  }
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
    store,
    googleSheetId: store === "sheets" ? env.GOOGLE_SHEET_ID!.trim() : undefined,
    googleServiceAccountJson: store === "sheets" ? env.GOOGLE_SERVICE_ACCOUNT_JSON!.trim() : undefined,
    chordEventUrl: env.CHORD_EVENT_WEBHOOK_URL || undefined,
    chordEventSecret: env.CHORD_EVENT_SIGNING_SECRET || undefined,
    warnings,
  };
  if (cfg.chordEventUrl && !cfg.chordEventSecret) {
    warnings.push("CHORD_EVENT_WEBHOOK_URL set without CHORD_EVENT_SIGNING_SECRET; Chord forwarding disabled");
    cfg.chordEventUrl = undefined;
  }
  if (missing.length) throw new Error(`Missing or invalid config: ${missing.join(", ")}`);
  return cfg;
}
