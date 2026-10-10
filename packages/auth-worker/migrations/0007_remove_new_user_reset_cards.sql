CREATE TABLE IF NOT EXISTS quota_settings (id INTEGER PRIMARY KEY CHECK(id=1),new_user_cards_enabled INTEGER NOT NULL DEFAULT 0 CHECK(new_user_cards_enabled IN (0,1)),updated_at INTEGER NOT NULL);
INSERT OR IGNORE INTO quota_settings(id,new_user_cards_enabled,updated_at) VALUES(1,0,CAST(strftime('%s','now') AS INTEGER)*1000);
UPDATE quota_settings SET new_user_cards_enabled=0,updated_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE new_user_cards_enabled<>0;
DROP TRIGGER IF EXISTS quota_new_user_card;
