import assert from 'node:assert/strict';

// 仅在隔离的 wrangler dev + test/admin-fixture.sql 上运行，不连接线上数据库。
const base = process.env.POLL_TEST_BASE || 'http://127.0.0.1:8792';
const adminToken = process.env.POLL_TEST_ADMIN || 'local-test-admin';
const userOne = 'local-user-one';
const userTwo = 'local-user-two';
let passed = 0;

async function call(path, token, body, method = body ? 'POST' : 'GET', ip = '198.51.100.10') {
  const response = await fetch(base + path, {
    method,
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'cf-connecting-ip': ip },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, data: type.includes('json') ? await response.json() : new Uint8Array(await response.arrayBuffer()), type };
}
const admin = (path, body, method) => call('/admin/polls' + path, adminToken, body, method);
const user = (path, token = userOne, body, ip) => call('/polls' + path, token, body, body ? 'POST' : 'GET', ip);
const ok = label => { passed++; console.log('通过：' + label); };
const template = (type = 'single', extra = {}) => ({
  title: '集成测试 ' + crypto.randomUUID().slice(0, 8), description: '真实接口测试',
  startAt: new Date(Date.now() - 60_000).toISOString(), endAt: new Date(Date.now() + 3_600_000).toISOString(),
  type, maxSelections: type === 'multiple' ? 2 : 1, audience: 'all', frequency: 'once', resultVisibility: 'live',
  showVoterCount: true, showDetails: true,
  options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }], ...extra,
});

assert.equal((await call('/admin/polls', userOne)).status, 401);
assert.equal((await call('/admin/polls', 'invalid-admin')).status, 401);
assert.equal((await admin('/')).status, 200); ok('普通账户无法访问管理接口');
assert.equal((await user('/config')).data.enabled, true);
assert.equal((await user('/config')).data.entryVisible, true);

let pollId;
try {
  assert.equal((await admin('/settings', { entryVisible: 'false' }, 'PATCH')).status, 422);
  const hiddenEntry = await admin('/settings', { entryVisible: false }, 'PATCH');
  assert.equal(hiddenEntry.status, 200);
  assert.equal(hiddenEntry.data.entryVisible, false);
  assert.equal((await user('/config')).data.entryVisible, false);
  assert.equal((await user('/')).status, 200);
  assert.equal((await admin('/settings', { entryVisible: true }, 'PATCH')).status, 200);
  assert.equal((await user('/config')).data.entryVisible, true); ok('入口显隐独立于投票功能并持久化');
  const group = await admin('/groups', { name: '测试组 ' + crypto.randomUUID().slice(0, 8) });
  assert.equal(group.status, 201, JSON.stringify(group));
  assert.equal((await admin('/groups/' + group.data.id + '/members', { userId: 900001 })).status, 200);
  const draft = await admin('/', template('single', { audience: 'group', groupId: group.data.id }));
  assert.equal(draft.status, 201, JSON.stringify(draft)); pollId = draft.data.id;
  assert.equal((await admin('/' + pollId)).data.poll.state, 'draft');
  assert.ok(!(await user('/')).data.polls.some(poll => poll.id === pollId)); ok('草稿仅管理员可见');
  assert.equal((await admin('/' + pollId + '/status', { action: 'publish' })).status, 200);
  const detail = await user('/' + pollId);
  assert.equal(detail.status, 200, JSON.stringify(detail));
  assert.equal((await user('/' + pollId, userTwo)).status, 404); ok('指定用户组和发布隔离');
  const optionId = detail.data.options[0].id;
  const submissionId = crypto.randomUUID();
  const payload = { submissionId, deviceId: crypto.randomUUID(), items: [{ optionId }] };
  const first = await user('/' + pollId + '/votes', userOne, payload);
  assert.equal(first.status, 201, JSON.stringify(first));
  const same = await user('/' + pollId + '/votes', userOne, payload);
  assert.equal(same.status, 200); assert.equal(same.data.alreadySubmitted, true);
  const duplicate = await user('/' + pollId + '/votes', userOne, { ...payload, submissionId: crypto.randomUUID() });
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate)); ok('单人一次、幂等重试与服务端唯一约束');
  assert.equal((await user('/history')).data.votes.some(vote => vote.pollId === pollId), true);
  assert.equal((await user('/' + pollId + '/results')).data.participants, 1); ok('历史记录和结果统计');
  const exported = await admin('/' + pollId + '/export?kind=summary');
  assert.equal(exported.status, 200); assert.equal(exported.data[0], 0x50); assert.equal(exported.data[1], 0x4b); ok('真实 XLSX 导出');
  const votes = await admin('/' + pollId + '/votes');
  assert.equal(votes.data.votes.length, 1);
  assert.equal((await admin('/' + pollId + '/votes/' + votes.data.votes[0].id, { reason: '测试违规' }, 'DELETE')).status, 200);
  assert.equal((await admin('/' + pollId + '/results')).data.participants, 0); ok('违规票软删除并更新统计');
  assert.equal((await user('/' + pollId + '/votes', userOne, payload)).status, 409); ok('违规记录不能被幂等重试恢复');

  const multiple = await admin('/', { ...template('multiple'), publish: true });
  assert.equal(multiple.status, 201, JSON.stringify(multiple));
  const firstAdminPage = await admin('?limit=1');
  assert.equal(firstAdminPage.status, 200);
  assert.equal(firstAdminPage.data.polls.length, 1);
  assert.equal(firstAdminPage.data.nextOffset, 1);
  const secondAdminPage = await admin('?limit=1&offset=' + firstAdminPage.data.nextOffset);
  assert.equal(secondAdminPage.status, 200);
  assert.equal(secondAdminPage.data.polls.length, 1);
  assert.notEqual(secondAdminPage.data.polls[0].id, firstAdminPage.data.polls[0].id); ok('管理端投票列表可分页读取完整数据');
  const multiDetail = await user('/' + multiple.data.id);
  const ids = multiDetail.data.options.map(option => option.id);
  assert.equal((await user('/' + multiple.data.id + '/votes', userOne, { submissionId: crypto.randomUUID(), deviceId: crypto.randomUUID(), items: ids.map(optionId => ({ optionId })) })).status, 422);
  assert.equal((await user('/' + multiple.data.id + '/votes', userOne, { submissionId: crypto.randomUUID(), deviceId: crypto.randomUUID(), items: ids.slice(0, 2).map(optionId => ({ optionId })) })).status, 201); ok('多选上限由服务端验证');

  const score = await admin('/', { ...template('score', { resultVisibility: 'after_end' }), publish: true });
  assert.equal(score.status, 201, JSON.stringify(score));
  const scoreDetail = await user('/' + score.data.id);
  assert.equal((await user('/' + score.data.id + '/results')).status, 403);
  assert.equal((await user('/' + score.data.id + '/votes', userOne, { submissionId: crypto.randomUUID(), deviceId: crypto.randomUUID(), items: scoreDetail.data.options.map((option, index) => ({ optionId: option.id, score: index * 50 })) })).status, 201);
  const scoreResults = await admin('/' + score.data.id + '/results');
  assert.equal(scoreResults.data.options[2].averageScore, 100);
  assert.equal(scoreResults.data.options[2].share, 2 / 3); ok('百分制打分与结束后公开规则');

  const daily = await admin('/', { ...template('single', { frequency: 'daily' }), publish: true });
  const dailyOption = (await user('/' + daily.data.id)).data.options[0].id;
  assert.equal((await user('/' + daily.data.id + '/votes', userOne, { submissionId: crypto.randomUUID(), deviceId: crypto.randomUUID(), items: [{ optionId: dailyOption }] })).status, 201);
  assert.equal((await user('/' + daily.data.id + '/votes', userOne, { submissionId: crypto.randomUUID(), deviceId: crypto.randomUUID(), items: [{ optionId: dailyOption }] })).status, 409); ok('每日一次限制');

  const unlimited = await admin('/', { ...template('single', { frequency: 'unlimited' }), publish: true });
  const unlimitedOption = (await user('/' + unlimited.data.id)).data.options[0].id;
  for (let index = 0; index < 2; index++) assert.equal((await user('/' + unlimited.data.id + '/votes', userOne, { submissionId: crypto.randomUUID(), deviceId: crypto.randomUUID(), items: [{ optionId: unlimitedOption }] })).status, 201);
  assert.equal((await admin('/' + unlimited.data.id + '/results')).data.participants, 2); ok('不限次数投票');

  const fraud = await admin('/', { ...template(), publish: true });
  const fraudOption = (await user('/' + fraud.data.id)).data.options[0].id;
  assert.equal((await admin('/settings', { ipLimitEnabled: true }, 'PATCH')).status, 200);
  assert.equal((await user('/' + fraud.data.id + '/votes', userOne, { submissionId: crypto.randomUUID(), deviceId: crypto.randomUUID(), items: [{ optionId: fraudOption }] }, '198.51.100.10')).status, 201);
  assert.equal((await user('/' + fraud.data.id + '/votes', userTwo, { submissionId: crypto.randomUUID(), deviceId: crypto.randomUUID(), items: [{ optionId: fraudOption }] }, '198.51.100.10')).status, 409); ok('IP 跨账户防刷限制');

  const off = await admin('/settings', { enabled: false }, 'PATCH');
  assert.equal(off.status, 200); assert.equal((await user('/config')).data.enabled, false);
  assert.equal((await user('/')).status, 403); ok('总开关由服务端实施');
} finally {
  await admin('/settings', { enabled: true, entryVisible: true, ipLimitEnabled: false, deviceLimitEnabled: false }, 'PATCH');
}
console.log(`${passed} 项投票集成测试通过`);
