// 只把两条固定测试短句发送给智谱；密钥从标准输入读取，不保存到磁盘。
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { translateAccountMessage } from '../packages/auth-worker/src/message-translation.js';
if (process.env.COCODE_TRANSLATION_LIVE_TEST !== '1') throw Error('请显式启用 COCODE_TRANSLATION_LIVE_TEST=1');
const input = createInterface({ input: process.stdin, terminal: false });
process.stdout.write('API Key (stdin): ');
const key = await new Promise(resolve => input.once('line', line => { input.close(); resolve(line.trim()); }));
for (const targetLanguage of ['en', 'zh']) {
  const message = targetLanguage === 'en'
    ? { id: 'test', title: '更新通知', body: '请重新打开应用。' }
    : { id: 'test', title: 'Update available', body: 'Please restart the app.' };
  const DB = { prepare(sql) {
    return { bind() { return {
      first: async () => sql.includes('FROM account_messages') ? message : sql.includes('RETURNING total') ? { total: 1 } : null,
      run: async () => ({ meta: { changes: 1 } }),
    }; } };
  } };
  const result = await translateAccountMessage({ DB, MESSAGE_TRANSLATION_API_KEY: key }, 1, { id: 'test', targetLanguage });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.data.translated, true);
  assert.equal(result.data.targetLanguage, targetLanguage);
  assert.notEqual(result.data.body, message.body);
  console.log(JSON.stringify({ targetLanguage, model: result.data.model, title: result.data.title, body: result.data.body }));
}
