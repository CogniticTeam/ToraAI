-- CoCode 投票。先备份线上 D1，再执行本文件；可重复执行。
CREATE TABLE IF NOT EXISTS poll_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO poll_settings (key, value) VALUES ('enabled', '1');
INSERT OR IGNORE INTO poll_settings (key, value) VALUES ('ip_limit_enabled', '0');
INSERT OR IGNORE INTO poll_settings (key, value) VALUES ('device_limit_enabled', '0');

CREATE TABLE IF NOT EXISTS poll_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_group_members (
  group_id TEXT NOT NULL REFERENCES poll_groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_group_members_user ON poll_group_members(user_id);

CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  start_at INTEGER NOT NULL,
  end_at INTEGER,
  type TEXT NOT NULL DEFAULT 'single' CHECK (type IN ('single', 'multiple', 'score')),
  max_selections INTEGER NOT NULL DEFAULT 1,
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'group')),
  group_id TEXT REFERENCES poll_groups(id) ON DELETE SET NULL,
  frequency TEXT NOT NULL DEFAULT 'once' CHECK (frequency IN ('once', 'daily', 'unlimited')),
  result_visibility TEXT NOT NULL DEFAULT 'live' CHECK (result_visibility IN ('live', 'after_end', 'admin')),
  show_voter_count INTEGER NOT NULL DEFAULT 1,
  show_details INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  archived_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_polls_visible ON polls(status, deleted_at, pinned, start_at, end_at);

CREATE TABLE IF NOT EXISTS poll_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id, position);

CREATE TABLE IF NOT EXISTS poll_votes (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  ip_hash TEXT,
  device_hash TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  delete_reason TEXT,
  UNIQUE (poll_id, user_id, submission_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_poll_vote_slot ON poll_votes(poll_id, user_id, slot_key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_poll_votes_history ON poll_votes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_id, deleted_at, created_at DESC);

CREATE TABLE IF NOT EXISTS poll_vote_items (
  vote_id TEXT NOT NULL REFERENCES poll_votes(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  score INTEGER CHECK (score BETWEEN 0 AND 100),
  PRIMARY KEY (vote_id, option_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_vote_items_option ON poll_vote_items(option_id);

-- 可配置的 IP/设备限制只阻止多个账户占用同一指纹；同一账户的每日/不限次数仍由 slot_key 控制。
CREATE TABLE IF NOT EXISTS poll_fraud_claims (
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('ip', 'device')),
  fingerprint TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (poll_id, kind, fingerprint)
);

CREATE TABLE IF NOT EXISTS poll_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  poll_id TEXT,
  user_id INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
