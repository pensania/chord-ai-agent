export type Config = {
  port: number;
  mcpBearerToken: string;
  paystackSecretKey: string;
  paystackCallbackUrl?: string;
  placeholderEmailDomain?: string;
  store: "memory" | "sheets";
  googleSheetId?: string;
  googleServiceAccountJson?: string;
  chordEventUrl?: string;
  chordEventSecret?: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) missing.push(k);
    return v ?? "";
  };
  const store = (env.STORE ?? "memory") as Config["store"];
  const cfg: Config = {
    port: Number(env.PORT ?? 8080),
    mcpBearerToken: need("MCP_BEARER_TOKEN"),
    paystackSecretKey: need("PAYSTACK_SECRET_KEY"),
    paystackCallbackUrl: env.PAYSTACK_CALLBACK_URL || undefined,
    placeholderEmailDomain: env.PLACEHOLDER_EMAIL_DOMAIN?.trim() || undefined,
    store,
    googleSheetId: store === "sheets" ? need("GOOGLE_SHEET_ID") : undefined,
    googleServiceAccountJson: store === "sheets" ? need("GOOGLE_SERVICE_ACCOUNT_JSON") : undefined,
    chordEventUrl: env.CHORD_EVENT_WEBHOOK_URL || undefined,
    chordEventSecret: env.CHORD_EVENT_SIGNING_SECRET || undefined,
  };
  if (store !== "memory" && store !== "sheets") missing.push("STORE (memory|sheets)");
  if (cfg.chordEventUrl && !cfg.chordEventSecret) missing.push("CHORD_EVENT_SIGNING_SECRET");
  if (missing.length) throw new Error(`Missing or invalid config: ${missing.join(", ")}`);
  return cfg;
}
