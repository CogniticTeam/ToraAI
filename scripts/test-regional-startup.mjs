import assert from 'node:assert/strict';
import test from 'node:test';
import { approveToraRegion, DEFAULT_TORA_SERVICE, detectToraCountry, TORA_REGIONS } from '../packages/desktop/regional-service.js';

function startup(countries, answers, state = {}) {
  const pages = [];
  const saved = [];
  const service = approveToraRegion({
    detect: async () => countries.shift(),
    state,
    save: next => saved.push({ ...next }),
    prompt: async page => {
      pages.push(page);
      assert.ok(answers.length, `Unexpected page: ${page}`);
      return answers.shift();
    },
  });
  return { service, pages, saved, state };
}

test('mainland startup keeps the notice separate from both agreements', async () => {
  const first = startup(['CN'], [0, 0, 0]);
  assert.deepEqual(await first.service, { edition: 'china', origin: TORA_REGIONS.china });
  assert.deepEqual(first.pages, ['cloudflareNotice', 'mainlandTransfer', 'globalTransfer']);
  assert.deepEqual(first.saved[0], { acceptedMainlandTransfer: true });

  const repeat = startup(['CN'], [1], first.state);
  await repeat.service;
  assert.deepEqual(repeat.pages, ['cloudflareNotice']);
  assert.equal(repeat.state.hideCloudflareNotice, true);
  const silent = startup(['CN'], [], repeat.state);
  assert.equal((await silent.service).origin, TORA_REGIONS.china);
  assert.deepEqual(silent.pages, []);
});

test('rejecting an agreement leaves it unaccepted and blocks access', async () => {
  const mainland = startup(['CN'], [1, 1]);
  assert.equal(await mainland.service, null);
  assert.deepEqual(mainland.state, { hideCloudflareNotice: true });
  const global = startup(['CN'], [0, 1], mainland.state);
  assert.equal(await global.service, null);
  assert.deepEqual(global.pages, ['mainlandTransfer', 'globalTransfer']);
  assert.equal(global.state.acceptedMainlandTransfer, true);
  assert.equal(global.state.acceptedGlobalTransfer, undefined);
});

test('Singapore skips both agreements and other overseas regions show the global agreement once', async () => {
  const singapore = startup(['SG'], []);
  assert.equal((await singapore.service).origin, DEFAULT_TORA_SERVICE);
  const overseas = startup(['US'], [0]);
  assert.equal((await overseas.service).origin, DEFAULT_TORA_SERVICE);
  assert.deepEqual(overseas.pages, ['globalTransfer']);
  assert.equal(overseas.state.acceptedMainlandTransfer, undefined);
  await startup(['HK'], [], overseas.state).service;
});

test('unknown location offers a retry or exit without entering the app', async () => {
  const retry = startup([null, 'SG'], [0]);
  assert.equal((await retry.service).origin, DEFAULT_TORA_SERVICE);
  assert.deepEqual(retry.pages, ['unverified']);
  const quit = startup([null], [1]);
  assert.equal(await quit.service, null);
  assert.deepEqual(quit.saved, []);
});

test('region probe falls back to the China endpoint without account credentials', async () => {
  const country = await detectToraCountry(async (url, options) => {
    assert.equal(options.credentials, 'omit');
    if (url === TORA_REGIONS.china + '/geo') return Response.json({ country: 'CN', regionalRouting: false });
    return Response.json({ country: 'ZZ' });
  });
  assert.equal(country, 'CN');
});
