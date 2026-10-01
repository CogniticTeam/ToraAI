// Protect the application-only open-source boundary, including forced git adds.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const privateFiles = new Set([
  'merge-pages.js', 'docs/website-i18n.md',
  'scripts/test-account-ui.mjs', 'scripts/test-admin-ban-ui.mjs',
  'scripts/test-message-recall.mjs', 'scripts/test-new-user-messages.mjs',
  'scripts/test-polls-admin-ui.mjs',
]);
const forbidden = files.filter(file => file.startsWith('website/') || file.startsWith('docs/research/')
  || /^scripts\/(?:test|generate)-website[^/]*$/.test(file) || privateFiles.has(file));
assert.deepEqual(forbidden, [], `Private website files must not be tracked in the public repository:\n${forbidden.join('\n')}`);
console.log('Verified: tracked open-source files exclude the private website, tools and site-dependent tests.');
