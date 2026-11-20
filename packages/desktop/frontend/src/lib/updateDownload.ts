export type DownloadProgress = {
  bytesPerSecond?: number | null;
  totalBytes?: number | null;
  transferredBytes?: number | null;
  progressAt?: number | null;
};

const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function downloadMetrics(progress: DownloadProgress, now: number) {
  // 没有新的字节进度时停止展示旧网速，也不继续倒数一个虚假的完成时间。
  const stalled = nonnegative(progress.progressAt) && now - progress.progressAt >= 5_000;
  const speed = nonnegative(progress.bytesPerSecond) ? (stalled ? 0 : progress.bytesPerSecond) : null;
  let seconds: number | null = null;
  if (speed !== null && speed > 0 && nonnegative(progress.totalBytes) && progress.totalBytes > 0
    && nonnegative(progress.transferredBytes) && progress.transferredBytes <= progress.totalBytes) {
    const estimate = Math.ceil((progress.totalBytes - progress.transferredBytes) / speed);
    if (Number.isSafeInteger(estimate)) seconds = estimate;
  }
  return { speed, seconds };
}

function numberLocale(language: string) {
  const locale = language.replace(/-Neko$/i, '');
  if (locale === 'lzh') return 'zh';
  try { return Intl.NumberFormat.supportedLocalesOf(locale)[0] || 'en'; }
  catch { return 'en'; }
}

export function formatDownloadSpeed(speed: number | null, language: string) {
  if (speed === null || !nonnegative(speed)) return '—';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const index = speed > 0 ? Math.min(3, Math.max(0, Math.floor(Math.log10(speed) / 3))) : 0;
  return `${new Intl.NumberFormat(numberLocale(language), { maximumFractionDigits: 1 }).format(speed / 1000 ** index)} ${units[index]}`;
}

export function formatRemainingTime(seconds: number, language: string) {
  const duration = Math.max(0, Math.ceil(seconds));
  const locale = numberLocale(language);
  const unit = (value: number, name: 'hour' | 'minute' | 'second') => new Intl.NumberFormat(locale,
    { style: 'unit', unit: name, unitDisplay: 'short', maximumFractionDigits: 0 }).format(value);
  if (duration >= 3600) {
    const minutes = Math.ceil(duration / 60);
    return [unit(Math.floor(minutes / 60), 'hour'), minutes % 60 ? unit(minutes % 60, 'minute') : ''].filter(Boolean).join(' ');
  }
  if (duration >= 60) return [unit(Math.floor(duration / 60), 'minute'), duration % 60 ? unit(duration % 60, 'second') : ''].filter(Boolean).join(' ');
  return unit(duration, 'second');
}
