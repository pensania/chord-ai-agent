# Deploy on Render

About 10 minutes. `render.yaml` in the repo root is a Render Blueprint, so Render reads the settings from the repo.

1. In Render: **New → Blueprint**, connect GitHub, and pick `pensania/chord-ai-agent`. Choose the `main` branch (or `feat/checkout-agent` until PR #1 is merged). Render needs access to the `pensania` org; grant it in the GitHub prompt if asked.
2. Render asks for the values marked `sync: false`. Paste your Paystack **test** key (`sk_test_...`) into `PAYSTACK_SECRET_KEY`. Leave the others empty for now.
3. Click **Apply**. The first Docker build takes 2 to 4 minutes. When it's live, open `https://<service>.onrender.com/healthz` and check it returns `{"ok":true}`.
4. In the service's **Environment** tab, copy the generated `MCP_BEARER_TOKEN`.
5. In Chord, register the MCP server: URL `https://<service>.onrender.com/mcp`, transport `streamable_http`, auth `bearer`, token = the value from step 4.
6. In Paystack (test mode) → Settings → API Keys & Webhooks, set the webhook URL to `https://<service>.onrender.com/webhooks/paystack`.

Every push to the chosen branch redeploys automatically.

## Plan choice

The Blueprint uses **Starter** (paid, always on). On **Free**, the service sleeps after 15 minutes without traffic. The next request then waits about a minute while it wakes, which can make Chord's first tool call time out, and the memory store loses all orders and stock on every sleep. Free is fine for a quick try. Use Starter, or `STORE=sheets`, for the recording and while TSG tests the agent.

## If something's wrong

- **Deploy fails at start:** open **Logs**. A missing variable is named in a `Missing or invalid config` line. A live key gives `must be a test key`.
- **Chord health errors:** check the URL ends in `/mcp` and the token matches. 401s show up in the logs.
