import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { detectMessageLanguage, translateAccountMessage, TRANSLATION_MODEL } from '../src/message-translation.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE account_messages (id TEXT PRIMARY KEY, user_id INTEGER, title TEXT, body TEXT, recalled_at TEXT);
    CREATE TABLE message_translations (message_id TEXT, target_language TEXT, title TEXT, body TEXT, PRIMARY KEY(message_id,target_language));
    CREATE TABLE message_translation_limits (user_id INTEGER PRIMARY KEY, window INTEGER, total INTEGER);
    INSERT INTO account_messages VALUES ('zh',1,'更新通知','请重新打开 CoCode。',NULL), ('en',1,'Update available','Please restart CoCode.',NULL);`);
  const DB = { prepare(sql) { return { bind(...args) { return { first: async () => sqlite.prepare(sql).get(...args) || null, run: async () => ({ meta: sqlite.prepare(sql).run(...args) }) }; } }; } };
  return { sqlite, env: { DB, MESSAGE_TRANSLATION_API_KEY: 'test-secret' } };
}
const provider = data => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] }));

test('识别中文、英文和无文字内容，忽略网址、品牌和代码', () => {
  for (const [body, language] of [['请更新 CoCode 和 API。', 'zh'], ['Please update CoCode.', 'en'], ['123 🎉 https://example.com', null], ['点击 `npm install` 开始', 'zh'], ['Please translate the word 你好 for me.', 'en']]) assert.equal(detectMessageLanguage({ title: '', body }), language);
});
test('中→中、英→英不调用模型；中→英、英→中翻译并缓存', async () => {
  const { sqlite, env } = fixture();
  try {
    let calls = 0;
    const fetcher = async (url, init) => {
      calls++;
      assert.equal(url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
      const payload = JSON.parse(init.body);
      assert.equal(payload.model, TRANSLATION_MODEL);
      assert.equal(payload.thinking.type, 'enabled');
      assert.equal(payload.reasoning_effort, 'low');
      return provider({ title: '译文标题', body: '译文正文' });
    };
    for (const language of ['zh', 'en']) {
      const same = await translateAccountMessage(env, 1, { id: language, targetLanguage: language }, fetcher);
      assert.equal(same.data.translated, false);
    }
    assert.equal(calls, 0);
    for (const [id, targetLanguage] of [['zh', 'en'], ['en', 'zh']]) {
      const input = { id, targetLanguage };
      const first = await translateAccountMessage(env, 1, input, fetcher);
      assert.equal(first.data.translated, true);
      assert.equal(first.data.targetLanguage, targetLanguage);
      assert.deepEqual(await translateAccountMessage(env, 1, input, fetcher), first);
    }
    assert.equal(calls, 2);
  } finally { sqlite.close(); }
});
test('归属与参数校验先于缓存和上游，不能翻译其他用户的消息', async () => {
  const { sqlite, env } = fixture();
  try {
    const fetcher = () => { throw Error('不应调用模型'); };
    assert.equal((await translateAccountMessage(env, 2, { id: 'zh', targetLanguage: 'en' }, fetcher)).status, 404);
    for (const input of [null, {}, { id: 'zh', targetLanguage: 'fr' }, { id: 1, targetLanguage: 'zh' }]) assert.equal((await translateAccountMessage(env, 1, input, fetcher)).status, 400);
    assert.equal((await translateAccountMessage({ DB: env.DB }, 1, { id: 'zh', targetLanguage: 'en' }, fetcher)).status, 503);
  } finally { sqlite.close(); }
});
test('错误、截断和非法译文不缓存；失败信息不包含上游密钥或详情', async () => {
  const { sqlite, env } = fixture();
  try {
    for (const fetcher of [async () => new Response('test-secret', { status: 401 }), async () => provider({ title: '', body: 'x' }), async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })), async () => { throw Error('test-secret'); }]) {
      const response = await translateAccountMessage(env, 1, { id: 'zh', targetLanguage: 'en' }, fetcher);
      assert.equal(response.status, 502);
      assert.ok(!JSON.stringify(response).includes('test-secret'));
    }
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM message_translations').get().n, 0);
  } finally { sqlite.close(); }
});
test('限流原子计数阻止超额调用，下一小时恢复', async () => {
  const { sqlite, env } = fixture();
  try {
    const window = Math.floor(Date.now() / 3600000);
    sqlite.prepare('INSERT INTO message_translation_limits VALUES (1, ?, 30)').run(window);
    const input = { id: 'zh', targetLanguage: 'en' };
    assert.equal((await translateAccountMessage(env, 1, input, () => { throw Error('不应调用'); })).status, 429);
    sqlite.prepare('UPDATE message_translation_limits SET window = ?').run(window - 1);
    assert.equal((await translateAccountMessage(env, 1, input, async () => provider({ title: 'Update', body: 'Please restart.' }))).status, 200);
  } finally { sqlite.close(); }
});

test('模型调用期间撤回消息，不写入缓存也不返回译文', async () => {
  const { sqlite, env } = fixture();
  try {
    const response = await translateAccountMessage(env, 1, { id: 'zh', targetLanguage: 'en' }, async () => {
      sqlite.exec("UPDATE account_messages SET recalled_at = 'recalled' WHERE id = 'zh'");
      return provider({ title: 'Notice', body: 'Please restart.' });
    });
    assert.equal(response.status, 404);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM message_translations').get().n, 0);
  } finally { sqlite.close(); }
});
