// Run on Windows: install and launch the real unsigned NSIS package in an isolated runner directory.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import desktop from '../packages/desktop/package.json' with { type: 'json' };

if (process.platform !== 'win32') throw Error('Run this check on a Windows runner');
const exec = promisify(execFile);
if (process.argv[2] === '--engine') {
  assert.ok(process.versions.electron, 'Use the installed Electron runtime');
  const core = process.argv[3];
  const { acquireShell, disposeAllShells } = await import(pathToFileURL(join(core, 'src/tools/shell.js')));
  const { prepareShellSandbox } = await import(pathToFileURL(join(core, 'src/tools/shell-sandbox.js')));
  const directory = mkdtempSync(join(tmpdir(), 'tora-win-engine-'));
  const work = join(directory, '中文项目'); mkdirSync(work);
  assert.throws(() => prepareShellSandbox(directory, { enabled: true }), /尚无 Bash 进程沙箱/);
  const shell = acquireShell(directory, { enabled: false });
  assert.ok(shell, 'Git for Windows Bash must be available');
  try {
    const moved = await shell.run(`cd ${JSON.stringify(work)}`, 15000);
    assert.equal(moved.exitCode, 0, moved.output);
    assert.equal(realpathSync(moved.cwd).toLowerCase(), realpathSync(work).toLowerCase());
    assert.equal((await shell.run('export TORA_WIN_VALUE=retained', 10000)).exitCode, 0);
    const printed = await shell.run('printf %s "$TORA_WIN_VALUE"', 10000);
    assert.equal(printed.exitCode, 0); assert.match(printed.output, /retained/);
    assert.equal((await shell.run('false', 10000)).exitCode, 1);
  } finally { disposeAllShells(); }
  console.log('Installed engine: Git Bash, Unicode cwd, persistent environment and fail-closed sandbox verified.');
  process.exit(0);
}
const release = resolve('packages/desktop/release');
const name = `Tora-${desktop.version}-win-x64.exe`;
const installer = join(release, name); assert.ok(existsSync(installer));
const pe = readFileSync(installer); assert.equal(pe.toString('ascii', 0, 2), 'MZ');
const metadata = createRequire(import.meta.url)('js-yaml').load(readFileSync(join(release, 'latest.yml'), 'utf8'));
assert.equal(metadata.version, desktop.version);
const entry = metadata.files.find(file => file.url === name); assert.ok(entry);
assert.equal(entry.sha512, createHash('sha512').update(pe).digest('base64'));
assert.equal(entry.size, pe.length); assert.ok(existsSync(installer + '.blockmap'));
const directory = mkdtempSync(join(tmpdir(), 'tora-windows-release-'));
const install = join(directory, 'installed');
await exec(installer, ['/S', '/CURRENTUSER', `/D=${install}`], { timeout: 180000 });
const app = join(install, 'Tora.exe'); assert.ok(existsSync(app), 'NSIS must install Tora.exe');
const binary = readFileSync(app), peOffset = binary.readUInt32LE(0x3c);
assert.equal(binary.readUInt16LE(peOffset + 4), 0x8664, 'Installed app must be x64');
// Match the runner's PowerShell 7 host; its PSModulePath is incompatible with Windows PowerShell 5.
const status = execFileSync('pwsh.exe', ['-NoProfile', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${installer.replaceAll("'", "''")}').Status.ToString()`], { encoding: 'utf8' }).trim();
assert.equal(status, 'NotSigned', 'First Windows release is explicitly unsigned');
const env = { ...process.env, TORA_HOME: join(directory, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
const gui = spawn(app, [`--user-data-dir=${join(directory, 'profile')}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; gui.stdout.on('data', data => { output += data; }); gui.stderr.on('data', data => { output += data; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    assert.equal(gui.exitCode, null, `App exited: ${output}`);
    try {
      const response = await fetch('http://127.0.0.1:3210/health', { signal: AbortSignal.timeout(1000) });
      if ((await response.json()).status === 'ok') { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(ready, `App did not start: ${output}`);
  const html = await (await fetch('http://127.0.0.1:3210/')).text();
  assert.ok(html.includes('boot-splash'), 'Installed frontend must be served');
  await exec(app, [resolve('scripts/test-windows-release.mjs'), '--engine', join(install, 'resources/core')], {
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 90000,
  }).then(result => console.log(result.stdout));
  assert.equal(gui.exitCode, null, output);
  console.log(`Windows ${desktop.version}: installation, GUI startup, frontend, x64 and update SHA512 verified (${status}).`);
} finally {
  if (gui.pid) try { execFileSync('taskkill', ['/PID', String(gui.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  const uninstaller = join(install, 'Uninstall Tora.exe');
  if (existsSync(uninstaller)) await exec(uninstaller, ['/S'], { timeout: 60000 }).catch(() => {});
}
