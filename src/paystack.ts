export type Fetch = typeof fetch;

export class PaystackError extends Error {
  constructor(
    message: string,
    /** "provider_down" = timeouts/5xx after retries; "rejected" = Paystack said no (4xx); "not_found" = unknown reference */
    public kind: "provider_down" | "rejected" | "not_found",
    public httpStatus?: number,
  ) {
    super(message);
  }
}

export type VerifyResult = {
  status: "success" | "failed" | "abandoned" | "ongoing" | "pending" | "reversed" | string;
  amountKobo: number;
  currency: string;
  gatewayResponse?: string;
  paidAt?: string;
  channel?: string;
};

type Opts = { secretKey: string; fetchImpl?: Fetch; baseUrl?: string; timeoutMs?: number; retries?: number; sleep?: (ms: number) => Promise<void> };

export class Paystack {
  private f: Fetch;
  private base: string;
  private timeoutMs: number;
  private retries: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private opts: Opts) {
    if (!opts.secretKey.startsWith("sk_test_")) {
      // The exercise rules say test keys only. Refuse anything else instead of trusting config.
      throw new Error("PAYSTACK_SECRET_KEY must be a test key (sk_test_...)");
    }
    this.f = opts.fetchImpl ?? fetch;
    this.base = opts.baseUrl ?? "https://api.paystack.co";
    this.timeoutMs = opts.timeoutMs ?? 6000;
    this.retries = opts.retries ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await this.sleep(300 * 2 ** (attempt - 1)); // 300ms, 600ms
      try {
        const res = await this.f(`${this.base}${path}`, {
          method,
          headers: { Authorization: `Bearer ${this.opts.secretKey}`, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await res.text();
        let json: { status?: boolean; message?: string; data?: unknown } = {};
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          // Non-JSON body (HTML error page from a proxy, etc.)
        }
        if (res.status >= 500) {
          lastErr = new PaystackError(`Paystack ${res.status}: ${json.message ?? "server error"}`, "provider_down", res.status);
          continue;
        }
        if (res.status === 404 || /not found/i.test(json.message ?? "")) {
          throw new PaystackError(json.message ?? "Not found", "not_found", res.status);
        }
        if (!res.ok || json.status !== true || json.data === undefined || json.data === null) {
          throw new PaystackError(json.message ?? `Paystack returned ${res.status} with an empty response`, "rejected", res.status);
        }
        return json.data as T;
      } catch (e) {
        if (e instanceof PaystackError && e.kind !== "provider_down") throw e;
        lastErr = e;
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new PaystackError(`Paystack unavailable after ${this.retries + 1} attempts: ${msg}`, "provider_down");
  }

  async initialize(input: { email: string; amountKobo: number; reference: string; callbackUrl?: string; metadata?: Record<string, unknown> }) {
    const data = await this.request<{ authorization_url: string; reference: string }>("POST", "/transaction/initialize", {
      email: input.email,
      amount: input.amountKobo,
      reference: input.reference,
      currency: "NGN",
      callback_url: input.callbackUrl,
      metadata: input.metadata,
    });
    if (!data.authorization_url) throw new PaystackError("Paystack returned no payment link", "rejected");
    return { authorizationUrl: data.authorization_url, reference: data.reference };
  }

  async verify(reference: string): Promise<VerifyResult> {
    const d = await this.request<{ status: string; amount: number; currency: string; gateway_response?: string; paid_at?: string; channel?: string }>(
      "GET",
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );
    return { status: d.status, amountKobo: d.amount, currency: d.currency, gatewayResponse: d.gateway_response, paidAt: d.paid_at ?? undefined, channel: d.channel };
  }
}
