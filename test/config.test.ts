import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { MCP_BEARER_TOKEN: "t", PAYSTACK_SECRET_KEY: "sk_test_x" };

describe("loadConfig", () => {
  it("defaults to the memory store", () => {
    expect(loadConfig({ ...base }).store).toBe("memory");
    expect(loadConfig({ ...base, STORE: "" }).store).toBe("memory");
  });

  it("falls back to memory when sheets settings are missing, with a warning", () => {
    const cfg = loadConfig({ ...base, STORE: "sheets", GOOGLE_SHEET_ID: "abc" });
    expect(cfg.store).toBe("memory");
    expect(cfg.warnings.join()).toMatch(/GOOGLE_SERVICE_ACCOUNT_JSON/);
  });

  it("uses sheets when both settings are present", () => {
    const cfg = loadConfig({ ...base, STORE: "Sheets", GOOGLE_SHEET_ID: "abc", GOOGLE_SERVICE_ACCOUNT_JSON: "{}" });
    expect(cfg.store).toBe("sheets");
  });

  it("disables Chord forwarding without a signing secret instead of failing", () => {
    const cfg = loadConfig({ ...base, CHORD_EVENT_WEBHOOK_URL: "https://x" });
    expect(cfg.chordEventUrl).toBeUndefined();
    expect(cfg.warnings).toHaveLength(1);
  });

  it("still requires the bearer token and Paystack key", () => {
    expect(() => loadConfig({})).toThrow(/MCP_BEARER_TOKEN, PAYSTACK_SECRET_KEY/);
  });
});
