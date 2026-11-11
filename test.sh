#!/usr/bin/env bash
# End-to-end smoke test. Usage: ./test.sh [base_url]
set -euo pipefail
B=${1:-https://call-flow-demo.news-ce2.workers.dev}
S_API="test_api_$(date +%s)"
S_A="iso_sessA_$(date +%s)"
S_B="iso_sessB_$(date +%s)"

P() { # usage: P session path json
  # No trailing echo: grep -q closes the pipe early, and pipefail would treat echo's SIGPIPE as failure.
  curl -sS -X POST "$B$2" -H 'content-type: application/json' -H "x-demo-session: $1" -d "$3"
}
G() { # usage: G session path
  curl -sS "$B$2" -H "x-demo-session: $1"
}
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== reset test session"
P "$S_API" /api/reset '{}' | grep -q '"status": "reset"' || fail "reset did not return reset"

echo "== config"
curl -s "$B/api/config" | grep -q '"agencies"' || fail "config missing agencies"
echo "ok"

ID="test_$(date +%s)"
EV='{"source":"test","call_id":"'$ID'","dialed":"+15550100001","caller_phone":"+15550109001","caller_name":"Test Caller","outcome":"callback","summary":"Asked about a quote.","duration_sec":62}'
echo "== first event (expect processed)"
P "$S_API" /api/events "$EV" | grep -E '"status"|"step"' | grep -q '"processed"' || fail "first event not processed"

echo "== same event again (expect duplicate)"
P "$S_API" /api/events "$EV" | grep '"status"' | grep -q '"duplicate"' || fail "retry was not a duplicate"

CID="test_conc_$(date +%s)"
EV2='{"source":"test","call_id":"'$CID'","dialed":"+15550100002","caller_phone":"+15550109002","caller_name":"Second Caller","outcome":"handled","summary":"Hours question.","duration_sec":30}'
echo "== 2 copies at once to Agency B (expect 1 processed, 1 duplicate)"
OUT=$( ( P "$S_API" /api/events "$EV2" & P "$S_API" /api/events "$EV2" & wait ) )
echo "$OUT" | grep '"status"'
echo "$OUT" | grep -q '"processed"' || fail "concurrent pair had no processed"
echo "$OUT" | grep -q '"duplicate"' || fail "concurrent pair had no duplicate"

echo "== Vapi end-of-call-report shape (no session header; must still work)"
VAPI='{"message":{"type":"end-of-call-report","call":{"id":"vapi_test_'$ID'"},"phoneNumber":{"number":"+15550100002"},"customer":{"number":"+15550109001"},"analysis":{"summary":"Wants a callback about pricing.","structuredData":{"caller_name":"Test Caller","wants_callback":true}},"durationSeconds":95}}'
curl -s -X POST "$B/webhooks/vapi" -H 'content-type: application/json' -d "$VAPI" | tee /tmp/cfd_vapi.json | grep -E '"status"|"agency"'
grep -q '"processed"' /tmp/cfd_vapi.json || fail "vapi webhook not processed"

echo "== Vapi retry of same report (expect duplicate)"
curl -s -X POST "$B/webhooks/vapi" -H 'content-type: application/json' -d "$VAPI" | tee /tmp/cfd_vapi2.json | grep '"status"'
grep -q '"duplicate"' /tmp/cfd_vapi2.json || fail "vapi retry was not a duplicate"

echo "== Telnyx call.hangup shape"
TX='{"data":{"event_type":"call.hangup","payload":{"call_session_id":"tx_'$ID'","to":"+15550100001","from":"+15550109003","hangup_cause":"normal_clearing","start_time":"2026-11-11T05:00:00Z","end_time":"2026-11-11T05:01:30Z"}}}'
curl -s -X POST "$B/webhooks/telnyx" -H 'content-type: application/json' -d "$TX" | tee /tmp/cfd_tx.json | grep -E '"status"|"agency"'
grep -q '"processed"' /tmp/cfd_tx.json || fail "telnyx webhook not processed"

echo "== repeat caller on Agency A, new call ID (expect contact updated, not created)"
P "$S_API" /api/events '{"source":"test","call_id":"'$ID'_b","dialed":"+15550100001","caller_phone":"+15550109001","caller_name":"Test Caller","outcome":"callback","summary":"Called back again.","duration_sec":20}' | tee /tmp/cfd_upd.json | grep -E '"status"|"step"'
grep -q '"contact updated"' /tmp/cfd_upd.json || fail "repeat caller did not update contact"

echo "== unknown number (expect rejected)"
P "$S_API" /api/events '{"call_id":"x_'$ID'","dialed":"+15550100999","caller_phone":"+15550109001"}' | grep -E '"status"|"reason"' | grep -q '"rejected"' || fail "unknown number not rejected"

echo "== events without a session are rejected (browser API only)"
curl -s -X POST "$B/api/events" -H 'content-type: application/json' -d "$EV" | grep -q 'missing or invalid' || fail "events without session should 400"

echo "== state for the test session"
G "$S_API" /api/state | python3 -c '
import sys,json; s=json.load(sys.stdin)
assert "error" not in s, s
print("events:",len(s["events"]),"contacts:",len(s["contacts"]))
for b in s["billing"]: print("billing",b)
for c in s["contacts"]: print("contact",c["agency"],c["phone"],c["name"],"calls",c["calls"],"notes",c["notes"],c["tags"])
assert len(s["contacts"])==2, s["contacts"]
phones = {(c["agency"], c["phone"]) for c in s["contacts"]}
assert ("agency_a","+15550109001") in phones
assert ("agency_b","+15550109002") in phones
a = next(c for c in s["contacts"] if c["agency"]=="agency_a")
assert a["calls"]==2 and a["notes"]==2
'
echo "ok"

echo "== two-session isolation"
P "$S_A" /api/reset '{}' >/dev/null
P "$S_B" /api/reset '{}' >/dev/null
ISOA='{"source":"test","call_id":"isoA_'$ID'","dialed":"+15550100001","caller_phone":"+15550109111","caller_name":"Session A Caller","outcome":"callback","summary":"A only.","duration_sec":15}'
P "$S_A" /api/events "$ISOA" | grep -q '"processed"' || fail "session A event not processed"
# B must not see A's contact
G "$S_B" /api/state | python3 -c '
import sys,json; s=json.load(sys.stdin)
assert s["contacts"]==[] and s["events"]==[] and s["log"]==[] and s["billing"]==[], s
print("session B is empty while A has data: ok")
'
ISOB='{"source":"test","call_id":"isoB_'$ID'","dialed":"+15550100002","caller_phone":"+15550109222","caller_name":"Session B Caller","outcome":"handled","summary":"B only.","duration_sec":10}'
P "$S_B" /api/events "$ISOB" | grep -q '"processed"' || fail "session B event not processed"
G "$S_A" /api/state > /tmp/cfd_iso_a.json
G "$S_B" /api/state > /tmp/cfd_iso_b.json
python3 -c '
import json,sys
a=json.load(open("/tmp/cfd_iso_a.json")); b=json.load(open("/tmp/cfd_iso_b.json"))
assert len(a["contacts"])==1 and a["contacts"][0]["name"]=="Session A Caller", a
assert len(b["contacts"])==1 and b["contacts"][0]["name"]=="Session B Caller", b
assert a["contacts"][0]["phone"]!=b["contacts"][0]["phone"]
print("each session sees only its own contact: ok")
'
# Reset A must not touch B
P "$S_A" /api/reset '{}' | grep -q '"reset"' || fail "reset A failed"
G "$S_A" /api/state > /tmp/cfd_iso_a.json
G "$S_B" /api/state > /tmp/cfd_iso_b.json
python3 -c '
import json
a=json.load(open("/tmp/cfd_iso_a.json")); b=json.load(open("/tmp/cfd_iso_b.json"))
assert a["contacts"]==[] and a["events"]==[], a
assert len(b["contacts"])==1 and b["contacts"][0]["name"]=="Session B Caller", b
print("reset A left session B intact: ok")
'

echo "== cleanup test sessions"
P "$S_API" /api/reset '{}' >/dev/null
P "$S_A" /api/reset '{}' >/dev/null
P "$S_B" /api/reset '{}' >/dev/null
echo "ALL TESTS PASSED"
