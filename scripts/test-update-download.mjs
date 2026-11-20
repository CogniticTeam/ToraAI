import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const requireFrontend = createRequire(new URL('../packages/desktop/frontend/package.json', import.meta.url));
const ts = requireFrontend('typescript');
const helper = readFileSync(new URL('../packages/desktop/frontend/src/lib/updateDownload.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(helper, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { downloadMetrics, formatDownloadSpeed, formatRemainingTime } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

test('下载速度与预计时间使用真实剩余字节，缺失或无效数据不制造估计', () => {
  assert.deepEqual(downloadMetrics({ bytesPerSecond: 2_000_000, totalBytes: 200_000_000, transferredBytes: 50_000_000, progressAt: 1000 }, 1000), { speed: 2_000_000, seconds: 75 });
  for (const progress of [{}, { bytesPerSecond: 0 }, { bytesPerSecond: NaN }, { bytesPerSecond: -1 },
    { bytesPerSecond: 10, totalBytes: 0, transferredBytes: 0 },
    { bytesPerSecond: 10, totalBytes: 100, transferredBytes: 101 },
    { bytesPerSecond: 10, totalBytes: Infinity, transferredBytes: 0 },
    { bytesPerSecond: 10, totalBytes: 100 }]) {
    assert.equal(downloadMetrics(progress, 1000).seconds, null);
  }
  assert.deepEqual(downloadMetrics({ bytesPerSecond: 100, totalBytes: 100, transferredBytes: 100 }, 1000), { speed: 100, seconds: 0 });
});

test('超过五秒没有进度时归零速度，恢复进度后重新估算', () => {
  const progress = { bytesPerSecond: 100, totalBytes: 1000, transferredBytes: 200, progressAt: 1000 };
  assert.equal(downloadMetrics(progress, 5999).seconds, 8);
  assert.deepEqual(downloadMetrics(progress, 6000), { speed: 0, seconds: null });
  assert.deepEqual(downloadMetrics({ ...progress, transferredBytes: 300, progressAt: 7000 }, 7000), { speed: 100, seconds: 7 });
});

test('速度和时长适配秒、分、小时及本地化数字，不显示无穷大', () => {
  assert.equal(formatDownloadSpeed(null, 'zh'), '—');
  assert.equal(formatDownloadSpeed(0, 'en'), '0 B/s');
  assert.equal(formatDownloadSpeed(1_500_000, 'en'), '1.5 MB/s');
  assert.equal(formatDownloadSpeed(1_500_000, 'de'), '1,5 MB/s');
  assert.match(formatRemainingTime(75, 'zh'), /1分钟 15秒/);
  assert.match(formatRemainingTime(3601, 'en'), /1 hr 1 min/);
  for (const language of ['en', 'zh', 'zh-HK', 'ja-Neko', 'zh-Neko', 'lzh', 'ar', 'invalid_locale']) {
    assert.doesNotThrow(() => formatRemainingTime(75, language));
    assert.doesNotMatch(formatDownloadSpeed(2000, language), /NaN|Infinity/);
  }
});

test('主进程进度事件传递下载指标，新版本、重试和完成均清除旧指标', () => {
  const source = readFileSync(new URL('../packages/desktop/main.js', import.meta.url), 'utf8');
  const publish = source.slice(source.indexOf('function publishRequiredUpdate('), source.indexOf('\nfunction clearRequiredUpdate('));
  const setup = source.slice(source.indexOf('function setupUpdater('), source.indexOf('\nasync function checkDesktopForUpdate('));
  const updater = new EventEmitter();
  const context = vm.createContext({ app: { isPackaged: true }, process: { platform: 'darwin' }, updaterReady: false,
    autoUpdater: updater, requiredUpdate: null, win: null, setDesktopAccessBlocked() {}, loadRequiredReleaseNotes() {}, console });
  vm.runInContext(publish + '\n' + setup + '\nsetupUpdater();', context);
  updater.emit('update-available', { version: '1.1.2' });
  updater.emit('download-progress', { percent: 25, bytesPerSecond: 2_000_000, total: 200_000_000, transferred: 50_000_000 });
  assert.equal(context.requiredUpdate.bytesPerSecond, 2_000_000);
  assert.equal(context.requiredUpdate.totalBytes, 200_000_000);
  assert.equal(context.requiredUpdate.transferredBytes, 50_000_000);
  assert.ok(context.requiredUpdate.progressAt > 0);
  assert.equal(downloadMetrics(context.requiredUpdate, context.requiredUpdate.progressAt).seconds, 75);
  for (const patch of [{ status: 'error' }, { status: 'ready', percent: 100 }, { status: 'downloading', percent: 0 }]) {
    context.publishRequiredUpdate(patch);
    assert.equal(context.requiredUpdate.bytesPerSecond, null);
    assert.equal(context.requiredUpdate.progressAt, null);
  }
});
