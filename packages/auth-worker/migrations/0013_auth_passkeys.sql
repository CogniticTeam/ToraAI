CREATE TABLE IF NOT EXISTS auth_email_codes (
 email TEXT NOT NULL,user_id INTEGER,purpose TEXT NOT NULL,code_hash TEXT NOT NULL,
 expires_at INTEGER NOT NULL,sent_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(email,purpose)
);
CREATE TABLE IF NOT EXISTS auth_flow_limits (
 id TEXT PRIMARY KEY,window INTEGER NOT NULL,total INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS passkey_users (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,handle TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS passkeys (
 id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,public_key TEXT NOT NULL,
 counter INTEGER NOT NULL,transports TEXT NOT NULL,device_type TEXT NOT NULL,backed_up INTEGER NOT NULL,
 label TEXT NOT NULL,created_at TEXT NOT NULL,last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);
CREATE TABLE IF NOT EXISTS passkey_handoffs (
 id TEXT PRIMARY KEY,poll_hash TEXT NOT NULL,purpose TEXT NOT NULL,user_id INTEGER,
 label TEXT NOT NULL,confirmation TEXT NOT NULL,expires_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',result TEXT
);
CREATE TABLE IF NOT EXISTS passkey_challenges (
 id TEXT PRIMARY KEY,challenge TEXT NOT NULL,purpose TEXT NOT NULL,user_id INTEGER,
 flow_id TEXT NOT NULL,rp_id TEXT NOT NULL,origin TEXT NOT NULL,expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS passkey_challenge_expiry ON passkey_challenges(expires_at);
CREATE TABLE IF NOT EXISTS auth_password_resets (
 token_hash TEXT PRIMARY KEY,email TEXT NOT NULL,user_id INTEGER NOT NULL,expires_at INTEGER NOT NULL
);
