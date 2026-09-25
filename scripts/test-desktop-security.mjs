import assert from 'node:assert/strict';
import { isAppUrl, normalizeExternalHttpUrl } from '../packages/desktop/navigation-security.js';

const appOrigin = 'http://127.0.0.1:3210';
assert.equal(isAppUrl('http://127.0.0.1:3210/', appOrigin), true);
assert.equal(isAppUrl('http://127.0.0.1:3210/chat?id=1', appOrigin), true);
assert.equal(isAppUrl('http://127.0.0.1:3210.evil.example/', appOrigin), false);
assert.equal(isAppUrl('https://example.com/', appOrigin), false);
assert.equal(isAppUrl('not a url', appOrigin), false);

assert.equal(normalizeExternalHttpUrl('https://example.com/docs').startsWith('https://example.com/'), true);
assert.equal(normalizeExternalHttpUrl('http://example.com/path').startsWith('http://example.com/'), true);
for (const raw of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hello', 'mailto:test@example.com']) {
  assert.throws(() => normalizeExternalHttpUrl(raw), /不被允许/);
}

console.log('桌面导航安全规则通过');
