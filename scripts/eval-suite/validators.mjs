import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function source(cwd, filename) {
  return import(pathToFileURL(join(cwd, 'src', filename)).href + `?eval=${Date.now()}-${Math.random()}`);
}

export async function validate(taskId, cwd) {
  if (taskId === 'strict-port') {
    const { parsePort } = await source(cwd, 'port.mjs');
    for (const [input, expected] of [['1', 1], [65535, 65535], ['080', 80], ['0', null], ['65536', null], ['42x', null], ['3.5', null], ['', null], [null, null], [2.5, null]]) {
      assert.equal(parsePort(input), expected, `parsePort(${JSON.stringify(input)})`);
    }
    return;
  }
  if (taskId === 'inventory-receipt') {
    const { reserve } = await source(cwd, 'inventory.mjs');
    const { buildReceipt } = await source(cwd, 'receipt.mjs');
    const original = [{ sku: 'A', stock: 5 }, { sku: 'B', stock: 2 }];
    const next = reserve(original, 'A', 3);
    assert.deepEqual(next, [{ sku: 'A', stock: 2 }, { sku: 'B', stock: 2 }]);
    assert.deepEqual(original, [{ sku: 'A', stock: 5 }, { sku: 'B', stock: 2 }], '不能修改原数组或对象');
    assert.notEqual(next, original, '必须返回新数组');
    assert.throws(() => reserve(original, 'A', 6), RangeError);
    assert.throws(() => reserve(original, 'A', 0));
    assert.throws(() => reserve(original, 'A', 1.5));
    assert.throws(() => reserve(original, 'missing', 1));
    assert.deepEqual(buildReceipt([{ name: 'A', unitPrice: 12, quantity: 2 }, { name: 'B', unitPrice: 3, quantity: 1 }]), {
      lines: [{ name: 'A', unitPrice: 12, quantity: 2, amount: 24 }, { name: 'B', unitPrice: 3, quantity: 1, amount: 3 }],
      total: 27,
    });
    assert.deepEqual(buildReceipt([]), { lines: [], total: 0 });
    return;
  }
  if (taskId === 'red-to-green') {
    const fixtures = JSON.parse(readFileSync(new URL('./tasks.json', import.meta.url), 'utf8'));
    const original = fixtures.find(task => task.id === taskId).files['test/display-name.test.mjs'];
    assert.ok(readFileSync(join(cwd, 'test', 'display-name.test.mjs'), 'utf8').includes(original.trim()), '原有测试必须保留');
    const { formatDisplayName } = await source(cwd, 'display-name.mjs');
    for (const [input, expected] of [[null, '访客'], [undefined, '访客'], ['', '访客'], ['  \t  ', '访客'], ['  张\t三\n四  ', '张 三 四']]) {
      assert.equal(formatDisplayName(input), expected, `formatDisplayName(${JSON.stringify(input)})`);
    }
    const result = spawnSync('npm', ['test'], { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, `原有测试未通过：${String(result.stderr || result.stdout).slice(-700)}`);
    return;
  }
  throw new Error(`未知任务：${taskId}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await validate(process.argv[2], process.cwd());
    console.log('\nTORA_EVAL_PASSED');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
