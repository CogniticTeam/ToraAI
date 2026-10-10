CREATE TABLE IF NOT EXISTS human_verification_sessions (token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,verified_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS human_verification_expiry ON human_verification_sessions(expires_at);
CREATE TABLE IF NOT EXISTS human_verified_trial_turns (user_id INTEGER NOT NULL,message_id TEXT NOT NULL,token_hash TEXT NOT NULL,verified_at INTEGER NOT NULL,PRIMARY KEY(user_id,message_id,token_hash));
