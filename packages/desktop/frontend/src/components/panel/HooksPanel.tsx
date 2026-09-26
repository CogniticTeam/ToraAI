import { Webhook } from 'lucide-react';

import type { HooksView } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/useI18n';

interface HooksPanelProps {
	hooks: HooksView | null;
	loading: boolean;
	onRefresh: () => void;
	onTrustProjectHooks?: (trust: boolean) => void;
}

/** 独立的钩子查看和项目级信任入口。 */
export function HooksPanel({ hooks, loading, onRefresh, onTrustProjectHooks }: HooksPanelProps) {
	const { i18n } = useTranslation();
	const zh = i18n.language.startsWith('zh');
	return (
		<div className="flex flex-1 flex-col gap-2 min-h-0 text-xs">
			<div className="flex items-center gap-x-1.5 px-1 text-muted-foreground">
				<Webhook className="size-3.5" />
				<span>{hooks?.rows.length ? (zh ? `${hooks.rows.length} 个生效` : `${hooks.rows.length} active`) : (zh ? '未配置' : 'Not configured')}</span>
				<Button variant="ghost" size="sm" className="ml-auto" onClick={onRefresh} disabled={loading}>
					{zh ? '刷新' : 'Refresh'}
				</Button>
			</div>
			{hooks?.projectHooksPresent && !hooks.projectHooksTrusted ? (
				<div className="rounded-md border border-amber-500 bg-amber-50 dark:bg-amber-950 px-2 py-1.5">
					<p>{zh ? '工作目录里有 .cocode/hooks.json，但未信任项目钩子。请先检查仓库中的命令。' : 'Project hooks are present but not trusted. Review their commands before trusting this workspace.'}</p>
					{onTrustProjectHooks ? <Button variant="outline" size="sm" className="mt-1.5" onClick={() => onTrustProjectHooks(true)}>{zh ? '信任此目录' : 'Trust this workspace'}</Button> : null}
				</div>
			) : null}
			{hooks?.projectHooksTrusted && hooks.projectHooksPresent ? (
				<div className="flex items-center gap-x-2 text-muted-foreground">
					<span>{zh ? '已信任此目录的项目钩子' : 'Project hooks trusted for this workspace'}</span>
					{onTrustProjectHooks ? <Button variant="ghost" size="sm" onClick={() => onTrustProjectHooks(false)}>{zh ? '撤销信任' : 'Revoke trust'}</Button> : null}
				</div>
			) : null}
			{(hooks?.rows ?? []).map((hook, index) => (
				<div key={index} className="rounded-md border px-2 py-1.5">
					<div className="flex items-center gap-x-2">
						<Badge variant="secondary">{hook.event}</Badge>
						<Badge variant="outline">{hook.matcher}</Badge>
						<span className="ml-auto text-muted-foreground">{hook.source}</span>
					</div>
					<div className="mt-1 truncate font-mono text-muted-foreground" title={hook.command}>{hook.command}</div>
				</div>
			))}
			{(hooks?.errors ?? []).map((error, index) => <p key={index} className="text-rose-600 dark:text-rose-400">✗ {error}</p>)}
		</div>
	);
}
