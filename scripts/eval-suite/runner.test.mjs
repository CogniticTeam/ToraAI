import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const evaluator = fileURLToPath(new URL('../eval-work-execution.mjs', import.meta.url));

test('评测器可区分真实通过与运行器故障', t => {
  const temp = mkdtempSync(join(tmpdir(), 'tora-eval-test-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const agent = join(temp, 'fixture-agent.mjs');
  const solution = `export function parsePort(value) {
    if (!(typeof value === 'string' || Number.isInteger(value))) return null;
    const text = String(value);
    if (!/^[0-9]+$/.test(text)) return null;
    const port = Number(text);
    return port >= 1 && port <= 65535 ? port : null;
  }`;
  writeFileSync(agent, `import { writeFileSync } from 'node:fs';\nwriteFileSync('src/port.mjs', ${JSON.stringify(solution)});\n`);
  const good = spawnSync(process.execPath, [evaluator, '--runner', JSON.stringify([process.execPath, agent, '{prompt}']), '--task', 'strict-port', '--output-dir', temp], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const successDir = readdirSync(temp).find((entry) => entry.endsWith('-Agent'));
  const success = JSON.parse(readFileSync(join(temp, successDir, 'report.json'), 'utf8'));
  assert.equal(success.score, 100);
  assert.equal(success.results[0].status, 'passed');

  const broken = spawnSync(process.execPath, [evaluator, '--runner', JSON.stringify([process.execPath, '-e', 'process.exit(1)']), '--task', 'strict-port', '--name', 'broken', '--output-dir', temp], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(broken.status, 1, broken.stdout + broken.stderr);
  const failureDir = readdirSync(temp).find((entry) => entry.endsWith('-broken'));
  const failure = JSON.parse(readFileSync(join(temp, failureDir, 'report.json'), 'utf8'));
  assert.equal(failure.score, null);
  assert.equal(failure.results[0].status, 'runner-error');

  const dshAgent = join(temp, 'dsh-fixture-agent.mjs');
  writeFileSync(dshAgent, `import { writeFileSync } from 'node:fs';\nimport { execFileSync } from 'node:child_process';\nlet gitRoot = null; try { gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}\nwriteFileSync('runner-env.json', JSON.stringify({ home: process.env.DSH_HOME, mode: process.env.DSH_PERMISSION_MODE, telemetry: process.env.DSH_TELEMETRY_DISABLED, gitRoot, cwd: process.cwd() }));\nwriteFileSync('src/port.mjs', ${JSON.stringify(solution)});\n`);
  const dshMode = spawnSync(process.execPath, [evaluator, '--runner-kind', 'dsh', '--runner', JSON.stringify([process.execPath, dshAgent, '{prompt}']), '--task', 'strict-port', '--name', 'dsh-fixture', '--output-dir', temp], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(dshMode.status, 0, dshMode.stdout + dshMode.stderr);
  const dshDir = readdirSync(temp).find((entry) => entry.endsWith('-dsh-fixture'));
  const dshReport = JSON.parse(readFileSync(join(temp, dshDir, 'report.json'), 'utf8'));
  const dshEnv = JSON.parse(readFileSync(join(temp, dshDir, 'strict-port', 'workspace', 'runner-env.json'), 'utf8'));
  assert.equal(dshReport.runnerKind, 'dsh');
  assert.equal(dshReport.score, 100);
  assert.match(dshEnv.home, /dsh-home$/);
  assert.equal(dshEnv.mode, 'danger-full-access');
  assert.equal(dshEnv.telemetry, '1');
  assert.equal(dshEnv.gitRoot, null, '评测工作区不得继承父项目 Git 仓库');
  assert.ok(dshEnv.cwd.includes('tora-eval-strict-port-'));
});
