import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireShell, disposeAllShells, normalizeShellCwd, shellPath, shellCwdExpression } from '../src/tools/shell.js';

test('Windows Bash 不使用 cmd 的 POSIX 参数，MSYS 工作路径转换为原生路径', () => {
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  assert.equal(shellPath('win32', { ProgramFiles: 'C:\\Program Files' }, path => path === bash), bash);
  assert.equal(shellPath('win32', { SHELL: 'D:\\Tools\\Git\\bin\\bash.exe' }, () => true), 'D:\\Tools\\Git\\bin\\bash.exe');
  assert.throws(() => shellPath('win32', { SHELL: 'cmd.exe' }, () => false), /Git for Windows/);
  assert.equal(normalizeShellCwd('/c/Users/test/中文项目', 'win32'), 'C:\\Users\\test\\中文项目');
  assert.equal(normalizeShellCwd('/d/', 'win32'), 'D:\\');
  assert.equal(normalizeShellCwd('/Users/test', 'darwin'), '/Users/test');
  assert.equal(shellCwdExpression('darwin', '/bin/bash'), '$PWD');
  assert.equal(shellCwdExpression('win32', bash, path => path.endsWith('usr\\bin\\cygpath.exe')), '$("C:/Program Files/Git/usr/bin/cygpath.exe" -m "$PWD")');
  assert.throws(() => shellCwdExpression('win32', bash, () => false), /cygpath/);
});

test('持久 Bash 回显 printf 时不把格式串当作结束标记', { skip: !existsSync('/bin/bash') }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tora-shell-protocol-'));
  const previousShell = process.env.SHELL;
  process.env.SHELL = '/bin/bash';
  t.after(() => {
    disposeAllShells();
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
    rmSync(directory, { recursive: true, force: true });
  });
  const shell = acquireShell(directory);
  // verbose 模式确定性模拟 Linux CI 的输入回显。
  assert.equal((await shell.run('set -v', 5000)).exitCode, 0);
  assert.equal((await shell.run('export TORA_PROTOCOL_VALUE=retained', 5000)).exitCode, 0);
  const moved = await shell.run('mkdir -p sub && cd sub', 5000);
  assert.equal(moved.exitCode, 0);
  assert.ok(moved.cwd.endsWith('/sub'));
  // 不带换行的普通输出也必须与标记正确分离。
  const printed = await shell.run('printf %s "$TORA_PROTOCOL_VALUE"', 5000);
  assert.equal(printed.exitCode, 0);
  assert.match(printed.output, /retained/);
  assert.equal((await shell.run('false', 5000)).exitCode, 1);
});
