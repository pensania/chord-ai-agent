#!/usr/bin/env bash
# Pull the latest code and (re)start the stack. Safe to run repeatedly.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "Missing deploy/vps/.env. Copy .env.example and fill it in."; exit 1; }
grep -q '^MCP_BEARER_TOKEN=.\+' .env || { echo "Set MCP_BEARER_TOKEN in .env (openssl rand -hex 32)."; exit 1; }
grep -q '^PAYSTACK_SECRET_KEY=sk_test_' .env || { echo "Set PAYSTACK_SECRET_KEY to a Paystack TEST key (sk_test_...)."; exit 1; }

git -C ../.. pull --ff-only
docker compose up -d --build
docker compose ps

DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
echo "Waiting for https://${DOMAIN}/healthz (the first certificate can take a minute)..."
for i in $(seq 1 30); do
  if curl -fsS "https://${DOMAIN}/healthz" >/dev/null 2>&1; then
    echo "Live: https://${DOMAIN}/healthz"
    echo "Chord MCP URL:     https://${DOMAIN}/mcp"
    echo "Paystack webhook:  https://${DOMAIN}/webhooks/paystack"
    exit 0
  fi
  sleep 4
done
echo "Not reachable yet. Check: docker compose logs caddy app"
exit 1
