CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY, phone TEXT, start_at TEXT, end_at TEXT,
  duration_sec INTEGER, turns_count INTEGER, api_calls_count INTEGER,
  status TEXT DEFAULT 'new', source TEXT DEFAULT 'yemot', synced_at TEXT
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, seq INTEGER,
  enter_at TEXT, exit_at TEXT, duration_sec INTEGER,
  question_path TEXT, question_sec INTEGER, answer_path TEXT, answer_transcript TEXT,
  response_sec INTEGER, api_calls INTEGER, confidence TEXT, data_missing INTEGER DEFAULT 0,
  UNIQUE(call_id, seq)
);
CREATE TABLE IF NOT EXISTS recordings (
  checksum TEXT PRIMARY KEY, call_id TEXT, turn_seq INTEGER, path TEXT,
  seconds INTEGER, recorded_at TEXT, owner TEXT DEFAULT 'user', available INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS api_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, at TEXT, extension TEXT,
  answer_type TEXT, audio_path TEXT, UNIQUE(call_id, at, extension)
);
CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, turn_seq INTEGER,
  score INTEGER, note TEXT, rated_at TEXT, superseded INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, type TEXT, severity INTEGER,
  status TEXT DEFAULT 'new', description TEXT, call_ids TEXT, root_cause TEXT,
  confidence INTEGER, created_at TEXT, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS fixes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER, description TEXT,
  proposed_change TEXT, status TEXT DEFAULT 'proposed', approved_by TEXT,
  approved_at TEXT, test_results TEXT
);
CREATE TABLE IF NOT EXISTS sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, finished_at TEXT,
  status TEXT, months_scanned TEXT, calls_new INTEGER, turns_new INTEGER, errors TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_call ON turns(call_id, seq);
CREATE INDEX IF NOT EXISTS idx_apilogs_call ON api_logs(call_id, at);
CREATE INDEX IF NOT EXISTS idx_calls_start ON calls(start_at DESC);
