import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { prepareShellSandbox } from '../../packages/core/src/tools/shell-sandbox.js';

const REPOSITORY = 'https://github.com/jkoppel/QuixBugs';
const IDS = ['find_in_sorted', 'mergesort', 'wrap'];

export function loadQuixBugs(root, revision, python) {
  if (!/^[a-f0-9]{40}$/.test(revision || '') || !root || !python) {
    throw new Error('QuixBugs 评测需要 --dataset-dir、--dataset-revision 和 --python');
  }
  const pythonExecutable = resolve(python);
  const dataset = { name: 'QuixBugs Python', source: `${REPOSITORY}/tree/${revision}`, revision, inputs: {} };
  const tasks = IDS.map(id => {
    const target = `python_programs/${id}.py`;
    const test = `python_testcases/test_${id}.py`;
    const files = Object.fromEntries(['LICENSE', 'conftest.py', 'python_testcases/load_testdata.py',
      target, test, `json_testcases/${id}.json`].map(file => {
        const content = readFileSync(join(root, file), 'utf8');
        dataset.inputs[file] = createHash('sha256').update(content).digest('hex');
        return [file, content];
      }));
    return {
      id, target, test, files,
      prompt: `修复公开 QuixBugs 中的 ${target}。请先用 python3 -m pytest -q ${test} 复现失败，再修改目标文件并运行同一条命令确认。保留函数名、参数和上游测试，只修改目标 Python 文件。`,
    };
  });
  return { tasks, dataset, python: pythonExecutable };
}

export function gradeQuixBugs(task, workspace, python, env) {
  const candidate = join(workspace, task.target);
  try {
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.size > 1024 * 1024 ||
        realpathSync(candidate) !== join(realpathSync(workspace), task.target)) {
      return { error: '候选文件无效', tests: null };
    }
  } catch { return { error: '候选文件不存在', tests: null }; }
  const isolated = mkdtempSync(join(tmpdir(), 'tora-quixbugs-score-'));
  let launch;
  try {
    for (const [path, original] of Object.entries(task.files)) {
      const output = join(isolated, path);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, path === task.target ? readFileSync(candidate) : original);
    }
    launch = prepareShellSandbox(isolated, { enabled: process.platform === 'darwin', networkAccess: false });
    const args = ['-m', 'pytest', '-q', '--tb=no', '-p', 'no:cacheprovider', task.test];
    const result = spawnSync(launch.executable || python, launch.executable ? [...launch.args, python, ...args] : args, {
      cwd: isolated, env: { ...env, ...launch.env, PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1', PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
    const output = String(result.stdout || '');
    const passed = Number(/(\d+) passed/.exec(output)?.[1] || 0);
    const failed = Number(/(\d+) failed/.exec(output)?.[1] || 0);
    if (result.error || result.signal || ![0, 1, 2].includes(result.status)) {
      throw Error(`QuixBugs 验收进程失败：${result.error?.code || result.signal || result.status}`);
    }
    const expected = task.files[`json_testcases/${task.id}.json`].trim().split('\n').length;
    const tests = { passed, failed, expected };
    return result.status === 0 && passed === expected
      ? { error: null, tests }
      : { error: `官方测试通过 ${passed}/${expected} 项`, tests };
  } finally {
    launch?.cleanup();
    rmSync(isolated, { recursive: true, force: true });
  }
}
