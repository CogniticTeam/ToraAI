import { useQuery } from '@tanstack/react-query';
import { Radar, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { workspaceApi } from '@/api';
import { PanelEmpty } from '@/components/panel/PanelEmpty';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/useI18n';

interface Props { sessionId: string | null; cwd: string | null; revision: number }

export function ImpactPanel({ sessionId, cwd, revision }: Props) {
	const { i18n } = useTranslation();
	const zh = i18n.language.startsWith('zh');
	const [input, setInput] = useState('');
	const [paths, setPaths] = useState<string[]>([]);
	const query = useQuery({
		queryKey: ['cocode', 'impact', sessionId, cwd, revision, paths],
		queryFn: () => workspaceApi.cocode.impact(sessionId!, paths),
		enabled: Boolean(sessionId && cwd),
		retry: false,
	});
	if (!sessionId || !cwd) return <PanelEmpty icon={Radar} title={zh ? '先选择项目文件夹' : 'Choose a project folder'} />;
	const data = query.data;
	return <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-xs">
		<p className="text-muted-foreground">{zh ? '静态推断变更的影响范围；不会执行测试。' : 'Static impact estimate; no tests are run.'}</p>
		<div className="flex gap-2"><input className="min-w-0 flex-1 rounded-lg border bg-background px-2 py-1.5" value={input} onChange={(e) => setInput(e.target.value)} placeholder={zh ? '相对路径，逗号分隔（留空分析 Git 改动）' : 'Relative paths, comma-separated (blank = Git changes)'} aria-label={zh ? '分析目标路径' : 'Target paths'} /><Button size="sm" variant="outline" onClick={() => setPaths(input.split(/[\n,]/).map((part) => part.trim()).filter(Boolean))}>{zh ? '分析' : 'Analyze'}</Button><Button size="icon-sm" variant="ghost" onClick={() => void query.refetch()} aria-label={zh ? '刷新分析' : 'Refresh analysis'}><RefreshCw className="size-4" /></Button></div>
		{paths.length ? <Button size="sm" variant="ghost" className="self-start" onClick={() => { setInput(''); setPaths([]); }}>{zh ? '改为当前 Git 改动' : 'Use current Git changes'}</Button> : null}
		{query.isError ? <p className="text-destructive">{String(query.error)}</p> : null}
		{query.isPending ? <p className="text-muted-foreground">{zh ? '正在分析…' : 'Analyzing…'}</p> : null}
		{data ? <>
			<div className="rounded-xl border p-3"><div className="flex items-center justify-between"><span className="font-medium">{zh ? '风险提示' : 'Risk signal'}</span><Badge variant="outline">{zh ? ({ high: '较高', medium: '中等', low: '较低', unknown: '未知' } as Record<string, string>)[data.risk] : data.risk}</Badge></div><p className="mt-1 text-muted-foreground">{(zh ? data.reasons : data.reasonsEn ?? data.reasons).join(zh ? '；' : '; ')}</p><p className="mt-1 text-muted-foreground">{zh ? `扫描 ${data.scannedFiles} 个源码文件` : `${data.scannedFiles} source files scanned`}</p></div>
			<section><h4 className="mb-1 font-medium">{zh ? '目标文件' : 'Target files'} ({data.targets.length})</h4>{data.targets.length ? data.targets.map((path) => <code key={path} className="block break-all border-b py-1">{path}</code>) : <p className="text-muted-foreground">{zh ? '没有待分析的改动，可手动输入路径。' : 'No changes found. Enter paths manually.'}</p>}</section>
			<section><h4 className="mb-1 font-medium">{zh ? '可能受影响的文件' : 'Potentially affected files'} ({data.affected.length})</h4>{data.affected.map((item) => <div key={item.path} className="border-b py-1"><code className="break-all">{item.path}</code><p className="text-muted-foreground">{zh ? '经由' : 'via'} {item.via} · {item.depth} {zh ? '层' : 'hops'}</p></div>)}</section>
			<section><h4 className="mb-1 font-medium">{zh ? '建议检查（未运行）' : 'Suggested checks (not run)'}</h4>{data.suggestedTests.length ? data.suggestedTests.map((path) => <code key={path} className="block break-all border-b py-1">{path}</code>) : <p className="text-muted-foreground">{zh ? '没有通过静态依赖或同名规则找到测试文件' : 'No tests found via imports or matching names'}</p>}</section>
			<section><h4 className="mb-1 font-medium">{zh ? '分析限制' : 'Limitations'}</h4>{(zh ? data.warnings : data.warningsEn ?? data.warnings).map((warning, index) => <p key={index} className="mb-1 text-muted-foreground">• {warning}</p>)}</section>
		</> : null}
	</div>;
}
