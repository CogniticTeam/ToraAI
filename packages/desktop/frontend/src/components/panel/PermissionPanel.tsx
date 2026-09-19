import type { PermissionContext } from '@agentscope-ai/agentscope/permission';
import { Ban, CircleHelp, FolderOpen, Plus, ShieldCheck, ShieldX, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { permissionApi, type PermissionRuleRecord } from '@/api';
import { PanelEmpty } from '@/components/panel/PanelEmpty';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownSelect } from '@/components/ui/dropdown-select';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n/useI18n';

/** The behavior keys we render sections for (excludes ``passthrough``). */
type RuleBehavior = 'allow' | 'deny' | 'ask';

interface PermissionPanelProps {
	/**
	 * The session's permission context (mode + working directories).
	 * Pass ``null`` when no data is available yet.
	 */
	permissionContext: PermissionContext | null;
}

/** i18n key suffix for each behavior group title. */
const BEHAVIOR_META: Record<RuleBehavior, { i18nKey: string; icon: typeof ShieldCheck }> = {
	allow: { i18nKey: 'panel.permission.allow', icon: ShieldCheck },
	deny: { i18nKey: 'panel.permission.deny', icon: Ban },
	ask: { i18nKey: 'panel.permission.ask', icon: CircleHelp },
};

// 工具清单：与 core 的 builtin.js 注册表保持同步（PascalCase）。
// 下拉里给出全部内置工具；自定义工具仍可在表单外的场景通过确认卡固化。
const TOOL_CHOICES = [
	'Bash',
	'Read',
	'Write',
	'Edit',
	'Glob',
	'Grep',
	'WebFetch',
	'WebSearch',
	'Git',
	'RepoMap',
	'Checkpoint',
	'Lsp',
	'Search',
	'Browser',
];

/**
 * A monospace value (a path or rule pattern) that truncates to fit its
 * row. When (and only when) the text is actually clipped, hovering
 * reveals the full value in a tooltip anchored to the left.
 */
function TruncatedCode({ value }: { value: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	const [truncated, setTruncated] = useState(false);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const check = () => setTruncated(el.scrollWidth > el.clientWidth);
		check();
		const observer = new ResizeObserver(check);
		observer.observe(el);
		return () => observer.disconnect();
	}, [value]);

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span ref={ref} className="min-w-0 flex-1 truncate text-left font-mono text-xs">
					{value}
				</span>
			</TooltipTrigger>
			{truncated ? (
				<TooltipContent side="left" className="max-w-sm font-mono break-all">
					{value}
				</TooltipContent>
			) : null}
		</Tooltip>
	);
}

interface IndexedRule extends PermissionRuleRecord {
	/** Index into the full server-side list — what DELETE keys on. */
	index: number;
}

/**
 * One tool's rule card: header naming the tool, one row per rule, and a
 * delete button per row. Deletion is immediate (no confirm) — rules are
 * one click to recreate, and the panel refreshes from the server.
 */
function ToolRuleCard({ toolName, rules, onDelete }: { toolName: string; rules: IndexedRule[]; onDelete: (index: number) => void }) {
	const { t } = useTranslation();
	return (
		<div className="rounded-md border">
			<div className="flex items-center gap-x-2 border-b px-2 py-1.5 text-sm font-medium">
				{toolName}
				<Badge variant="secondary" className="ml-auto">
					{rules.length}
				</Badge>
			</div>
			<ul className="flex flex-col">
				{rules.map((rule) => (
					<li
						key={`${rule.index}-${rule.rule_content ?? '*'}`}
						className="group flex items-center justify-between gap-x-2 px-2 py-1.5 text-xs not-last:border-b"
					>
						{rule.rule_content ? (
							<TruncatedCode value={rule.rule_content} />
						) : (
							<span className="min-w-0 flex-1 text-muted-foreground">
								{t('panel.permission.anyInvocation')}
							</span>
						)}
						<Badge variant="outline" className="shrink-0">
							{rule.source}
						</Badge>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={t('panel.permission.deleteRule')}
							title={t('panel.permission.deleteRule')}
							className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
							onClick={() => onDelete(rule.index)}
						>
							<Trash2 />
						</Button>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * The Permission dock panel body. Two halves:
 *  - session context (mode badge lives in the panel header; working dirs here);
 *  - the persisted rule list (GET/POST/DELETE /permission/rules) with an
 *    add form — these are what `decidePermission` actually consults, for
 *    every session, so managing them here beats editing config.json.
 */
export function PermissionPanel({ permissionContext }: PermissionPanelProps) {
	const { t } = useTranslation();
	const workingDirs = Object.values(permissionContext?.working_directories ?? {});

	const [rules, setRules] = useState<IndexedRule[] | null>(null);
	const [loadErr, setLoadErr] = useState<string | null>(null);
	const [tool, setTool] = useState(TOOL_CHOICES[0]);
	const [behavior, setBehavior] = useState<RuleBehavior>('allow');
	const [content, setContent] = useState('');
	const [busy, setBusy] = useState(false);
	const [formErr, setFormErr] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const r = await permissionApi.list();
			setRules((r.rules ?? []).map((rule, index) => ({ ...rule, index })));
			setLoadErr(null);
		} catch (e) {
			setLoadErr(e instanceof Error ? e.message : String(e));
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const handleAdd = async () => {
		setBusy(true);
		setFormErr(null);
		try {
			const r = await permissionApi.add({
				tool_name: tool,
				rule_content: content.trim(),
				behavior,
				source: 'userSettings',
			});
			setRules((r.rules ?? []).map((rule, index) => ({ ...rule, index })));
			setContent('');
		} catch (e) {
			setFormErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const handleDelete = async (index: number) => {
		setFormErr(null);
		try {
			const r = await permissionApi.remove(index);
			setRules((r.rules ?? []).map((rule, i) => ({ ...rule, index: i })));
		} catch (e) {
			// 列表可能已经和服务端错位（他处增删过）——刷新拿回真实下标
			setFormErr(e instanceof Error ? e.message : String(e));
			void refresh();
		}
	};

	const grouped = (rules ?? []).map((rule, index) => ({ ...rule, index }));
	const byBehavior = (b: RuleBehavior) =>
		Object.entries(
			grouped
				.filter((r) => r.behavior === b)
				.reduce<Record<string, IndexedRule[]>>((acc, r) => {
					(acc[r.tool_name] ??= []).push(r);
					return acc;
				}, {}),
		).filter(([, list]) => list.length > 0);

	return (
		<div className="flex flex-col flex-1 min-h-0 gap-y-3">
			<span className="text-muted-foreground text-sm">
				{t('panel.permission.description')}
			</span>

			<div className="flex flex-col flex-1 min-h-0 overflow-y-auto gap-y-4">
				{/* 工作目录 —— 会话上下文，只读展示 */}
				<div className="flex flex-col gap-y-1.5">
					<div className="flex items-center gap-x-1.5 text-xs font-medium text-muted-foreground">
						<FolderOpen className="size-3.5" />
						{t('panel.permission.workingDirectories')}
					</div>
					{workingDirs.length === 0 ? (
						<p className="text-muted-foreground text-xs px-1 py-2">
							{t('panel.permission.noWorkingDirectories')}
						</p>
					) : (
						<ul className="flex flex-col rounded-md border">
							{workingDirs.map((dir) => (
								<li
									key={dir.path}
									className="flex items-center justify-between gap-x-2 px-2 py-1.5 text-xs not-last:border-b"
								>
									<TruncatedCode value={dir.path} />
									<Badge variant="outline" className="shrink-0">
										{dir.source}
									</Badge>
								</li>
							))}
						</ul>
					)}
				</div>

				{/* 持久规则 —— 权限判定真正查的表，可增删 */}
				<div className="flex flex-col gap-y-1.5">
					<div className="flex items-center gap-x-1.5 text-xs font-medium text-muted-foreground">
						<ShieldCheck className="size-3.5" />
						{t('panel.permission.rulesTitle')}
					</div>

					{/* 添加表单 */}
					<div className="flex flex-col gap-y-2 rounded-md border p-2">
						<div className="flex items-center gap-x-2">
							<DropdownSelect
								className="w-32"
								value={tool}
								onChange={setTool}
								options={TOOL_CHOICES.map((v) => ({ value: v, label: v }))}
							/>
							<DropdownSelect
								className="w-24"
								value={behavior}
								onChange={(v) => setBehavior(v as RuleBehavior)}
								options={[
									{ value: 'allow', label: t('panel.permission.allow') },
									{ value: 'deny', label: t('panel.permission.deny') },
									{ value: 'ask', label: t('panel.permission.ask') },
								]}
							/>
						</div>
						<div className="flex items-center gap-x-2">
							<Input
								value={content}
								onChange={(e) => setContent(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Enter' && !busy) void handleAdd();
								}}
								placeholder={t('panel.permission.contentPlaceholder')}
								className="h-7 flex-1 font-mono text-xs"
								spellCheck={false}
							/>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() => void handleAdd()}
							>
								<Plus />
								{t('panel.permission.addButton')}
							</Button>
						</div>
						{formErr && <div className="text-xs text-destructive">{formErr}</div>}
					</div>

					{loadErr ? (
						<p className="px-1 py-2 text-xs text-destructive">
							{t('panel.permission.loadFailed', { detail: loadErr })}
						</p>
					) : rules !== null && rules.length === 0 ? (
						<PanelEmpty
							icon={ShieldX}
							title={t('panel.permission.emptyTitle')}
							description={t('panel.permission.emptyDescription')}
						/>
					) : (
						(['deny', 'ask', 'allow'] as RuleBehavior[]).map((b) => {
							const entries = byBehavior(b);
							if (entries.length === 0) return null;
							const meta = BEHAVIOR_META[b];
							const Icon = meta.icon;
							return (
								<div key={b} className="flex flex-col gap-y-1.5">
									<div className="flex items-center gap-x-1.5 text-xs font-medium text-muted-foreground">
										<Icon className="size-3.5" />
										{t(meta.i18nKey)}
									</div>
									{entries.map(([toolName, list]) => (
										<ToolRuleCard
											key={toolName}
											toolName={toolName}
											rules={list}
											onDelete={(index) => void handleDelete(index)}
										/>
									))}
								</div>
							);
						})
					)}
				</div>
			</div>
		</div>
	);
}
