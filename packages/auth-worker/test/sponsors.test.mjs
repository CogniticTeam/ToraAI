import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { querySponsorPage, shanghaiMonthBounds, signSponsorQuery } from '../src/sponsors.js';

const md5 = data => createHash('md5').update(data).digest();
const creatorId = 'a'.repeat(32);
const seconds = value => Date.parse(value) / 1000;

test('北京时间月界限在 UTC 前一日 16:00 切换', () => {
  assert.equal(shanghaiMonthBounds(Date.parse('2026-08-31T15:59:59Z')).month, '2026-08');
  assert.deepEqual(shanghaiMonthBounds(Date.parse('2026-08-31T16:00:00Z')), {
    month: '2026-09',
    startSeconds: seconds('2026-08-31T16:00:00Z'),
    endSeconds: seconds('2026-09-30T16:00:00Z'),
  });
});

test('爱发电签名只发送 user_id、params、ts、sign，不发送 Token', async () => {
  const payload = await signSponsorQuery('abc', '123', 2, 1624339905, md5);
  assert.deepEqual(Object.keys(payload), ['user_id', 'params', 'ts', 'sign']);
  assert.equal(payload.params, '{"page":2}');
  assert.equal(payload.sign, createHash('md5').update('123params{"page":2}ts1624339905user_idabc').digest('hex'));
  assert.ok(!JSON.stringify(payload).includes('"token"'));
});

test('只返回本月赞助者昵称，不暴露历史用户、用户 ID、金额、签名或 Token', async () => {
  let upstreamRequest;
  const page = await querySponsorPage({ AFD_USER_ID: creatorId, AFD_TOKEN: 'private-token' }, 1, {
    now: Date.parse('2026-09-27T04:00:00Z'),
    digest: md5,
    fetcher: async (_url, init) => {
      upstreamRequest = JSON.parse(init.body);
      return Response.json({ ec: 200, data: { total_page: 2, total_count: 21, list: [
        { user: { user_id: 'sponsor-1', name: '第一位赞助者', avatar: 'https://example.com/photo.jpg' }, last_pay_time: seconds('2026-08-31T16:00:00Z'), all_sum_amount: '20.00' },
        { user: { user_id: 'sponsor-2', name: ' 第二位赞助者 ' }, last_pay_time: seconds('2026-09-27T03:00:00Z'), all_sum_amount: '0.00' },
        { user: { user_id: 'old', name: '历史赞助者' }, last_pay_time: seconds('2026-08-31T15:59:59Z') },
        { user: { user_id: 'future', name: '下月赞助者' }, last_pay_time: seconds('2026-09-30T16:00:00Z') },
        { user: { user_id: 'unknown', name: '无付款时间' } },
      ] } });
    },
  });
  assert.deepEqual(page, { page: 1, month: '2026-09', hasMore: true, supporters: [{ name: '第一位赞助者' }, { name: '第二位赞助者' }] });
  assert.equal(upstreamRequest.user_id, creatorId);
  assert.ok(!JSON.stringify(upstreamRequest).includes('private-token'));
  assert.ok(!JSON.stringify(page).includes('sponsor-1'));
});

test('上游失败不回显可能含有签名或密钥的原始响应', async () => {
  await assert.rejects(querySponsorPage({ AFD_USER_ID: creatorId, AFD_TOKEN: 'private-token' }, 3, {
    digest: md5,
    fetcher: async () => Response.json({ ec: 400005, em: 'sign validation failed', data: { request: { sign: 'sensitive' } } }),
  }), error => error.code === 'upstream_ec_400005' && !String(error).includes('sensitive'));
});

test('错误长度的创作者 ID 在请求上游前被拒绝', async () => {
  await assert.rejects(querySponsorPage({ AFD_USER_ID: 'a'.repeat(31), AFD_TOKEN: 'private-token' }, 1, {
    fetcher: async () => { throw new Error('不应请求上游'); },
  }), error => error.code === 'invalid_user_id_length');
});
