import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** PINs are stored as "salt:hash" (scrypt), never in plain text. */
export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pin, salt, 32).toString("hex")}`;
}

export function verifyPin(pin: string, stored: string | undefined): boolean {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const want = Buffer.from(hash, "hex");
  const got = scryptSync(pin, salt, want.length);
  return want.length > 0 && timingSafeEqual(got, want);
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type Session = { sub: string; exp: number };

const SESSION_HOURS = 12;

export function signSession(sub: string, secret: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ sub, exp: now + SESSION_HOURS * 3600_000 } satisfies Session)).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function readSession(token: string | undefined, secret: string, now = Date.now()): Session | undefined {
  if (!token || !token.includes(".")) return undefined;
  const [body, mac] = token.split(".");
  const want = createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(mac, want)) return undefined;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Session;
    return typeof s.sub === "string" && s.exp > now ? s : undefined;
  } catch {
    return undefined;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Five wrong logins per IP in 15 minutes, then a pause. Enough to stop PIN guessing on a small shop's portal. */
export class LoginLimiter {
  private fails = new Map<string, number[]>();
  constructor(private max = 5, private windowMs = 15 * 60_000) {}
  blocked(key: string, now = Date.now()) {
    const recent = (this.fails.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.fails.set(key, recent);
    return recent.length >= this.max;
  }
  fail(key: string, now = Date.now()) {
    this.fails.set(key, [...(this.fails.get(key) ?? []), now]);
  }
  clear(key: string) {
    this.fails.delete(key);
  }
}
