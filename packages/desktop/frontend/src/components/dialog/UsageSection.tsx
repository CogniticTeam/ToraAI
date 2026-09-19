/**
 * 设置窗口「使用统计」板块（参考 Codex/ChatGPT 使用面板，图1）：
 *   · 顶部五指标卡：累计 Token / 峰值 Token / 最长聊天时长 / 当前与最长连续天数
 *   · Token 活动热力图（GitHub 风格，每日/每周/累计 三种着色 + 悬浮提示）
 *   · 活动洞察 + 最常用的工具
 * 数据来自 GET /admin/usage-stats（core 侧聚合 traces + sessions）。
 */
import { Box, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { useTranslation } from '@/i18n/useI18n';

const apiBase = () => (localStorage.getItem('server_url') || 'http://127.0.0.1:3210').replace(/\/+$/, '');

interface UsageStats {
  totalTokens: number;
  peakTokens: number;
  totalRuns: number;
  totalToolRuns: number;
  chatCount: number;
  activeDays: number;
  maxChatMs: number;
  currentStreak: number;
  longestStreak: number;
  topTools: { name: string; count: number }[];
  topModels: { name: string; count: number }[];
  daily: Record<string, { tokens: number; runs: number }>;
}

/** 数量级格式化：中文用 亿/万，其他语言用 K/M/B（react-i18next 的 useTranslation 返回 { t, i18n }） */
function makeFmtTokens(isZh: boolean) {
  if (isZh) {
    return (n: number): string => {
      if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
      if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
      return String(n);
    };
  }
  return (n: number): string => {
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(n);
  };
}

function makeFmtDuration(isZh: boolean) {
  return (ms: number): string => {
    if (ms <= 0) return isZh ? '0 秒' : '0s';
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (isZh) {
      if (h > 0) return `${h} 小时 ${m} 分`;
      if (m > 0) return `${m} 分 ${s} 秒`;
      return `${s} 秒`;
    }
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };
}

/** 日期带年份：zh「2026年9月13日」/ en「Sep 13, 2026」 */
function makeFmtDate(isZh: boolean) {
  return (d: Date): string => {
    if (isZh) return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };
}

/** 热力图着色：按当日值在 [1, max] 区间取 5 档（0 = 空格子） */
function shade(v: number, max: number): string {
  if (v <= 0 || max <= 0) return 'bg-muted';
  const r = v / max;
  // 5 档实色灰阶（禁半透明后用色阶表达强度，深浅两主题各自可读）
  if (r > 0.75) return 'bg-primary';
  if (r > 0.5) return '#565b63 dark:bg-[#c9cdd4]';
  if (r > 0.25) return '#8e939a dark:bg-[#8b9099]';
  return '#c7cbd1 dark:bg-[#4a4e57]';
}

type Mode = 'daily' | 'weekly' | 'cumulative';

export function UsageSection() {
  const { t, i18n } = useTranslation();
  const isZh = String(i18n?.language ?? 'zh').toLowerCase().startsWith('zh');
  const fmtTokens = makeFmtTokens(isZh);
  const fmtDuration = makeFmtDuration(isZh);
  const fmtDate = makeFmtDate(isZh);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('daily');
  // 悬浮提示：格子日期 + 当日用量（仿截图「9月5日 使用了 2268.4万 个 Token」）
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase()}/admin/usage-stats`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setStats(data);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // 挂载拉一次；面板存活期间每 15s 轮询 —— 边聊边看数据在涨
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // ---- 热力图网格：最近 52 周，列=周（周一开头），行=周一..周日 ----
  const grid = useMemo(() => {
    if (!stats) return null;
    const daily = stats.daily ?? {};
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const end = today.getTime();
    const start = end - 51 * 7 * 86400_000;
    // 对齐到 start 所在周的周一
    const firstDow = (new Date(start).getDay() + 6) % 7; // 周一=0
    const gridStart = start - firstDow * 86400_000;

    const weeks: { ts: number; dayTokens: number; weekTokens: number; cumTokens: number }[][] = [];
    const get = (ts: number) => {
      const d = new Date(ts);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return daily[k]?.tokens ?? 0;
    };
    let cum = 0;
    const cumByDay = new Map<number, number>();
    const allStart = Math.min(...Object.keys(daily).map((k) => Date.parse(`${k}T00:00:00`)).filter(Number.isFinite), gridStart);
    for (let ts = allStart; ts <= end; ts += 86400_000) {
      cum += get(ts);
      cumByDay.set(ts, cum);
    }
    for (let w = 0; w < 53; w++) {
      const col: { ts: number; dayTokens: number; weekTokens: number; cumTokens: number }[] = [];
      let weekTokens = 0;
      for (let d = 0; d < 7; d++) {
        const ts = gridStart + (w * 7 + d) * 86400_000;
        const v = get(ts);
        weekTokens += v;
        col.push({ ts, dayTokens: v, weekTokens: 0, cumTokens: cumByDay.get(ts) ?? 0 });
      }
      for (const cell of col) cell.weekTokens = weekTokens;
      weeks.push(col);
    }
    return { weeks, max: { daily: 1, weekly: 1, cumulative: 1 } as Record<Mode, number> };
  }, [stats]);

  const maxOf = useMemo(() => {
    if (!grid) return { daily: 1, weekly: 1, cumulative: 1 };
    const m = { daily: 1, weekly: 1, cumulative: 1 };
    for (const col of grid.weeks) for (const c of col) {
      m.daily = Math.max(m.daily, c.dayTokens);
      m.weekly = Math.max(m.weekly, c.weekTokens);
      m.cumulative = Math.max(m.cumulative, c.cumTokens);
    }
    return m;
  }, [grid]);

  const cellValue = (c: { dayTokens: number; weekTokens: number; cumTokens: number }) =>
    mode === 'daily' ? c.dayTokens : mode === 'weekly' ? c.weekTokens : c.cumTokens;

  if (err) {
    return <div className="rounded-md bg-destructive-soft px-3 py-2 text-xs text-destructive">{t('settings.usage.loadFailed', { error: err })}</div>;
  }
  if (!stats || !grid) {
    return <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> {t('settings.usage.loading')}</div>;
  }

  const daysLabel = (n: number) => t('settings.usage.days', { count: n });
  const cards = [
    { value: fmtTokens(stats.totalTokens), label: t('settings.usage.cards.totalTokens') },
    { value: fmtTokens(stats.peakTokens), label: t('settings.usage.cards.peakTokens') },
    { value: fmtDuration(stats.maxChatMs), label: t('settings.usage.cards.longestChat') },
    { value: daysLabel(stats.currentStreak), label: t('settings.usage.cards.currentStreak') },
    { value: daysLabel(stats.longestStreak), label: t('settings.usage.cards.longestStreak') },
  ];

  const insights = [
    { label: t('settings.usage.insights.chats'), value: String(stats.chatCount) },
    { label: t('settings.usage.insights.runs'), value: String(stats.totalRuns) },
    { label: t('settings.usage.insights.activeDays'), value: String(stats.activeDays) },
    { label: t('settings.usage.insights.toolRuns'), value: String(stats.totalToolRuns) },
    { label: t('settings.usage.insights.topModel'), value: stats.topModels[0]?.name ?? '—' },
  ];

  return (
    <div className="space-y-6">
      {/* ---- 五指标卡 ---- */}
      <div className="grid grid-cols-5 gap-2 rounded-xl border border-border bg-card p-4">
        {cards.map((c, i) => (
          <div
            key={c.label}
            className="min-w-0 animate-in fade-in slide-in-from-bottom-1 text-center duration-400"
            style={{ animationDelay: `${i * 60}ms`, animationFillMode: 'backwards' }}
          >
            <div className="truncate text-lg font-semibold tabular-nums">{c.value}</div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{c.label}</div>
          </div>
        ))}
      </div>

      {/* ---- Token 活动热力图 ---- */}
      <div>
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">{t('settings.usage.activity.title')}</div>
          <div className="flex items-center gap-2">
          <div className="inline-flex items-center rounded-lg border bg-muted p-0.5">
            {(['daily', 'weekly', 'cumulative'] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={
                  'rounded-md px-2.5 py-1 text-xs transition-colors ' +
                  (mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')
                }
              >
                {t(`settings.usage.activity.${m}`)}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void refresh()}
              title={t('settings.usage.refresh')}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <RefreshCw className="size-3.5" />
            </button>
            </div>
          </div>
        </div>
        <div className="relative mt-3 overflow-x-auto rounded-xl border border-border bg-card p-4">
          <div className="flex gap-[3px]">
            {grid.weeks.map((col, wi) => (
              <div key={wi} className="flex flex-col gap-[3px]">
                {col.map((c) => {
                  const d = new Date(c.ts);
                  const inRange = c.ts <= Date.now();
                  const v = cellValue(c);
                  return (
                    <div
                      key={c.ts}
                      className={`heat-cell-in size-[11px] rounded-[3px] motion-safe:hover:scale-125 ${inRange ? shade(v, maxOf[mode]) : 'bg-transparent'}`}
                      style={{ animationDelay: `${wi * 12}ms`, animationFillMode: 'backwards' }}
                      onMouseMove={(e) => {
                        if (!inRange) return;
                        const tipText =
                          mode === 'daily'
                            ? t('settings.usage.activity.tipDaily', { tokens: fmtTokens(v) })
                            : mode === 'weekly'
                              ? t('settings.usage.activity.tipWeekly', { tokens: fmtTokens(v) })
                              : t('settings.usage.activity.tipCumulative', { tokens: fmtTokens(v) });
                        setTip({ x: e.clientX, y: e.clientY, text: `${fmtDate(d)} ${tipText}` });
                      }}
                      onMouseLeave={() => setTip(null)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
      {tip && createPortal(
        <div
          className="pointer-events-none fixed z-[2147483646] -translate-x-1/2 -translate-y-[calc(100%+12px)] whitespace-nowrap rounded-lg border border-border bg-popover px-3 py-1.5 text-xs shadow-md"
          style={{ left: tip.x, top: tip.y }}
        >
          {tip.text}
        </div>,
        document.body,
      )}
        </div>
      </div>

      {/* ---- 洞察 + 最常用工具 ---- */}
      <div className="grid grid-cols-2 gap-8">
        <div>
          <div className="text-sm font-medium">{t('settings.usage.insights.title')}</div>
          <div className="mt-3 space-y-2.5">
            {insights.map((i) => (
              <div key={i.label} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{i.label}</span>
                <span className="truncate pl-4 font-medium tabular-nums">{i.value}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="text-sm font-medium">{t('settings.usage.topTools.title')}</div>
          {stats.topTools.length === 0 ? (
            <div className="mt-3 text-xs text-muted-foreground">{t('settings.usage.topTools.empty')}</div>
          ) : (
            <div className="mt-3 space-y-2.5">
              {stats.topTools.map((tool) => (
                <div key={tool.name} className="flex items-center gap-2.5 text-sm">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">
                    <Box className="size-3.5 text-muted-foreground" />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">${tool.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {t('settings.usage.topTools.runs', { count: tool.count })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
