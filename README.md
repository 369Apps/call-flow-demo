# Call flow demo

A small working demo of an AI phone call flowing into a CRM, for a setup where several agencies share one system.

Live: https://call-flow-demo.news-ce2.workers.dev

Built by No BS AI as a demo. Test data only. The 555-01xx numbers are reserved test numbers.

## What it shows

1. **Voice agent.** Start a call in the browser. The agent talks out loud and you answer by voice (Chrome) or by typing.
2. **Call result to CRM.** When the call ends, one event goes to the server. It creates or updates the contact, adds tags and a note, and queues a text-back.
3. **No duplicates.** The call ID is the primary key in D1 and the insert is atomic. Send the same event again, or two copies at the same moment, and only one is processed. The duplicate gets a 200 so Vapi or Telnyx stop retrying.
4. **Per-agency routing and usage.** The dialed number picks the agency. Every event is tagged to its agency, and the page totals calls, minutes, texts and blocked duplicates per agency for billing. The same caller phone in two agencies stays two separate contacts, like two GHL sub-accounts.

## Endpoints

- `POST /api/events`: a call result from the browser or a test.
- `POST /webhooks/vapi`: Vapi `end-of-call-report` (uses `call.id`, `phoneNumber.number`, `customer.number`, `analysis`). Optional `x-vapi-secret` check.
- `POST /webhooks/telnyx`: Telnyx `call.hangup` (uses `call_session_id`, `to`, `from`).
- `GET /api/state`, `GET /api/config`, `POST /api/reset`.

All three sources go through one function, so routing and duplicate rules are the same everywhere.

## Live vs simulated, honestly

Modes switch on from secrets. No secret means simulated mode, and the page says so in the header.

| Part | Without secrets | To make it live |
|---|---|---|
| Voice | Scripted agent using the browser's own voice | `VAPI_PUBLIC_KEY`, `VAPI_ASSISTANT_ID` (load `vapi-assistant.json` into Vapi) |
| CRM | Same steps run against a D1 table that stands in for GHL | `GHL_TOKEN_AGENCY_A` + `GHL_LOCATION_AGENCY_A` (and `_AGENCY_B`), a Private Integration token per test sub-account |
| Webhooks, routing, dedupe, usage | Live on Cloudflare Workers + D1 | Already live |

In live CRM mode it calls the GHL API v2: `POST /contacts/upsert`, `POST /contacts/{id}/tags`, `POST /contacts/{id}/notes`. The `text-back-queued` tag is meant to start a GHL workflow that sends the text.

## Run the tests

```
./test.sh https://call-flow-demo.news-ce2.workers.dev
```

## Deploy

```
npx wrangler d1 execute call-flow-demo --remote --file schema.sql
npx wrangler deploy
npx wrangler secret put VAPI_PUBLIC_KEY   # optional, and the others above
```
