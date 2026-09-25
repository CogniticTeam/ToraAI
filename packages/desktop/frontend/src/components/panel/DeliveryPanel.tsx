import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { workspaceApi, type DeliveryReport } from '@/api';
import { PanelEmpty } from '@/components/panel/PanelEmpty';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/i18n/useI18n';

interface Props {
	sessionId: string | null;
	revision: number;
	enabled: boolean;
	criteria: string;
	disabled: boolean;
	onSettingsChange: (enabled: boolean, criteria: string) => Promise<boolean>;
}

export function DeliveryPanel({ sessionId, revision, enabled, criteria, disabled, onSettingsChange }: Props) {
	const { i18n } = useTranslation();
	const zh = i18n.language.startsWith('zh');
	const statusLabel = (value: string) => zh ? ({ passed: '通过', failed: '失败', blocked: '被阻止', skipped: '已跳过', unknown: '未知', complete: '已完成', error: '出错', aborted: '已中止' } as Record<string, string>)[value] ?? value : value;
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [localEnabled, setLocalEnabled] = useState(enabled);
	const [draft, setDraft] = useState(criteria);
	const [savedCriteria, setSavedCriteria] = useState(criteria);
	const [saving, setSaving] = useState(false);
	const [openTraceId, setOpenTraceId] = useState<string | null>(null);
	const [traceMarkdown, setTraceMarkdown] = useState('');
	const [traceLoading, setTraceLoading] = useState(false);
	useEffect(() => { setLocalEnabled(enabled); setDraft(criteria); setSavedCriteria(criteria); }, [enabled, criteria, sessionId]);
	const commit = async (nextEnabled: boolean, nextCriteria: string) => {
		setSaving(true);
		try {
			if (await onSettingsChange(nextEnabled, nextCriteria)) {
				setLocalEnabled(nextEnabled);
				setSavedCriteria(nextCriteria);
			}
		} finally { setSaving(false); }
	};
	const query = useQuery({
		queryKey: ['cocode', 'deliveries', sessionId, revision],
		queryFn: () => workspaceApi.cocode.deliveries(sessionId!),
		enabled: Boolean(sessionId),
		retry: false,
	});
	const reports = query.data?.reports ?? [];
	const report: DeliveryReport | undefined = reports.find((item) => item.id === selectedId) ?? reports[0];
	const showTrace = async (traceId: string) => {
		if (openTraceId === traceId) { setOpenTraceId(null); return; }
		setOpenTraceId(traceId);
		setTraceLoading(true);
		try { setTraceMarkdown((await workspaceApi.cocode.traceMarkdown(traceId)).markdown); }
		catch (error) { setTraceMarkdown(String(error)); }
		finally { setTraceLoading(false); }
	};
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-xs">
			<div className="rounded-xl border p-3">
				<div className="flex items-center justify-between gap-2"><div><p className="font-medium">{zh ? '启用可验证交付模式' : 'Enable verifiable delivery mode'}</p><p className="mt-1 text-muted-foreground">{zh ? '开启后，任务会尝试运行相关检查，并在修改后进行模型自审。' : 'When on, the agent attempts relevant checks and self-reviews after changes.'}</p></div><Switch checked={localEnabled} disabled={disabled || saving} onCheckedChange={(checked) => void commit(checked, draft)} aria-label={zh ? '启用可验证交付模式' : 'Enable verifiable delivery mode'} /></div>
				<label className="mt-3 block font-medium" htmlFor="delivery-criteria">{zh ? '验收要点（每行一条）' : 'Acceptance criteria (one per line)'}</label>
				<textarea id="delivery-criteria" className="mt-1 min-h-20 w-full resize-y rounded-lg border bg-background p-2" maxLength={1200} value={draft} disabled={disabled || saving} onChange={(e) => setDraft(e.target.value)} placeholder={zh ? '例如：相关单元测试通过' : 'For example: related unit tests pass'} />
				<Button size="sm" variant="outline" disabled={disabled || saving || draft === savedCriteria} onClick={() => void commit(localEnabled, draft)}>{zh ? '保存要点' : 'Save criteria'}</Button>
				{!sessionId ? <p className="mt-2 text-muted-foreground">{zh ? '设置会随第一条消息创建会话并生效。' : 'These settings take effect when the first message creates a session.'}</p> : null}
			</div>
			<div className="flex items-center justify-between gap-2">
				<p className="text-muted-foreground">{zh ? '每轮完成后自动记录实际改动与验证证据' : 'Actual changes and verification evidence per run'}</p>
				<Button variant="ghost" size="icon-sm" disabled={!sessionId} onClick={() => void query.refetch()} aria-label={zh ? '刷新交付报告' : 'Refresh delivery reports'}><RefreshCw className="size-4" /></Button>
			</div>
			{query.isError ? <p className="text-destructive">{String(query.error)}</p> : null}
			{!report ? <PanelEmpty icon={ClipboardCheck} title={!sessionId ? (zh ? '尚未创建会话' : 'No session yet') : query.isPending ? (zh ? '正在读取…' : 'Loading…') : (zh ? '还没有交付报告' : 'No delivery reports yet')} description={zh ? '发送一次任务后会自动生成。' : 'A report is created after a task run.'} /> : (
				<>
					{reports.length > 1 ? <select className="w-full rounded-lg border bg-background px-2 py-1.5" value={report.id} onChange={(e) => setSelectedId(e.target.value)} aria-label={zh ? '选择运行' : 'Select run'}>{reports.map((item) => <option key={item.id} value={item.id}>{new Date(item.startedAt).toLocaleString()} · {statusLabel(item.outcome)}</option>)}</select> : null}
					<div className="rounded-xl border p-3">
						<div className="flex items-center justify-between gap-2"><span>{new Date(report.startedAt).toLocaleString()}</span><Badge variant="outline">{statusLabel(report.outcome)}</Badge></div>
						<p className="mt-2 text-muted-foreground">{zh ? '交付模式' : 'Delivery mode'}：{report.modeEnabled ? (zh ? '已启用' : 'on') : (zh ? '未启用（仍记录证据）' : 'off (evidence still recorded)')}</p>
						<p className="mt-2 text-muted-foreground">{zh ? '运行前后净变化' : 'Net changes after run'}：{report.changedFileCount} {zh ? '个文件' : 'files'}</p>
						<p className="text-muted-foreground">{zh ? '可核实的验证命令' : 'Verifiable checks'}：{report.checks.length}</p>
					</div>
					{report.criteria?.length ? <section><h4 className="mb-1 font-medium">{zh ? '本轮验收要点' : 'Acceptance criteria for this run'}</h4>{report.criteria.map((item, index) => <p key={index} className="mb-1 text-muted-foreground">• {item}</p>)}</section> : null}
					<section><h4 className="mb-1 font-medium">{zh ? '实际执行的验证' : 'Checks actually run'}</h4>{report.checks.length ? report.checks.map((check, index) => <div key={`${index}-${check.command}`} className="mb-1 rounded-lg border p-2"><Badge variant={check.status === 'passed' ? 'secondary' : 'outline'}>{statusLabel(check.status)}</Badge><code className="ml-2 break-all">{check.command}</code></div>) : <p className="text-muted-foreground">{zh ? '没有可核实的验证记录' : 'No verifiable checks found'}</p>}</section>
					{report.traceId ? <section><Button size="sm" variant="outline" onClick={() => void showTrace(report.traceId!)}>{openTraceId === report.traceId ? (zh ? '收起运行记录' : 'Hide run trace') : (zh ? '查看运行记录原文' : 'View run trace')}</Button>{openTraceId === report.traceId ? <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg border p-2 text-[11px]">{traceLoading ? (zh ? '正在读取…' : 'Loading…') : traceMarkdown}</pre> : null}</section> : null}
					{report.modelReview ? <section><h4 className="mb-1 font-medium">{zh ? '模型自审（不能替代测试）' : 'Model self-review (not a test)'}</h4><p><Badge variant="outline">{statusLabel(report.modelReview.status)}</Badge><span className="ml-2 text-muted-foreground">{report.modelReview.reason}</span></p>{report.modelReview.issues.map((issue, index) => <p key={index} className="mt-1 text-muted-foreground">• {issue}</p>)}</section> : null}
					<section><h4 className="mb-1 font-medium">{zh ? '文件差异' : 'File changes'}</h4>{report.changedFiles.length ? report.changedFiles.map((file) => <div key={file.path} className="flex gap-2 border-b py-1"><span className="shrink-0 text-muted-foreground">{zh ? ({ added: '新增', modified: '修改', deleted: '删除' } as Record<string, string>)[file.change] : file.change}</span><code className="break-all">{file.path}</code></div>) : <p className="text-muted-foreground">{zh ? '扫描范围内无文件差异' : 'No file changes in scan scope'}</p>}</section>
					<section><h4 className="mb-1 font-medium">{zh ? '范围与限制' : 'Scope and limitations'}</h4>{(zh ? report.warnings : report.warningsEn ?? report.warnings).map((warning, index) => <p key={index} className="mb-1 text-muted-foreground">• {warning}</p>)}</section>
				</>
			)}
		</div>
	);
}
