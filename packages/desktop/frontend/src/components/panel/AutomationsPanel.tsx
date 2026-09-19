// 事件触发自动化面板：管理「当 X 发生时做 Y」规则
//
// 规则 = 事件（UserPromptSubmit/PreToolUse/PostToolUse/Stop）+ matcher（工具名过滤）
//        + 动作列表（command 跑命令 / checkpoint 建检查点 / notify 推通知）
// 与 hooks 的区别：hooks 是低层权限决策脚本，automations 是高层副作用规则，无需写脚本。

import { Bell, Play, Plus, Power, Trash2, Zap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { automationsApi, type Automation, type AutomationAction } from '@/api/automations';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useTranslation } from '@/i18n/useI18n';

const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];

interface AutomationsPanelProps {
	sessionId: string | null;
}

export function AutomationsPanel({ sessionId }: AutomationsPanelProps) {
	const { i18n } = useTranslation();
	const zh = i18n.language.startsWith('zh');
	const [rules, setRules] = useState<Automation[]>([]);
	const [notifications, setNotifications] = useState<{ id: string; message: string; at: number }[]>([]);

	// 新建规则的表单态
	const [name, setName] = useState('');
	const [event, setEvent] = useState('PostToolUse');
	const [matcher, setMatcher] = useState('*');
	const [actionType, setActionType] = useState<'notify' | 'checkpoint' | 'command'>('notify');
	const [actionArg, setActionArg] = useState('');

	const refresh = useCallback(async () => {
		try {
			const r = await automationsApi.list();
			setRules(r.automations);
		} catch { /* 后端无此端点 */ }
	}, []);

	useEffect(() => { void refresh(); }, [refresh]);

	// 轮询通知（自动化 notify 动作产出）
	useEffect(() => {
		if (!sessionId) return;
		const tick = async () => {
			try {
				const r = await automationsApi.notifications(sessionId);
				if (r.notifications.length) setNotifications((prev) => [...r.notifications, ...prev].slice(0, 30));
			} catch { /* ignore */ }
		};
		void tick();
		const t = setInterval(tick, 4000);
		return () => clearInterval(t);
	}, [sessionId]);

	const createRule = async () => {
		if (!name.trim()) return;
		const actions: AutomationAction[] = [];
		if (actionType === 'notify' && actionArg.trim()) actions.push({ type: 'notify', message: actionArg.trim() });
		else if (actionType === 'checkpoint') actions.push({ type: 'checkpoint' });
		else if (actionType === 'command' && actionArg.trim()) actions.push({ type: 'command', command: actionArg.trim() });
		try {
			await automationsApi.create({ name: name.trim(), event, matcher: matcher.trim() || '*', actions });
			toast.success(zh ? '规则已创建' : 'Rule created');
			setName(''); setActionArg('');
			void refresh();
		} catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
	};

	const toggle = async (r: Automation) => {
		try {
			await automationsApi.update(r.id, { enabled: !r.enabled });
			void refresh();
		} catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
	};

	const remove = async (id: string) => {
		try {
			await automationsApi.remove(id);
			void refresh();
		} catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
	};

	const actionLabel = (a: AutomationAction) => {
		if (a.type === 'command') return `${zh ? '命令' : 'Command'}: ${a.command}`;
		if (a.type === 'checkpoint') return zh ? '建检查点' : 'Create checkpoint';
		return `${zh ? '通知' : 'Notify'}: ${a.message}`;
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2 pb-2 text-[11px]">
			{/* 新建规则 */}
			<div className="flex flex-col gap-1 rounded-md border p-2">
				<div className="flex items-center gap-1">
					<Zap className="size-3.5 text-muted-foreground" />
					<span className="font-medium">{zh ? '新建规则' : 'New rule'}</span>
				</div>
				<div className="flex flex-col gap-1">
					<Input value={name} onChange={(e) => setName(e.target.value)} placeholder={zh ? '规则名称' : 'Rule name'} className="h-7 text-[11px]" />
					<div className="flex gap-1">
						<Select value={event} onValueChange={setEvent}>
							<SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
							<SelectContent>
								{EVENTS.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
							</SelectContent>
						</Select>
						<Input value={matcher} onChange={(e) => setMatcher(e.target.value)} placeholder="matcher (*)" className="h-7 w-24 text-[11px]" />
					</div>
					<div className="flex gap-1">
						<Select value={actionType} onValueChange={(v) => setActionType(v as 'notify' | 'checkpoint' | 'command')}>
							<SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
							<SelectContent>
								<SelectItem value="notify">{zh ? '通知' : 'Notify'}</SelectItem>
								<SelectItem value="checkpoint">{zh ? '建检查点' : 'Create checkpoint'}</SelectItem>
								<SelectItem value="command">{zh ? '跑命令' : 'Run command'}</SelectItem>
							</SelectContent>
						</Select>
						{actionType !== 'checkpoint' ? (
							<Input
								value={actionArg}
								onChange={(e) => setActionArg(e.target.value)}
								placeholder={actionType === 'notify' ? (zh ? '通知内容' : 'Notification') : (zh ? 'shell 命令' : 'Shell command')}
								className="h-7 flex-1 text-[11px]"
							/>
						) : null}
						<Button size="sm" onClick={() => void createRule()}><Plus className="size-3" /> {zh ? '建' : 'Create'}</Button>
					</div>
				</div>
			</div>

			{/* 规则列表 */}
			<div className="flex flex-col gap-1 overflow-auto">
				{rules.map((r) => (
					<div key={r.id} className={'rounded-md border px-2 py-1.5 ' + (r.enabled ? '' : 'opacity-50')}>
						<div className="flex items-center gap-1">
							<Button variant="ghost" size="icon-sm" onClick={() => void toggle(r)} aria-label={zh ? '开关' : 'Toggle'}>
								<Power className={'size-3 ' + (r.enabled ? 'text-green-500' : 'text-muted-foreground')} />
							</Button>
							<span className="font-medium">{r.name}</span>
							<span className="rounded bg-muted px-1 text-[10px]">{r.event}</span>
							{r.matcher !== '*' ? <span className="text-[10px] text-muted-foreground">{r.matcher}</span> : null}
							<Button variant="ghost" size="icon-sm" className="ml-auto" onClick={() => void remove(r.id)} aria-label={zh ? '删除' : 'Delete'}>
								<Trash2 className="size-3" />
							</Button>
						</div>
						<div className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
							{r.actions.map((a, i) => (
								<span key={i} className="rounded bg-muted px-1">{actionLabel(a)}</span>
							))}
						</div>
					</div>
				))}
				{rules.length === 0 ? (
					<div className="px-2 py-3 text-center text-muted-foreground">{zh ? '还没有自动化规则' : 'No automation rules yet'}</div>
				) : null}
			</div>

			{/* 通知流 */}
			{notifications.length > 0 ? (
				<div className="flex flex-col gap-1">
					<div className="flex items-center gap-1 px-1 text-[10px] uppercase text-muted-foreground">
						<Bell className="size-3" /> {zh ? '通知' : 'Notifications'}
					</div>
					{notifications.map((n) => (
						<div key={n.id} className="flex items-center gap-1 rounded bg-muted px-2 py-1">
							<Play className="size-3 text-primary" />
							<span className="truncate">{n.message}</span>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
