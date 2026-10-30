# Deployment field notes

Three problems that cost the most time, each with the error, how I found the cause, what I did, and what Chord could change. Three smaller ones are at the end.

### 1. Event subscriptions can't reach the customer, and the docs only say so indirectly
- **What happened:** The plan was to have a Paystack webhook trigger a Chord run that messages the customer "payment received". The event-subscriptions guide says no conversation thread is created for an event run and the result goes back to your webhook, and that runs have "customer-channel restrictions", which aren't defined anywhere.
- **How I found the cause:** Read the event-subscriptions, threads and external-chat guides side by side. The only documented way to message a customer first is external chat: create a thread, take it over as a human, then post. There's no WhatsApp equivalent in the docs.
- **Fix or workaround:** The server confirms payment itself (webhook → re-verify with Paystack → update the Sheet). The agent tells the customer on their next message. The Chord event is optional and only carries a summary for the owner.
- **What Chord should change:** Define "customer-channel restrictions" in one place, and add a `reply_to: { thread_id | channel + sender_id }` option to event subscriptions so a verified payment can notify the customer in the same WhatsApp chat.

### 2. The agent answered from memory instead of calling the tools, then admitted it
- **What happened:** In the first full simulator run (29 Oct, order MTK-261029-SXMZQ), the agent quoted the correct ₦61,000 but without calling `check_stock`. It said so itself on the next turn: "I should have checked it before quoting". When the customer claimed "paid, see screenshot" before paying, it refused to confirm, which was correct, but it never called `verify_payment`. After the real payment it confirmed correctly and then apologised: "I told you the payment hadn't shown before I had actually checked."
- **How I found the cause:** The skill said "never quote a price from memory" inside a numbered flow, and the agent had seen the prices in an earlier tool result. It treated the flow as guidance. The only evidence was the agent's own words, because the simulator doesn't show tool calls.
- **Fix or workaround:** Two hard rules at the top of the skill: no price without a `check_stock` call in the same turn, and every "paid" claim gets a `verify_payment` call. The server still re-prices and re-verifies on its own, so a skipped call can never charge the wrong amount or confirm an unpaid order. The worst case is a wrong sentence. A re-test after the change (order MTK-261029-KJZGW) behaved as required. The agent reported moi moi as sold out, which it can only know from `check_stock`. It also answered an unpaid "paid" with "the system shows it as not completed", which is `verify_payment`'s result.
- **What Chord should change:** Show tool calls (name, arguments, result) in the simulator or in the thread view next to each `skill_execution_id`. Today a builder can't tell "the tool said unpaid" from "the model guessed unpaid" without server logs. A per-skill "required tools" setting would also help.

### 3. Dashboard chat with the teammate failed at billing but still took credits
- **What happened:** On 29 Oct at about 18:30 UTC, chatting with the teammate directly in the Chord dashboard returned "Billing settlement failed after the model completed; do not retry automatically". The balance was 37 of 50 credits. Two attempts each deducted credits, and neither delivered a reply.
- **How I found the cause:** The error says the model finished and only the settlement step failed. With 37 credits left, an empty balance is ruled out. The agent, skill and MCP server weren't involved: the same teammate worked end to end in the WhatsApp simulator that day, and the error comes from Chord's billing, not from a tool call. The root cause is on Chord's side and I couldn't see it.
- **Fix or workaround:** Stopped using the dashboard chat and kept testing in the simulator, which is the surface that's graded. Reported it to the TSG Labs contact with the time, the error text and the two deductions, and asked for a refund of the failed charges.
- **What Chord should change:** Don't charge for a turn that failed to settle, or refund it automatically. Show the credits each turn cost next to it, so a builder can see a double charge without comparing balances. On a tight budget, a failure that still costs credits pushes people to stop testing, which is the opposite of what an exercise wants.

---

## Smaller ones

### 4. Render deploy crash-looped on an optional setting
- **What happened:** On Render (29 Oct), the service failed at startup with `Missing or invalid config: GOOGLE_SERVICE_ACCOUNT_JSON`. The Google Sheet store was selected, but the service-account key wasn't set up yet.
- **How I found the cause:** The startup log named the variable. Config treated the Sheet's settings as required whenever `STORE=sheets`, so one optional integration blocked the whole server.
- **Fix or workaround:** Optional integrations now degrade instead of blocking. A missing or malformed Sheet config falls back to the memory store with a `config_warning` log line. A Chord event URL without its signing secret disables forwarding. Only the bearer token and the Paystack test key stop startup.
- **What Chord should change:** This one was mine. Still, Chord's MCP health check returning HTTP 200 even when it fails would have hidden a crash-looping server behind a green status. Return a non-2xx code, or show `status` prominently in the dashboard.

### 5. Paystack rejected every payment link: "email must be a valid email"
- **What happened:** On the first live smoke test (29 Oct), `create_payment_link` failed on every call with Paystack's `email must be a valid email`.
- **How I found the cause:** WhatsApp customers rarely give an email, so the server sends Paystack a placeholder built from the phone number. It used the reserved `.example` domain, which unit tests (with a faked Paystack) never exercised. Paystack validates the domain.
- **Fix or workaround:** Use a real TLD (default `example.com`), configurable through `PLACEHOLDER_EMAIL_DOMAIN`.
- **What Chord should change:** Nothing in Chord caused this, but a "test this tool" button on the MCP server page would let builders catch provider errors before spending credits on chats.

### 6. "Hand off to Tola" became Chord's silent human takeover
- **What happened:** On 30 Oct, a simulator message like "I want a party jollof small delivered tomorrow by 5pm" got no reply at all. The simulator stayed blank. In the dashboard, the teammate had posted "One moment — connecting you with a teammate." as an internal message, and Chord showed a prompt asking whether a human wanted to take over the conversation.
- **How I found the cause:** Two of my skill rules combined. "Orders need at least 24 hours' notice" made the agent treat tomorrow 5pm, asked for at 9pm, as too short (20 hours). "Hand off to Tola" then led the agent to Chord's built-in human handoff, which keeps its message inside the dashboard instead of sending my handoff sentence to the customer.
- **Fix or workaround:** The notice rule is now by calendar date: any day from tomorrow on is a normal order, and only today is same-day. The server enforces it too: `create_payment_link` refuses a same-day date with `error: "same_day"`. The skill now says to send the "Tola will reply" sentence as an ordinary reply and never to use a transfer or escalate action.
- **What Chord should change:** When the agent hands a conversation to a human, send the customer a holding message by default, and let the builder set its text. Today the customer sees silence until someone accepts the takeover, which on WhatsApp looks like the business ignored them. Also document when the model may trigger a handoff by itself, so a builder can switch it off for a skill.
