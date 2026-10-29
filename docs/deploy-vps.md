# Deploy on your own VPS

About 15 minutes. You get the tool server on HTTPS behind Caddy, which fetches and renews the certificate for you. Chord needs a public HTTPS URL; it blocks private and loopback addresses.

**You need:** a VPS with Ubuntu 22.04/24.04 or Debian 12 (1 vCPU / 1 GB RAM is plenty), SSH access, ports 80 and 443 open, and a hostname pointing at the VPS.

**No domain?** Use [sslip.io](https://sslip.io): for IP `203.0.113.10` the hostname `203-0-113-10.sslip.io` already resolves to it, and Caddy can get a certificate for it.

## 1. Point a hostname at the VPS

Add an `A` record, e.g. `checkout.yourdomain.com → <VPS IP>`. Check it with `dig +short checkout.yourdomain.com`. Skip this if you use sslip.io.

## 2. One-time setup

```bash
ssh root@<VPS IP>
git clone https://github.com/pensania/chord-ai-agent.git && cd chord-ai-agent
sudo deploy/vps/setup.sh        # installs Docker, opens 22/80/443 with ufw
```

The repo is private, so `git clone` asks for your GitHub username and a [personal access token](https://github.com/settings/tokens) (read-only, this repo only) as the password. A deploy key works too.

## 3. Configure

```bash
cd deploy/vps
cp .env.example .env
openssl rand -hex 32            # copy this as MCP_BEARER_TOKEN
nano .env                       # DOMAIN, MCP_BEARER_TOKEN, PAYSTACK_SECRET_KEY (sk_test_...)
chmod 600 .env
```

`.env` never leaves the server and is git-ignored.

## 4. Start it

```bash
./deploy.sh
```

It builds the image, starts the app and Caddy, waits for the certificate, and prints:

```
Live: https://checkout.yourdomain.com/healthz
Chord MCP URL:     https://checkout.yourdomain.com/mcp
Paystack webhook:  https://checkout.yourdomain.com/webhooks/paystack
```

Run `./deploy.sh` again after any code change. It pulls and rebuilds.

## 5. Wire it up

- **Chord:** register the MCP server with the printed MCP URL, transport `streamable_http`, auth `bearer`, and the same `MCP_BEARER_TOKEN` (see the README's "Connect it to Chord").
- **Paystack (test mode):** Settings → API Keys & Webhooks → set the webhook URL to the printed one.

## Check it from your laptop

```bash
curl https://<DOMAIN>/healthz
curl -s https://<DOMAIN>/mcp -H "Authorization: Bearer <token>" \
  -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The first returns `{"ok":true}`, the second lists three tools. Without the token, `/mcp` returns 401. Any other path returns 404.

## When something's wrong

| Symptom | Likely cause | Look at |
| --- | --- | --- |
| `deploy.sh` times out waiting | DNS not pointing here yet, or 80/443 closed at the provider | `docker compose logs caddy` (look for ACME errors), `dig +short <DOMAIN>` |
| App container restarting | Missing or invalid env var | `docker compose logs app` (it names the missing variable) |
| Chord health shows an error | Wrong URL (must end in `/mcp`), wrong token, or the token sent as a custom header instead of `auth_token` | `docker compose logs app` for 401s |
| Paystack webhook 401 | Webhook signed with a different key than `PAYSTACK_SECRET_KEY` | Paystack dashboard → webhook logs |

Useful commands: `docker compose ps`, `docker compose logs -f app`, `docker compose restart app`, `docker compose down`.

Note: the default `STORE=memory` resets orders and stock when the container restarts. Use `STORE=sheets` for anything you want to keep.
