-- 仅用于隔离的本地 Wrangler 数据库。
INSERT OR REPLACE INTO users (id,email,username,salt,hash,created_at,banned,ban_reason)
VALUES (900001,'admin-test-one@example.invalid','管理测试一','test','test','2026-09-21T00:00:00Z',0,''),
       (900002,'admin-test-two@example.invalid','管理测试二','test','test','2026-09-21T00:00:00Z',0,'');
INSERT OR REPLACE INTO sessions (token,user_id,expires_at)
VALUES ('local-user-one',900001,4102444800000),('local-user-two',900002,4102444800000);
