CREATE TABLE IF NOT EXISTS doubao_work_turns (
 user_id INTEGER NOT NULL, message_id TEXT NOT NULL, day TEXT NOT NULL,
 fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,message_id)
);
CREATE INDEX IF NOT EXISTS doubao_work_turn_day ON doubao_work_turns(user_id,day);
-- Costs are reserved conservatively in nanoyuan; successful/unknown requests retain the reservation.
CREATE TABLE IF NOT EXISTS doubao_work_requests (
 user_id INTEGER NOT NULL, request_id TEXT NOT NULL, message_id TEXT NOT NULL, day TEXT NOT NULL,
 cost_nano INTEGER NOT NULL CHECK(cost_nano>=0), status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,request_id)
);
CREATE INDEX IF NOT EXISTS doubao_work_request_day ON doubao_work_requests(user_id,day);
CREATE INDEX IF NOT EXISTS doubao_work_request_turn ON doubao_work_requests(user_id,message_id);
CREATE TRIGGER IF NOT EXISTS doubao_work_turn_limit BEFORE INSERT ON doubao_work_turns BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM doubao_work_turns WHERE user_id=NEW.user_id AND message_id=NEW.message_id AND fingerprint<>NEW.fingerprint) THEN RAISE(ABORT,'DOUBAO_WORK_ID_REUSED') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM doubao_work_turns WHERE user_id=NEW.user_id AND message_id=NEW.message_id) AND (SELECT COUNT(*) FROM doubao_work_turns WHERE user_id=NEW.user_id AND day=NEW.day)>=10 THEN RAISE(ABORT,'DOUBAO_WORK_DAY_LIMIT') END;
END;
CREATE TRIGGER IF NOT EXISTS doubao_work_request_limit BEFORE INSERT ON doubao_work_requests BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM doubao_work_turns WHERE user_id=NEW.user_id AND message_id=NEW.message_id) THEN RAISE(ABORT,'DOUBAO_WORK_TURN_REQUIRED') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM doubao_work_requests WHERE user_id=NEW.user_id AND message_id=NEW.message_id)>=8 THEN RAISE(ABORT,'DOUBAO_WORK_ROUND_LIMIT') END;
 SELECT CASE WHEN NEW.cost_nano+(SELECT COALESCE(SUM(cost_nano),0) FROM doubao_work_requests WHERE user_id=NEW.user_id AND day=NEW.day)>200000000 THEN RAISE(ABORT,'DOUBAO_WORK_BUDGET_LIMIT') END;
END;
