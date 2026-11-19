CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  course_name TEXT NOT NULL,
  subject TEXT NOT NULL,
  mode TEXT NOT NULL,
  score REAL NOT NULL,
  pending REAL NOT NULL,
  max REAL NOT NULL,
  items TEXT NOT NULL,
  started_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_profile ON sessions(profile_id, created_at DESC);
CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('draft','published')),
  json TEXT NOT NULL,
  warnings TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  key TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts ON attempts(key, ts);
CREATE TABLE IF NOT EXISTS ai_usage (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
