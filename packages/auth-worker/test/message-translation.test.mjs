import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { detectMessageLanguage, translateAccountMessage, TRANSLATION_MODEL, TRANSLATION_LANGUAGES } from '../src/message-translation.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE account_messages (id TEXT PRIMARY KEY, user_id INTEGER, title TEXT, body TEXT, recalled_at TEXT);
    CREATE TABLE message_translations (message_id TEXT, target_language TEXT, title TEXT, body TEXT, PRIMARY KEY(message_id,target_language));
    CREATE TABLE message_translation_limits (user_id INTEGER PRIMARY KEY, window INTEGER, total INTEGER);
    INSERT INTO account_messages VALUES ('zh',1,'更新通知','请重新打开 Tora。',NULL), ('en',1,'Update available','Please restart Tora.',NULL);`);
  const DB = { prepare(sql) { return { bind(...args) { return { first: async () => sqlite.prepare(sql).get(...args) || null, run: async () => ({ meta: sqlite.prepare(sql).run(...args) }) }; } }; } };
  return { sqlite, env: { DB, MESSAGE_TRANSLATION_API_KEY: 'test-secret' } };
}
const provider = data => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] }));

test('识别中文、英文和无文字内容，忽略网址、品牌和代码', () => {
  for (const [body, language] of [['请更新 Tora 和 API。', 'zh'], ['Please update Tora.', 'en'], ['123 🎉 https://example.com', null], ['点击 `npm install` 开始', 'zh'], ['Please translate the word 你好 for me.', null]]) assert.equal(detectMessageLanguage({ title: '', body }), language);
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
    for (const input of [null, {}, { id: 'zh', targetLanguage: 'unsupported' }, { id: 'zh', targetLanguage: '__proto__' }, { id: 'zh', targetLanguage: 'constructor' }, { id: 1, targetLanguage: 'zh' }]) assert.equal((await translateAccountMessage(env, 1, input, fetcher)).status, 400);
    assert.equal((await translateAccountMessage({ DB: env.DB }, 1, { id: 'zh', targetLanguage: 'en' }, fetcher)).status, 503);
  } finally { sqlite.close(); }
});

test('14 种目标语言逐一使用正确提示词、独立缓存，简繁与文言不合并', async () => {
  const { sqlite, env } = fixture();
  try {
    assert.equal(Object.keys(TRANSLATION_LANGUAGES).length, 14);
    let calls = 0;
    for (const [targetLanguage, name] of Object.entries(TRANSLATION_LANGUAGES)) {
      const id = targetLanguage === 'en' ? 'zh' : 'en';
      const input = { id, targetLanguage };
      const fetcher = async (_url, init) => {
        calls++;
        const payload = JSON.parse(init.body);
        assert.ok(payload.messages[0].content.includes(`into ${name}.`));
        assert.ok(payload.messages[0].content.includes('untrusted text'));
        return provider({ title: `${targetLanguage} title`, body: `${targetLanguage} body` });
      };
      const result = await translateAccountMessage(env, 1, input, fetcher);
      assert.equal(result.status, 200);
      assert.equal(result.data.targetLanguage, targetLanguage);
      assert.equal(result.data.translated, true);
      assert.deepEqual(await translateAccountMessage(env, 1, input, fetcher), result);
    }
    assert.equal(calls, 14);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM message_translations').get().n, 14);
    const convert = await translateAccountMessage(env, 1, { id: 'zh', targetLanguage: 'zh-Hant' }, async () => provider({ title: '更新通知', body: '請重新打開 Tora。' }));
    assert.equal(convert.data.body, '請重新打開 Tora。');
    assert.equal(convert.data.translated, true);
  } finally { sqlite.close(); }
});

test('其他语言与未知短文本不误判成英文、日文不误判成中文，混合标题不短路', async () => {
  const { sqlite, env } = fixture();
  try {
    for (const body of ['Bonjour, veuillez redémarrer l’application.', 'こんにちは。アプリを再起動してください。', '안녕하세요', 'مرحبا', 'Привет', 'Hello']) {
      assert.equal(detectMessageLanguage({ title: '', body }), null);
      sqlite.prepare('UPDATE account_messages SET title=?,body=? WHERE id=?').run('Notice', body, 'en');
      const result = await translateAccountMessage(env, 1, { id: 'en', targetLanguage: 'en' }, async () => provider({ title: 'Notice', body: 'Please restart the application.' }));
      assert.equal(result.status, 200);
      sqlite.exec('DELETE FROM message_translations');
    }
    assert.equal(detectMessageLanguage({ title: 'Please restart', body: '请重新打开应用。' }), null);
    assert.equal(detectMessageLanguage({ title: '更新通知', body: '請重新打開應用。' }), 'zh-Hant');
    assert.equal(detectMessageLanguage({ title: '更新通知', body: '请重新打开应用。' }), 'zh');
  } finally { sqlite.close(); }
});

test('模型判断同语言返回原文时，标记无需翻译并缓存，纯符号无需调用模型', async () => {
  const { sqlite, env } = fixture();
  try {
    const original = { title: 'Bonjour', body: 'Veuillez redémarrer votre application.' };
    sqlite.prepare('UPDATE account_messages SET title=?,body=? WHERE id=?').run(original.title, original.body, 'en');
    let calls = 0;
    const fetcher = async () => { calls++; return provider(original); };
    const input = { id: 'en', targetLanguage: 'fr' };
    const result = await translateAccountMessage(env, 1, input, fetcher);
    assert.equal(result.data.translated, false);
    assert.deepEqual(await translateAccountMessage(env, 1, input, fetcher), result);
    assert.equal(calls, 1);
    sqlite.prepare('UPDATE account_messages SET title=?,body=? WHERE id=?').run('🎉', '123 https://example.com', 'zh');
    assert.equal((await translateAccountMessage(env, 1, { id: 'zh', targetLanguage: 'ja' }, fetcher)).data.translated, false);
    assert.equal(calls, 1);
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

test('模型调用期间编辑原文，不缓存过期译文', async () => {
  const { sqlite, env } = fixture();
  try {
    const response = await translateAccountMessage(env, 1, { id: 'zh', targetLanguage: 'en' }, async () => {
      sqlite.prepare('UPDATE account_messages SET title = ?, body = ? WHERE id = ?').run('已编辑通知', '内容已经更新。', 'zh');
      return provider({ title: 'Outdated translation', body: 'Old body.' });
    });
    assert.equal(response.status, 409);
    assert.equal(response.data.code, 'MESSAGE_CHANGED');
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM message_translations').get().n, 0);
  } finally { sqlite.close(); }
});
