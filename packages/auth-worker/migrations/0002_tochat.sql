CREATE TABLE IF NOT EXISTS tochat_turns (
  user_id INTEGER NOT NULL, message_id TEXT NOT NULL, day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('chat','work')), fingerprint TEXT NOT NULL,
  counted INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'new',
  rounds INTEGER NOT NULL DEFAULT 0, current_request TEXT, expected_tools TEXT,
  created_at INTEGER NOT NULL, PRIMARY KEY(user_id,message_id)
);
CREATE INDEX IF NOT EXISTS tochat_turn_day ON tochat_turns(user_id,day,kind,counted);
CREATE TABLE IF NOT EXISTS tochat_requests (
  user_id INTEGER NOT NULL, request_id TEXT NOT NULL, message_id TEXT NOT NULL,
  day TEXT NOT NULL, week TEXT NOT NULL, kind TEXT NOT NULL,
  charged INTEGER NOT NULL CHECK(charged >= 0), status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL, finished_at INTEGER,
  PRIMARY KEY(user_id,request_id)
);
CREATE INDEX IF NOT EXISTS tochat_request_day ON tochat_requests(user_id,day,kind);
CREATE INDEX IF NOT EXISTS tochat_request_week ON tochat_requests(user_id,week,kind);
CREATE TRIGGER IF NOT EXISTS tochat_turn_quota BEFORE INSERT ON tochat_turns
WHEN NEW.kind='chat' AND NOT EXISTS(SELECT 1 FROM tochat_turns WHERE user_id=NEW.user_id AND message_id=NEW.message_id)
BEGIN
 SELECT CASE WHEN (SELECT COALESCE(SUM(counted),0) FROM tochat_turns WHERE user_id=NEW.user_id AND day=NEW.day AND kind='chat') >= 150 THEN RAISE(ABORT,'TOCHAT_CHAT_LIMIT') END;
END;
CREATE TRIGGER IF NOT EXISTS tochat_request_quota BEFORE INSERT ON tochat_requests
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM tochat_turns WHERE user_id=NEW.user_id AND message_id=NEW.message_id AND current_request=NEW.request_id AND state='active') THEN RAISE(ABORT,'TOCHAT_TURN_BUSY_OR_DONE') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM tochat_requests WHERE user_id=NEW.user_id AND status='pending') >= 2 THEN RAISE(ABORT,'TOCHAT_CONCURRENT_LIMIT') END;
 SELECT CASE WHEN NEW.kind='work' AND NEW.charged+(SELECT COALESCE(SUM(charged),0) FROM tochat_requests WHERE user_id=NEW.user_id AND day=NEW.day AND kind='work') > 1000000 THEN RAISE(ABORT,'TOCHAT_DAY_LIMIT') END;
 SELECT CASE WHEN NEW.kind='work' AND NEW.charged+(SELECT COALESCE(SUM(charged),0) FROM tochat_requests WHERE user_id=NEW.user_id AND week=NEW.week AND kind='work') > 10000000 THEN RAISE(ABORT,'TOCHAT_WEEK_LIMIT') END;
END;
