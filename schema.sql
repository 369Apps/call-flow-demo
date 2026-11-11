-- Per-visitor sandbox: every row is scoped to a session_id.
-- Webhook events from Vapi or Telnyx use the reserved session "_webhooks".

CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  source TEXT NOT NULL,
  agency TEXT NOT NULL,
  dialed TEXT NOT NULL,
  caller_phone TEXT,
  caller_name TEXT,
  outcome TEXT,
  summary TEXT,
  duration_sec INTEGER DEFAULT 0,
  texts_queued INTEGER DEFAULT 0,
  dup_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, call_id)
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agency TEXT NOT NULL,
  phone TEXT NOT NULL,
  name TEXT,
  tags TEXT,
  notes INTEGER DEFAULT 0,
  calls INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, agency, phone)
);
CREATE INDEX IF NOT EXISTS idx_contacts_session ON contacts(session_id);

CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  call_id TEXT,
  agency TEXT,
  kind TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_log_session ON log(session_id, id);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
