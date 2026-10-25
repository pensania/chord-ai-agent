import { createHmac, timingSafeEqual } from "node:crypto";
import type { Fetch } from "./paystack.js";

/** Paystack signs the raw body with HMAC-SHA512 using your secret key, in x-paystack-signature. */
export function verifyPaystackSignature(rawBody: Buffer, signature: string | undefined, secretKey: string): boolean {
  if (!signature) return false;
  const expected = createHmac("sha512", secretKey).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.trim().toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Chord event subscriptions expect X-Chord-Timestamp and
 * X-Chord-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">.
 * Send the exact bytes that were signed.
 */
export function signChordEvent(body: string, secret: string, timestampMs: number) {
  const ts = String(timestampMs);
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return { "X-Chord-Timestamp": ts, "X-Chord-Signature": `sha256=${sig}` };
}

export async function forwardToChord(
  cfg: { url: string; secret: string; fetchImpl?: Fetch; now?: () => number },
  event: { event_type: string; event_id: string; [k: string]: unknown },
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body = JSON.stringify(event);
  const headers = { "Content-Type": "application/json", ...signChordEvent(body, cfg.secret, (cfg.now ?? Date.now)()) };
  try {
    const res = await (cfg.fetchImpl ?? fetch)(cfg.url, { method: "POST", headers, body, signal: AbortSignal.timeout(5000) });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
