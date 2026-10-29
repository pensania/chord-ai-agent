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
  it("reads STAFF_PINS and skips bad entries", () => {
    const cfg = loadConfig({ ...base, STAFF_PINS: "kemi:1234, musa:12, :9999" });
    expect(cfg.staffPins).toEqual([{ staffId: "kemi", pin: "1234" }]);
    expect(cfg.warnings.length).toBe(2);
  });

  it("turns the admin portal off when the password is too short", () => {
    const cfg = loadConfig({ ...base, ADMIN_PASSWORD: "short" });
    expect(cfg.adminPassword).toBeUndefined();
    expect(cfg.warnings.join(" ")).toContain("ADMIN_PASSWORD");
  });
});
