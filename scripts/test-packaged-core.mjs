// Use the packaged Electron executable with ELECTRON_RUN_AS_NODE=1 and its real Resources directory.
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.ok(process.versions.electron, 'Run with the packaged Electron runtime');
const resources = resolve(process.argv[2]);
const scratch = mkdtempSync(join(tmpdir(), 'tora-packaged-core-'));
process.env.TORA_HOME = join(scratch, 'data');
assert.ok(existsSync(join(resources, 'core/src/asapi/server.js')));
assert.ok(existsSync(join(resources, 'desktop/frontend/dist/index.html')));
const { startASAPIServer } = await import(pathToFileURL(join(resources, 'core/src/asapi/server.js')));
const server = await startASAPIServer({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
try {
  assert.equal((await (await fetch(base + '/health')).json()).status, 'ok');
  const html = await (await fetch(base)).text();
  assert.ok(html.includes('boot-splash'));
  for (const asset of [...html.matchAll(/(?:src|href)="([^" ]+\.(?:js|css)(?:\?[^" ]*)?)"/g)].map(match => match[1]).filter(value => !value.startsWith('http'))) {
    const response = await fetch(new URL(asset, base));
    assert.equal(response.status, 200, asset);
    assert.ok((await response.text()).length > 0, asset);
  }
  console.log(`Packaged Electron ${process.versions.electron}: isolated core startup, health and frontend assets passed.`);
} finally { server.close(); }
