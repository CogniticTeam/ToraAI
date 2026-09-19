/**
 * 设置窗口「记忆」板块（Memory 批次6）：
 *   · 顶部两个开关：会话注入（inject_enabled）/ 自动提炼（distill_enabled）
 *   · 记忆列表：项目 / 全局 分组 + kind 徽标 + 来源标签 + 置顶切换
 *   · 搜索（回车走服务端评分检索）、手动新增、行内编辑、两段式删除
 * 数据来自 /memories、/memory-config（core 侧 asapi/server.js + memory.js）。
 * 操作后 refetch，不做 SSE 推送（设置面板低频场景足够）。
 */
import { Loader2, Pencil, Pin, PinOff, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { memoryApi, type MemoryConfig, type MemoryRecord } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/i18n/useI18n';

const KINDS = ['preference', 'fact', 'pitfall', 'convention'] as const;
type Kind = (typeof KINDS)[number];

const KIND_CLASS: Record<Kind, string> = {
  preference: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  fact: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  pitfall: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
  convention: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
};

const asKind = (v: string): Kind => ((KINDS as readonly string[]).includes(v) ? (v as Kind) : 'fact');

function shortPath(p: string): string {
  if (!p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function fmtDate(iso: string, isZh: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return isZh
    ? `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
    : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hm}`;
}

/** 置顶在前，其余按 updated_at 新→旧 */
const byRecency = (a: MemoryRecord, b: MemoryRecord) => {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return b.updated_at.localeCompare(a.updated_at);
};

export function MemorySection() {
  const { t, i18n } = useTranslation();
  const isZh = String(i18n?.language ?? 'zh').toLowerCase().startsWith('zh');

  const [items, setItems] = useState<MemoryRecord[] | null>(null);
  const [cfg, setCfg] = useState<MemoryConfig | null>(null);
  const [qInput, setQInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // 新增表单
  const [adding, setAdding] = useState(false);
  const [newContent, setNewContent] = useState('');
  const [newKind, setNewKind] = useState<Kind>('fact');
  const [newScope, setNewScope] = useState<'global' | 'project'>('global');
  const [newKey, setNewKey] = useState('');

  // 行内编辑
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editKind, setEditKind] = useState<Kind>('fact');

  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const refresh = useCallback(async (q?: string) => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      const query = (q ?? '').trim();
      if (query) params.q = query;
      const [list, config] = await Promise.all([memoryApi.list(params), memoryApi.getConfig()]);
      setItems(list.memories);
      setCfg(config);
    } catch {
      // client 对非 2xx 已统一 toast；这里保持面板可重试
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const grouped = useMemo(() => {
    const all = items ?? [];
    return {
      project: all.filter((m) => m.scope === 'project').sort(byRecency),
      global: all.filter((m) => m.scope === 'global').sort(byRecency),
    };
  }, [items]);

  const toggleConfig = async (key: 'inject_enabled' | 'distill_enabled', v: boolean) => {
    try {
      setCfg(await memoryApi.saveConfig({ [key]: v }));
    } catch { /* toast 已由 client 弹出 */ }
  };

  const submitAdd = async () => {
    const content = newContent.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      const r = await memoryApi.add({
        content,
        kind: newKind,
        scope: newScope,
        project_key: newScope === 'project' ? newKey.trim() : '',
      });
      if (r.deduped) toast.success(t('settings.memory.dedupedToast'));
      setAdding(false);
      setNewContent('');
      setNewKey('');
      await refresh(qInput);
    } catch { /* 校验错误（空内容/非法枚举）已 toast */ } finally {
      setBusy(false);
    }
  };

  const submitEdit = async (id: string) => {
    const content = editContent.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      await memoryApi.update(id, { content, kind: editKind });
      setEditingId(null);
      await refresh(qInput);
    } catch { /* toast 已由 client 弹出 */ } finally {
      setBusy(false);
    }
  };

  const togglePin = async (m: MemoryRecord) => {
    try {
      await memoryApi.update(m.id, { pinned: !m.pinned });
      await refresh(qInput);
    } catch { /* toast 已由 client 弹出 */ }
  };

  const doDelete = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await memoryApi.remove(id);
      setConfirmDel(null);
      await refresh(qInput);
    } catch { /* toast 已由 client 弹出 */ } finally {
      setBusy(false);
    }
  };

  const sourceLabel = (s: string) => {
    const key = `settings.memory.sources.${s}`;
    const label = t(key);
    return label === key ? s : label;
  };

  const kindSelect = (value: Kind, onChange: (k: Kind) => void) => (
    <select
      value={value}
      onChange={(e) => onChange(asKind(e.target.value))}
      className="h-8 rounded-md border border-input bg-background px-2 text-xs"
    >
      {KINDS.map((k) => (
        <option key={k} value={k}>{t(`settings.memory.kinds.${k}`)}</option>
      ))}
    </select>
  );

  const renderCard = (m: MemoryRecord) => {
    const editing = editingId === m.id;
    return (
      <div key={m.id} className="rounded-lg border bg-background p-3 transition-colors hover:bg-muted/40">
        {editing ? (
          <div className="flex flex-col gap-2">
            <Input value={editContent} onChange={(e) => setEditContent(e.target.value)} className="text-sm" />
            <div className="flex items-center gap-2">
              {kindSelect(editKind, setEditKind)}
              <span className="flex-1" />
              <Button size="sm" variant="outline" onClick={() => setEditingId(null)} disabled={busy}>
                {t('settings.memory.cancel')}
              </Button>
              <Button size="sm" onClick={() => void submitEdit(m.id)} disabled={busy || !editContent.trim()}>
                {t('settings.memory.save')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 break-words text-sm leading-relaxed">{m.content}</p>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  type="button" size="icon" variant="ghost" className="size-7"
                  aria-label={m.pinned ? t('settings.memory.unpin') : t('settings.memory.pin')}
                  onClick={() => void togglePin(m)}
                >
                  {m.pinned ? <PinOff className="size-3.5 text-primary" /> : <Pin className="size-3.5" />}
                </Button>
                <Button
                  type="button" size="icon" variant="ghost" className="size-7"
                  aria-label={t('settings.memory.edit')}
                  onClick={() => { setEditingId(m.id); setEditContent(m.content); setEditKind(asKind(m.kind)); }}
                >
                  <Pencil className="size-3.5" />
                </Button>
                {confirmDel === m.id ? (
                  <Button type="button" size="sm" variant="destructive" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void doDelete(m.id)}>
                    {t('settings.memory.confirmDelete')}
                  </Button>
                ) : (
                  <Button
                    type="button" size="icon" variant="ghost"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    aria-label={t('settings.memory.delete')}
                    onClick={() => setConfirmDel(m.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className={KIND_CLASS[asKind(m.kind)]}>
                {t(`settings.memory.kinds.${m.kind}`)}
              </Badge>
              {m.scope === 'project' && m.project_key && (
                <Badge variant="outline" className="max-w-48 truncate font-mono text-[10px] text-muted-foreground" title={m.project_key}>
                  {shortPath(m.project_key)}
                </Badge>
              )}
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                {sourceLabel(m.source)}
              </Badge>
              {m.pinned && <Pin className="size-3 text-primary" />}
              <span className="ml-auto text-[10px] text-muted-foreground">{fmtDate(m.updated_at, isZh)}</span>
            </div>
          </>
        )}
      </div>
    );
  };

  const empty = (items ?? []).length === 0;

  return (
    <div className="flex flex-col gap-4">
      {/* 两个行为开关 */}
      <div className="space-y-3">
        {(['inject_enabled', 'distill_enabled'] as const).map((key) => (
          <div key={key} className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">
                {t(key === 'inject_enabled' ? 'settings.memory.inject' : 'settings.memory.distill')}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {t(key === 'inject_enabled' ? 'settings.memory.injectDesc' : 'settings.memory.distillDesc')}
              </div>
            </div>
            <Switch checked={!!cfg?.[key]} onCheckedChange={(v) => void toggleConfig(key, v)} />
          </div>
        ))}
      </div>

      {/* 搜索 + 刷新 */}
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void refresh(qInput); }}
            placeholder={t('settings.memory.searchPh')}
            className="pl-8 text-sm"
          />
        </div>
        <Button type="button" size="icon" variant="ghost" className="size-8" aria-label="refresh" onClick={() => void refresh(qInput)}>
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        </Button>
      </div>

      {/* 新增：按钮 ⇄ 表单 */}
      {adding ? (
        <div className="rounded-lg border border-dashed bg-muted/30 p-3">
          <div className="flex flex-col gap-2">
            <Input
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder={t('settings.memory.contentPh')}
              className="text-sm"
              autoFocus
            />
            <div className="flex flex-wrap items-center gap-2">
              {kindSelect(newKind, setNewKind)}
              <select
                value={newScope}
                onChange={(e) => setNewScope(e.target.value === 'project' ? 'project' : 'global')}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              >
                <option value="global">{t('settings.memory.scopeGlobal')}</option>
                <option value="project">{t('settings.memory.scopeProject')}</option>
              </select>
              {newScope === 'project' && (
                <Input
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder={t('settings.memory.projectKeyPh')}
                  className="h-8 min-w-48 flex-1 text-xs"
                />
              )}
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setAdding(false)} disabled={busy}>
                {t('settings.memory.cancel')}
              </Button>
              <Button size="sm" onClick={() => void submitAdd()} disabled={busy || !newContent.trim()}>
                {t('settings.memory.save')}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div>
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            {t('settings.memory.add')}
          </Button>
        </div>
      )}

      {/* 列表：项目分组 + 全局分组 */}
      {items === null ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          {loading ? <Loader2 className="size-4 animate-spin" /> : <span className="text-sm">—</span>}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {grouped.project.length > 0 && (
            <section>
              <h4 className="mb-2 text-xs font-medium text-muted-foreground">
                {t('settings.memory.projectGroup')}（{grouped.project.length}）
              </h4>
              <div className="space-y-2">{grouped.project.map(renderCard)}</div>
            </section>
          )}
          <section>
            <h4 className="mb-2 text-xs font-medium text-muted-foreground">
              {t('settings.memory.globalGroup')}（{grouped.global.length}）
            </h4>
            {grouped.global.length > 0 ? (
              <div className="space-y-2">{grouped.global.map(renderCard)}</div>
            ) : empty ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
                {qInput.trim() ? t('settings.memory.emptySearch') : t('settings.memory.empty')}
              </div>
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}
