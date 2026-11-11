#!/usr/bin/env bash
# End-to-end smoke test. Usage: ./test.sh [base_url]
set -e
B=${1:-https://call-flow-demo.news-ce2.workers.dev}
P() { curl -s -X POST "$B$1" -H 'content-type: application/json' -d "$2"; echo; }
echo "== reset"; P /api/reset '{}'
echo "== config"; curl -s $B/api/config; echo
ID="test_$(date +%s)"
EV='{"source":"test","call_id":"'$ID'","dialed":"+15550100001","caller_phone":"+15550109001","caller_name":"Test Caller","outcome":"callback","summary":"Asked about a quote.","duration_sec":62}'
echo "== first event (expect processed)"; P /api/events "$EV" | grep -E '"status"|"step"'
echo "== same event again (expect duplicate)"; P /api/events "$EV" | grep '"status"'
CID="test_conc_$(date +%s)"
EV2='{"source":"test","call_id":"'$CID'","dialed":"+15550100002","caller_phone":"+15550109002","caller_name":"Second Caller","outcome":"handled","summary":"Hours question.","duration_sec":30}'
echo "== 2 copies at once to Agency B (expect 1 processed, 1 duplicate)"
( P /api/events "$EV2" | grep '"status"' & P /api/events "$EV2" | grep '"status"' & wait )
echo "== Vapi end-of-call-report shape"
VAPI='{"message":{"type":"end-of-call-report","call":{"id":"vapi_test_'$ID'"},"phoneNumber":{"number":"+15550100002"},"customer":{"number":"+15550109001"},"analysis":{"summary":"Wants a callback about pricing.","structuredData":{"caller_name":"Test Caller","wants_callback":true}},"durationSeconds":95}}'
P /webhooks/vapi "$VAPI" | grep -E '"status"|"agency"'
echo "== Vapi retry of same report (expect duplicate)"; P /webhooks/vapi "$VAPI" | grep '"status"'
echo "== Telnyx call.hangup shape"
TX='{"data":{"event_type":"call.hangup","payload":{"call_session_id":"tx_'$ID'","to":"+15550100001","from":"+15550109003","hangup_cause":"normal_clearing","start_time":"2026-11-11T05:00:00Z","end_time":"2026-11-11T05:01:30Z"}}}'
P /webhooks/telnyx "$TX" | grep -E '"status"|"agency"'
echo "== repeat caller on Agency A, new call ID (expect contact updated, not created)"
P /api/events '{"source":"test","call_id":"'$ID'_b","dialed":"+15550100001","caller_phone":"+15550109001","caller_name":"Test Caller","outcome":"callback","summary":"Called back again.","duration_sec":20}' | grep -E '"status"|"step"'
echo "== unknown number (expect rejected)"; P /api/events '{"call_id":"x_'$ID'","dialed":"+15550100999","caller_phone":"+15550109001"}' | grep -E '"status"|"reason"'
echo "== state"
curl -s $B/api/state | python3 -c '
import sys,json; s=json.load(sys.stdin)
print("events:",len(s["events"]),"contacts:",len(s["contacts"]))
for b in s["billing"]: print("billing",b)
for c in s["contacts"]: print("contact",c["agency"],c["phone"],c["name"],"calls",c["calls"],"notes",c["notes"],c["tags"])'
