// Verify both platform updater manifests against the exact files to be uploaded.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import desktop from '../packages/desktop/package.json' with { type: 'json' };
const yaml = createRequire(import.meta.url)('js-yaml');
for (const [directory, manifest] of [[process.argv[2], 'latest-mac.yml'], [process.argv[3], 'latest.yml']]) {
  assert.ok(directory, 'Pass both macOS and Windows release directories');
  const root = resolve(directory), metadata = yaml.load(readFileSync(join(root, manifest), 'utf8'));
  assert.equal(metadata.version, desktop.version);
  const expected = manifest === 'latest.yml' ? [`Tora-${desktop.version}-win-x64.exe`] : [`Tora-${desktop.version}-mac.dmg`, `Tora-${desktop.version}-mac.zip`];
  assert.deepEqual(metadata.files.map(entry => entry.url).sort(), expected.sort());
  for (const entry of metadata.files) {
    assert.equal(basename(entry.url), entry.url);
    const file = join(root, entry.url), hash = createHash('sha512');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    assert.equal(entry.sha512, hash.digest('base64'), entry.url);
    assert.equal(entry.size, statSync(file).size);
    assert.ok(existsSync(file + '.blockmap'));
  }
  const primary = metadata.files.find(entry => entry.url === metadata.path); assert.ok(primary);
  assert.equal(metadata.sha512, primary.sha512);
  console.log(`Verified ${manifest}: v${metadata.version}, filenames, sizes, SHA512 and blockmaps.`);
}
