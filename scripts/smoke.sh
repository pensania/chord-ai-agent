#!/usr/bin/env bash
# Test the deployed tool server end to end without Chord (no credits used).
# Usage: BASE=https://chord-checkout.onrender.com TOKEN=<MCP_BEARER_TOKEN> scripts/smoke.sh
set -euo pipefail
: "${BASE:?set BASE}" "${TOKEN:?set TOKEN}"

call() { # call <tool> <json-args>
  curl -sS -m 60 "$BASE/mcp" -H "Authorization: Bearer $TOKEN" \
    -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.result?JSON.stringify(JSON.parse(r.result.content[0].text),null,2):JSON.stringify(r,null,2))})'
}

echo "1. Health (first call can take ~1 min if Render is waking up)"
curl -sS -m 90 "$BASE/healthz"; echo

echo "2. Auth check: expect 401 without token"
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/mcp" -H 'Content-Type: application/json' -d '{}'

echo "3. Quote: 2 small jollof + 1 puff-puff to Yaba (expect total_ngn 61000)"
call check_stock '{"items":[{"sku":"JOL-SMALL","qty":2},{"sku":"PUFF-50","qty":1}],"delivery_zone":"Yaba"}'

echo "4. Sold-out item (expect ok:false, out_of_stock)"
call check_stock '{"items":[{"sku":"MOIMOI-20","qty":1}],"delivery_zone":"Yaba"}' | head -12

echo "5. Create a Paystack test payment link"
OUT=$(call create_payment_link '{"customer_name":"Test Ada","customer_phone":"08031234567","items":[{"sku":"JOL-SMALL","qty":2},{"sku":"PUFF-50","qty":1}],"delivery_zone":"Yaba","delivery_address":"12 Herbert Macaulay Way"}')
echo "$OUT"
REF=$(echo "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).reference||""))')
[ -n "$REF" ] || { echo "No reference returned; see the error above."; exit 1; }

echo "6. Verify before paying (expect not_paid_yet)"
call verify_payment "{\"reference\":\"$REF\"}"

echo
echo "Now open the payment_url above and pay with Paystack's test card (4084 0840 8408 4081, any future expiry, CVV 408, PIN 0000, OTP 123456)."
read -rp "Press Enter when paid... "

echo "7. Verify after paying (expect status: paid)"
call verify_payment "{\"reference\":\"$REF\"}"

echo "8. Verify again (expect already_confirmed: true, no double count)"
call verify_payment "{\"reference\":\"$REF\"}"
