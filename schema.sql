CREATE TABLE IF NOT EXISTS events (
  call_id TEXT PRIMARY KEY,
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
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  agency TEXT NOT NULL,
  phone TEXT NOT NULL,
  name TEXT,
  tags TEXT,
  notes INTEGER DEFAULT 0,
  calls INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(agency, phone)
);
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  call_id TEXT,
  agency TEXT,
  kind TEXT NOT NULL,
  detail TEXT
);
