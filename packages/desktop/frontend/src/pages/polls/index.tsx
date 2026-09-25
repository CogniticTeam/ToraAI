import { BarChart3, Check, Clock3, RefreshCw, Vote } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n/useI18n';
import { cloudFetch } from '@/utils/modelSync';
import { currentAccount, deviceId, QUEUE_EVENT, readQueue, saveQueue, syncPendingVotes, type PendingVote } from '@/lib/pollQueue';

type PollType = 'single' | 'multiple' | 'score';
type PollState = 'draft' | 'scheduled' | 'active' | 'ended' | 'archived';
type Poll = {
  id: string; title: string; description: string; cover: string; type: PollType;
  maxSelections: number; frequency: 'once' | 'daily' | 'unlimited';
  resultVisibility: 'live' | 'after_end' | 'admin';
  state: PollState; pinned: boolean; myVoteCount: number;
  createdAt: string; startAt: string; endAt: string | null;
};
type Option = { id: string; label: string; note: string };
type ResultOption = Option & { votes: number; selectionRate: number; share: number; averageScore: number | null; scoreTotal: number };
type Results = { participants?: number; options: ResultOption[] };
type HistoryVote = { id: string; pollId: string; title: string; type: PollType; createdAt: string; items: { label: string; score: number | null }[] };
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await cloudFetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`);
  return body as T;
}

const dateText = (value: string | null) => value ? new Date(value).toLocaleString() : '∞';
const dateInput = (value: string) => value ? new Date(value).toISOString() : '';
type Translate = (key: string, options?: Record<string, unknown>) => string;
function startCountdown(startAt: string, now: number, t: Translate) {
  const remaining = Date.parse(startAt) - now;
  if (!Number.isFinite(remaining)) return '';
  if (remaining <= 0) return t('polls.startingSoon');
  const totalSeconds = Math.ceil(remaining / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor(totalSeconds / 3600) % 24;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  const clock = [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':');
  return t('polls.startsIn', { time: days ? `${days}${t('polls.dayUnit')} ${clock}` : clock });
}

export function PollsPage() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(true);
  const [polls, setPolls] = useState<Poll[]>([]);
  const [pollsLoading, setPollsLoading] = useState(true);
  const [pollsLoadFailed, setPollsLoadFailed] = useState(false);
  const pollsRequestId = useRef(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ poll: Poll; options: Option[] } | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [history, setHistory] = useState<HistoryVote[]>([]);
  const [historyNextOffset, setHistoryNextOffset] = useState<number | null>(null);
  const [view, setView] = useState<'polls' | 'history'>('polls');
  const [historyFrom, setHistoryFrom] = useState('');
  const [historyTo, setHistoryTo] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [queue, setQueue] = useState<PendingVote[]>(readQueue);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const lastStartRefresh = useRef(0);
  const hasScheduled = enabled && view === 'polls' && (polls.some(poll => poll.state === 'scheduled') || detail?.poll.state === 'scheduled');

  const loadPolls = useCallback(async () => {
    const requestId = ++pollsRequestId.current;
    setPollsLoading(true); setPollsLoadFailed(false);
    try {
      const all: Poll[] = [];
      const seenIds = new Set<string>();
      let offset = 0;
      while (true) {
        const data = await api<{ polls: Poll[]; nextOffset: number | null }>(`/polls?offset=${offset}`);
        if (requestId !== pollsRequestId.current) return;
        for (const poll of data.polls) if (!seenIds.has(poll.id)) { seenIds.add(poll.id); all.push(poll); }
        if (data.nextOffset == null) break;
        if (!Number.isSafeInteger(data.nextOffset) || data.nextOffset <= offset) throw new Error(t('polls.loadError'));
        offset = data.nextOffset;
      }
      setPolls(all); setError('');
    } catch (reason) {
      if (requestId === pollsRequestId.current) {
        setPolls([]); setPollsLoadFailed(true);
        setError(reason instanceof Error ? reason.message : t('polls.loadError'));
      }
    } finally { if (requestId === pollsRequestId.current) setPollsLoading(false); }
  }, [t]);

  const loadHistory = useCallback(async (offset = 0) => {
    const params = new URLSearchParams();
    if (historyFrom) params.set('from', dateInput(historyFrom));
    if (historyTo) params.set('to', dateInput(historyTo + 'T23:59'));
    if (offset) params.set('offset', String(offset));
    try { const data = await api<{ votes: HistoryVote[]; nextOffset: number | null }>('/polls/history?' + params.toString()); setHistory(previous => offset ? [...previous, ...data.votes] : data.votes); setHistoryNextOffset(data.nextOffset); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('polls.loadError')); }
  }, [historyFrom, historyTo, t]);

  const loadResults = useCallback(async (id: string) => {
    try { const data = await api<Results>(`/polls/${id}/results`); setResults(data); }
    catch { setResults(null); }
  }, []);

  useEffect(() => {
    void api<{ enabled: boolean }>('/polls/config').then(data => {
      setEnabled(data.enabled); if (data.enabled) void loadPolls(); else setPollsLoading(false);
    }).catch(() => { void loadPolls(); });
  }, [loadPolls]);
  useEffect(() => { if (view === 'history') void loadHistory(); }, [view, loadHistory]);
  useEffect(() => {
    const updateQueue = () => setQueue(readQueue());
    const onOnline = () => { void syncPendingVotes().then(() => { void loadPolls(); void loadHistory(); if (selectedId) void loadResults(selectedId); }); };
    window.addEventListener(QUEUE_EVENT, updateQueue); window.addEventListener('online', onOnline);
    void syncPendingVotes();
    return () => { window.removeEventListener(QUEUE_EVENT, updateQueue); window.removeEventListener('online', onOnline); };
  }, [loadPolls, loadHistory, loadResults, selectedId]);
  useEffect(() => {
    if (!selectedId || !enabled) return;
    let alive = true;
    setDetail(null); setResults(null); setSelected([]); setScores({});
    void api<{ poll: Poll; options: Option[] }>(`/polls/${selectedId}`).then(data => { if (alive) { setDetail(data); void loadResults(selectedId); } }).catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : t('polls.loadError')); });
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void loadResults(selectedId); }, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [selectedId, enabled, loadResults, t]);
  useEffect(() => {
    if (!hasScheduled) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') tick(); }, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [hasScheduled]);
  useEffect(() => {
    if (!hasScheduled) return;
    const starts = [...polls, ...(detail ? [detail.poll] : [])]
      .filter(poll => poll.state === 'scheduled')
      .map(poll => Date.parse(poll.startAt)).filter(Number.isFinite);
    if (!starts.length) return;
    const earliest = Math.min(...starts);
    const selectedScheduledId = detail?.poll.state === 'scheduled' && detail.poll.id === selectedId ? selectedId : null;
    let alive = true;
    let inFlight = false;
    let timer: number;
    const refreshDue = () => {
      const current = Date.now();
      if (!alive || document.visibilityState !== 'visible' || current < earliest || inFlight || current - lastStartRefresh.current < 4500) return;
      lastStartRefresh.current = current;
      inFlight = true;
      const refreshDetail = selectedScheduledId
        ? api<{ poll: Poll; options: Option[] }>(`/polls/${selectedScheduledId}`)
          .then(data => { if (alive) { setDetail(previous => previous?.poll.id === selectedScheduledId ? data : previous); void loadResults(selectedScheduledId); } })
          .catch(() => {})
        : Promise.resolve();
      void Promise.all([loadPolls(), refreshDetail]).finally(() => { inFlight = false; });
    };
    const schedule = () => {
      const remaining = earliest - Date.now();
      const delay = remaining > 0 ? Math.min(remaining + 100, 60000)
        : document.visibilityState !== 'visible' ? 5000 : Math.max(1000, 5000 - (Date.now() - lastStartRefresh.current));
      timer = window.setTimeout(() => { refreshDue(); schedule(); }, delay);
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') refreshDue(); };
    document.addEventListener('visibilitychange', onVisibility);
    refreshDue();
    schedule();
    return () => { alive = false; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [hasScheduled, polls, detail, selectedId, loadPolls, loadResults]);

  const pendingForAccount = useMemo(() => queue.filter(item => item.account === currentAccount()), [queue]);
  const pendingForPoll = detail && pendingForAccount.some(item => item.pollId === detail.poll.id && !item.failedReason);

  async function submitVote() {
    if (!detail || detail.poll.state !== 'active') return;
    const items: { optionId: string; score?: number }[] = detail.poll.type === 'score'
      ? detail.options.map(option => ({ optionId: option.id, score: scores[option.id] }))
      : selected.map(optionId => ({ optionId }));
    if (detail.poll.type === 'score' && items.some(item => typeof item.score !== 'number' || !Number.isInteger(item.score) || item.score < 0 || item.score > 100)) { setError(t('polls.scoreRequired')); return; }
    if (detail.poll.type === 'single' && items.length !== 1 || detail.poll.type === 'multiple' && (!items.length || items.length > detail.poll.maxSelections)) { setError(t('polls.selectionRequired')); return; }
    if (!window.confirm(t('polls.confirmVote'))) return;
    const pending: PendingVote = { pollId: detail.poll.id, title: detail.poll.title, submissionId: crypto.randomUUID(), account: currentAccount(), items, deviceId: deviceId(), createdAt: new Date().toISOString() };
    if (!navigator.onLine) { saveQueue([...readQueue(), pending]); setNotice(t('polls.queued')); setError(''); return; }
    setBusy(true);
    try {
      await api(`/polls/${pending.pollId}/votes`, { method: 'POST', body: JSON.stringify(pending) });
      setNotice(t('polls.submitted')); setError(''); setSelected([]);
      await Promise.all([loadPolls(), loadHistory(), loadResults(pending.pollId)]);
      const data = await api<{ poll: Poll; options: Option[] }>(`/polls/${pending.pollId}`); setDetail(data);
    } catch (reason) {
      if (reason instanceof TypeError) { saveQueue([...readQueue(), pending]); setNotice(t('polls.queued')); setError(''); }
      else setError(reason instanceof Error ? reason.message : t('polls.submitError'));
    } finally { setBusy(false); }
  }

  const stateLabel = (state: PollState) => t(`polls.state.${state}`);
  const typeLabel = (type: PollType) => t(`polls.type.${type}`);
  const canVote = detail?.poll.state === 'active' && !(detail.poll.frequency === 'once' && detail.poll.myVoteCount > 0) && !pendingForPoll;

  return <div className="flex size-full p-2">
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-[22px] bg-card shadow-panel">
      <div className="app-drag flex items-center justify-between px-6 pt-5 pb-4"><div><h1 className="text-2xl font-semibold">{t('polls.title')}</h1><p className="mt-1 text-sm text-muted-foreground">{t('polls.subtitle')}</p></div><Button variant="ghost" size="icon" onClick={() => { void loadPolls(); void loadHistory(); if (selectedId) void loadResults(selectedId); }} aria-label={t('polls.refresh')}><RefreshCw /></Button></div>
      {!enabled ? <div className="m-6 rounded-xl border border-border p-6 text-sm text-muted-foreground">{t('polls.disabled')}</div> : <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pb-6">
        <div className="mb-4 flex gap-2 border-b border-border pb-3"><Button variant={view === 'polls' ? 'secondary' : 'ghost'} onClick={() => setView('polls')}>{t('polls.all')}</Button><Button variant={view === 'history' ? 'secondary' : 'ghost'} onClick={() => setView('history')}>{t('polls.history')}</Button></div>
        {!!error && <p role="alert" className="mb-3 rounded-xl border border-destructive/50 p-3 text-sm text-destructive">{error}</p>}
        {!!notice && <p role="status" className="mb-3 rounded-xl border border-border p-3 text-sm">{notice}</p>}
        {pendingForAccount.length > 0 && <div className="mb-3 rounded-xl border border-border bg-muted/30 p-3 text-sm"><div className="mb-2 flex items-center gap-2"><Clock3 className="size-4" />{t('polls.pending')} ({pendingForAccount.length})</div>{pendingForAccount.map(item => <div key={item.submissionId} className="flex items-center justify-between gap-2 py-1"><span className="truncate">{item.title} · {item.failedReason || t('polls.waitingSync')}</span><div className="flex gap-1">{item.failedReason && <Button size="xs" variant="outline" onClick={() => { saveQueue(readQueue().map(row => row.submissionId === item.submissionId ? { ...row, failedReason: undefined } : row)); void syncPendingVotes(); }}>{t('polls.retry')}</Button>}<Button size="xs" variant="ghost" onClick={() => { if (window.confirm(t('polls.removePending'))) saveQueue(readQueue().filter(row => row.submissionId !== item.submissionId)); }}>{t('polls.remove')}</Button></div></div>)}</div>}
        {view === 'history' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mb-3 flex flex-wrap gap-2">
              <Input type="date" value={historyFrom} onChange={event => setHistoryFrom(event.target.value)} className="w-40" aria-label={t('polls.from')} />
              <Input type="date" value={historyTo} onChange={event => setHistoryTo(event.target.value)} className="w-40" aria-label={t('polls.to')} />
              <Button variant="outline" onClick={() => void loadHistory()}>{t('polls.search')}</Button>
            </div>
            {history.length ? history.map(vote => <article key={vote.id} className="mb-2 rounded-xl border border-border p-4"><div className="font-medium">{vote.title}</div><div className="mt-1 text-xs text-muted-foreground">{dateText(vote.createdAt)}</div><div className="mt-2 text-sm">{vote.items.map(item => item.score == null ? item.label : `${item.label}: ${item.score}`).join('、')}</div></article>) : <p className="py-12 text-center text-sm text-muted-foreground">{t('polls.noHistory')}</p>}
            {historyNextOffset !== null && <Button variant="outline" onClick={() => void loadHistory(historyNextOffset)}>{t('polls.loadMore')}</Button>}
          </div>
        ) : pollsLoading ? (
          <div role="status" className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><RefreshCw className="size-4 animate-spin" aria-hidden="true" />{t('polls.loading')}</div>
        ) : pollsLoadFailed ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground"><span>{t('polls.loadError')}</span><Button variant="outline" onClick={() => void loadPolls()}>{t('polls.retry')}</Button></div>
        ) : <>
          <div className="flex min-h-0 flex-1 gap-4">
            <div className="w-full shrink-0 overflow-y-auto lg:w-[320px]">
              {polls.length ? polls.map(poll => <button key={poll.id} onClick={() => setSelectedId(poll.id)} className={`mb-2 w-full rounded-xl border p-4 text-left transition-colors hover:bg-muted/60 ${selectedId === poll.id ? 'border-foreground' : 'border-border'} ${poll.state === 'ended' ? 'opacity-65' : ''}`}>
                <div className="flex items-start justify-between gap-2"><span className="font-medium">{poll.pinned ? '📌 ' : ''}{poll.title}</span><Badge variant="outline">{stateLabel(poll.state)}</Badge></div>
                <div className="mt-2 text-xs text-muted-foreground">{typeLabel(poll.type)} · {dateText(poll.endAt)}</div>
                {poll.state === 'scheduled' && <div className="mt-2 flex items-center gap-1.5 text-xs"><Clock3 className="size-3.5" aria-hidden="true" /><time role="timer" dateTime={poll.startAt}>{startCountdown(poll.startAt, now, t)}</time></div>}
                {poll.myVoteCount > 0 ? <div className="mt-2 text-xs">{t('polls.voted')}</div> : poll.state === 'active' && <div className="mt-2 text-xs">{t('polls.available')}</div>}
              </button>) : <p className="py-12 text-center text-sm text-muted-foreground">{t('polls.empty')}</p>}
            </div>
            <div className="hidden min-w-0 flex-1 overflow-y-auto rounded-xl border border-border p-5 lg:block">{detail ? <PollDetail key={detail.poll.id} instance="desktop" detail={detail} now={now} selected={selected} setSelected={setSelected} scores={scores} setScores={setScores} results={results} canVote={!!canVote} busy={busy} pending={!!pendingForPoll} submitVote={submitVote} t={t} /> : <div className="grid h-full place-items-center text-sm text-muted-foreground"><span>{t('polls.choose')}</span></div>}</div>
          </div>
          {detail && <div className="mt-3 max-h-[45vh] overflow-y-auto rounded-xl border border-border p-4 lg:hidden"><PollDetail instance="mobile" detail={detail} now={now} selected={selected} setSelected={setSelected} scores={scores} setScores={setScores} results={results} canVote={!!canVote} busy={busy} pending={!!pendingForPoll} submitVote={submitVote} t={t} /></div>}
        </>}
      </div>}
    </main>
  </div>;
}

function PollDetail({ instance, detail, now, selected, setSelected, scores, setScores, results, canVote, busy, pending, submitVote, t }: {
  instance: 'desktop' | 'mobile';
  detail: { poll: Poll; options: Option[] }; now: number; selected: string[]; setSelected: (value: string[]) => void;
  scores: Record<string, number>; setScores: (value: Record<string, number>) => void;
  results: Results | null; canVote: boolean; busy: boolean; pending: boolean; submitVote: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const { poll, options } = detail;
  return <div>
    {poll.cover && <img src={poll.cover} alt="" className="mb-4 max-h-48 w-full rounded-xl object-cover" />}
    <div className="flex flex-wrap items-center gap-2"><h2 className="text-xl font-semibold">{poll.title}</h2><Badge variant="outline">{t(`polls.state.${poll.state}`)}</Badge></div>
    <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{poll.description}</p>
    <div className="mt-3 text-xs text-muted-foreground">{t('polls.starts')}: {dateText(poll.startAt)} · {t('polls.ends')}: {poll.endAt ? dateText(poll.endAt) : t('polls.forever')}</div>
    {poll.state === 'scheduled' && <div className="mt-4 flex items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm"><Clock3 className="size-4" aria-hidden="true" /><time role="timer" dateTime={poll.startAt}>{startCountdown(poll.startAt, now, t)}</time></div>}
    <div className="mt-1 text-xs text-muted-foreground">{t(`polls.type.${poll.type}`)} · {t(`polls.frequency.${poll.frequency}`)}{poll.type === 'multiple' ? ` · ${t('polls.maxSelections', { count: poll.maxSelections })}` : ''}</div>
    <div className="mt-5 space-y-2">{options.map(option => <label key={option.id} className="flex cursor-pointer items-center gap-3 rounded-xl border border-border p-3 has-[:checked]:border-foreground"><div className="flex-1"><div className="text-sm font-medium">{option.label}</div>{option.note && <div className="mt-1 text-xs text-muted-foreground">{option.note}</div>}</div>{poll.type === 'score' ? <Input type="number" min={0} max={100} step={1} className="w-20 text-right" placeholder="0–100" value={scores[option.id] ?? ''} disabled={!canVote} onChange={event => setScores({ ...scores, [option.id]: event.target.value === '' ? NaN : Number(event.target.value) })} /> : <input type={poll.type === 'single' ? 'radio' : 'checkbox'} name={`poll-${poll.id}-${instance}`} className="size-4 accent-foreground" checked={selected.includes(option.id)} disabled={!canVote} onChange={() => { if (poll.type === 'single') setSelected([option.id]); else if (selected.includes(option.id)) setSelected(selected.filter(id => option.id !== id)); else if (selected.length < poll.maxSelections) setSelected([...selected, option.id]); }} />}</label>)}</div>
    <div className="mt-4 flex items-center gap-3"><Button disabled={!canVote || busy} onClick={submitVote}><Vote className="size-4" />{busy ? t('polls.submitting') : t('polls.submit')}</Button>{poll.myVoteCount > 0 && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Check className="size-3" />{t('polls.votedCount', { count: poll.myVoteCount })}</span>}{pending && <span className="text-xs text-muted-foreground">{t('polls.waitingSync')}</span>}</div>
    <div className="mt-8 border-t border-border pt-5"><div className="mb-3 flex items-center gap-2"><BarChart3 className="size-4" /><h3 className="font-medium">{t('polls.results')}</h3></div>{results ? <><div className="mb-3 text-xs text-muted-foreground">{results.participants == null ? t('polls.countHidden') : t('polls.participants', { count: results.participants })} · {t('polls.autoRefresh')}</div>{results.options.length ? <><div className="space-y-3">{results.options.map(option => {const value = poll.type === 'score' ? (option.averageScore ?? 0) / 100 : option.selectionRate;return <div key={option.id}><div className="mb-1 flex justify-between text-sm"><span>{option.label}</span><span>{poll.type === 'score' ? `${(option.averageScore ?? 0).toFixed(1)} / 100` : `${option.votes} · ${(option.selectionRate * 100).toFixed(1)}%`}</span></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-foreground transition-[width]" style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} /></div></div>})}</div><div className="mt-5 flex items-center gap-4"><div className="size-24 shrink-0 rounded-full border border-border" style={{ background: `conic-gradient(${results.options.map((option, index) => {const start = results.options.slice(0, index).reduce((sum, current) => sum + current.share, 0) * 100;return `hsl(0 0% ${Math.max(20, 85 - index * 11)}%) ${start}% ${(start + option.share * 100)}%`}).join(',')})` }} /><span className="text-xs text-muted-foreground">{t('polls.pieHint')}</span></div></> : <p className="text-sm text-muted-foreground">{t('polls.detailsHidden')}</p>}</> : <p className="text-sm text-muted-foreground">{t('polls.resultsUnavailable')}</p>}</div>
  </div>;
}
