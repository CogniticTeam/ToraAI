import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Blocks, BookOpen, ChevronDown, ChevronRight, FileUp, FolderOpen, Globe2, Plus, Puzzle, Search, Server, type LucideIcon } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import {
	DESKTOP_PLUGINS_QUERY, DesktopPluginError, getDesktopPluginBridge, pluginResult,
	type InstalledPlugin, type NpmRegistry, type PluginInput, type PluginReview, type PluginServer, type PluginSource,
} from '@/api/desktopPlugins';
import { mcpWorkshopApi, type McpServerDef, type McpTemplate } from '@/api/mcp-workshop';
import { skillApi } from '@/api/skill';
import type { SkillView } from '@/api/types';
import { DesktopDiscovery } from '@/components/dialog/DesktopDiscovery';
import { DesktopMcpEditor } from '@/components/dialog/DesktopMcpEditor';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useSkills } from '@/hooks/useSkills';
import { useTranslation } from '@/i18n/useI18n';

function Source({ source }: { source: PluginSource }) {
	const { t } = useTranslation();
	if (source.type === 'npm') return <span className="break-all">{source.spec} · {source.version} · {t(source.registry === 'mirror' ? 'discovery.npmMirror' : 'discovery.npmOfficial')}</span>;
	return <span className="break-all">{source.type === 'github' ? source.url : source.type === 'file' ? source.label : t('desktopPlugins.exampleSource')}</span>;
}

function McpCommands({ servers }: { servers: PluginServer[] }) {
	const { t } = useTranslation();
	if (!servers.length) return null;
	return (
		<div className="space-y-2">
			<p className="font-medium">{t('desktopPlugins.mcp')}</p>
			<p className="text-xs text-muted-foreground">{t('desktopPlugins.mcpNotice')}</p>
			{servers.map(server => (
				<div key={server.name} className="space-y-1">
					<p className="text-xs font-medium">{server.name}</p>
					<pre dir="ltr" className="whitespace-pre-wrap break-all rounded-lg bg-muted p-2 text-xs">{JSON.stringify([server.command, ...server.args], null, 2)}</pre>
				</div>
			))}
		</div>
	);
}

function ReviewCard({ review, busy, onInstall, onCancel }: {
	review: PluginReview;
	busy: boolean;
	onInstall: () => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation();
	const { manifest, previous } = review;
	return (
		<section aria-labelledby="desktop-plugin-review" className="space-y-4 rounded-2xl border bg-card p-5 text-sm">
			<div className="space-y-1">
				<h4 id="desktop-plugin-review" className="text-base font-semibold">{manifest.name}</h4>
				<p className="text-xs text-muted-foreground">
					{previous ? t('desktopPlugins.versionChange', { from: previous.version, to: manifest.version }) : manifest.version}
					{manifest.author && ` · ${manifest.author}`}
				</p>
				<p className="break-words">{manifest.description}</p>
				<p className="text-xs text-muted-foreground"><Source source={review.source} /></p>
			</div>
			{manifest.skills.length > 0 && (
				<div className="space-y-2">
					<p className="font-medium">{t('desktopPlugins.skills')}</p>
					{manifest.skills.map(skill => (
						<details key={skill.name} className="rounded-lg border px-3 py-2">
							<summary className="cursor-pointer break-all font-mono text-xs">/{manifest.id}:{skill.name}</summary>
							<p className="mt-2 break-words text-xs text-muted-foreground">{skill.description}</p>
							<pre className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-xs">{skill.markdown}</pre>
						</details>
					))}
				</div>
			)}
			{manifest.commands.length > 0 && (
				<div className="space-y-2">
					<p className="font-medium">{t('desktopPlugins.commands')}</p>
					{manifest.commands.map(command => (
						<details key={command.name} className="rounded-lg border px-3 py-2">
							<summary className="cursor-pointer break-all font-mono text-xs">/{manifest.id}:{command.name}</summary>
							<p className="mt-2 break-words text-xs text-muted-foreground">{command.description}</p>
							<pre className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-xs">{command.body}</pre>
						</details>
					))}
				</div>
			)}
			<McpCommands servers={manifest.mcpServers} />
			<p className="text-xs text-muted-foreground">{t('desktopPlugins.reviewStatus')}</p>
			<div className="flex flex-wrap justify-end gap-2">
				<Button type="button" variant="outline" size="sm" disabled={busy} onClick={onCancel}>{t('common.cancel')}</Button>
				<Button type="button" size="sm" disabled={busy} onClick={onInstall}>{t(previous ? 'desktopPlugins.replace' : 'desktopPlugins.install')}</Button>
			</div>
		</section>
	);
}

const MCP_SERVERS = ['integration-mcp-servers'] as const;
const groups = [
	{ key: 'plugins', label: 'desktopPlugins.title', icon: Puzzle },
	{ key: 'apps', label: 'integrations.apps', icon: Blocks },
	{ key: 'mcp', label: 'settings.advanced.mcp.title', icon: Server },
	{ key: 'skills', label: 'desktopPlugins.skills', icon: BookOpen },
] as const;
type Group = typeof groups[number]['key'];

type Panel =
	| { kind: 'catalog' }
	| { kind: 'pluginSource' }
	| { kind: 'githubAuth' }
	| { kind: 'mcpJson' }
	| { kind: 'review'; review: PluginReview }
	| { kind: 'plugin'; plugin: InstalledPlugin }
	| { kind: 'skill'; skill: SkillView }
	| { kind: 'mcp'; mode: 'mcp' | 'app'; server?: McpServerDef; template?: McpTemplate }
	| { kind: 'remove'; name: string; action: () => Promise<void>; label: string };

function IntegrationRow({ icon: Icon, name, description, source, enabled, busy, onOpen, onEnabled, testId }: {
	icon: LucideIcon;
	name: string;
	description?: string | null;
	source?: string;
	enabled: boolean;
	busy: boolean;
	onOpen: () => void;
	onEnabled?: (enabled: boolean) => void;
	testId?: string;
}) {
	const { t } = useTranslation();
	return (
		<li className="flex min-w-0 items-center gap-3 px-3 py-2.5 sm:px-4" data-testid={testId}>
			<button type="button" onClick={onOpen}
				className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-1.5 text-start hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring">
				<span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted/45 text-muted-foreground">
					<Icon className="size-4" aria-hidden="true" />
				</span>
				<span className="min-w-0 flex-1">
					<span className="block break-words text-sm font-medium">{name}</span>
					{description && <span className="mt-0.5 block break-words text-xs leading-relaxed text-muted-foreground">{description}</span>}
					{source && <span className="mt-0.5 block break-words text-xs text-muted-foreground">{source}</span>}
				</span>
				<ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden="true" />
			</button>
			<div className="flex shrink-0 items-center gap-3">
				<span className="hidden text-xs text-muted-foreground lg:inline">{t(enabled ? 'desktopPlugins.enabled' : 'desktopPlugins.disabled')}</span>
				{onEnabled
					? <Switch checked={enabled} disabled={busy} aria-label={name} onCheckedChange={onEnabled} />
					: <span className="size-2 rounded-full bg-muted-foreground/45 data-[active=true]:bg-primary" data-active={enabled} aria-hidden="true" />}
			</div>
		</li>
	);
}

function Results({ loading, error, empty, searching, retry, children }: {
	loading: boolean;
	error: Error | null;
	empty: string;
	searching: boolean;
	retry: () => void;
	children: ReactNode[];
}) {
	const { t } = useTranslation();
	if (loading) return <p role="status" className="px-4 py-5 text-sm text-muted-foreground">{t('common.loading')}</p>;
	if (error) return <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border p-4 text-sm">
		<span>{t('common.error')}</span>
		<Button type="button" variant="outline" size="sm" onClick={retry}>{t('error.retry')}</Button>
	</div>;
	if (!children.length) return <p role="status" className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
		{searching ? t('skill.noCardsTitle') : empty}
	</p>;
	return <ul className="divide-y overflow-hidden rounded-xl border bg-card/60">{children}</ul>;
}

function SkillDetails({ skill, remove }: { skill: SkillView; remove: () => void }) {
	const { t } = useTranslation();
	const record = useQuery({ queryKey: ['skills', skill.id], queryFn: () => skillApi.get(skill.id) });
	return (
		<div className="grid gap-4">
			{record.isPending ? <p role="status" className="text-muted-foreground">{t('common.loading')}</p>
				: record.error ? <Button type="button" variant="outline" onClick={() => void record.refetch()}>{t('error.retry')}</Button>
				: record.data?.markdown ? <pre className="max-h-[50dvh] overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-3 text-xs">{record.data.markdown}</pre>
				: <p className="text-muted-foreground">{t('skill.noReadme')}</p>}
			<div className="flex justify-end"><Button type="button" variant="destructive" size="sm" onClick={remove}>{t('desktopPlugins.remove')}</Button></div>
		</div>
	);
}

function GithubAuth({ connected, busy, onConnect, onDisconnect }: {
	connected: boolean; busy: boolean; onConnect: (token: string) => void; onDisconnect: () => void;
}) {
	const { t } = useTranslation();
	const [token, setToken] = useState('');
	return <form className="grid gap-3" onSubmit={event => {
		event.preventDefault();
		if (!token.trim() || busy) return;
		onConnect(token.trim());
		setToken('');
	}}>
		<p className="text-sm text-muted-foreground">{t('discovery.githubTokenHint')}</p>
		<label className="grid gap-1.5 text-xs font-medium">{t('discovery.githubToken')}
			<Input type="password" dir="ltr" autoComplete="off" spellCheck={false} maxLength={2048} value={token} onChange={event => setToken(event.target.value)} />
		</label>
		<a className="justify-self-start text-xs underline" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">{t('discovery.createToken')}</a>
		<div className="flex flex-wrap justify-end gap-2">
			{connected && <Button type="button" variant="destructive" disabled={busy} onClick={onDisconnect}>{t('discovery.disconnect')}</Button>}
			<Button type="submit" disabled={busy || !token.trim()}>{t(busy ? 'common.loading' : 'discovery.connect')}</Button>
		</div>
	</form>;
}

export function DesktopPluginSection({ onClose }: { onClose: () => void }) {
	const { t } = useTranslation();
	const client = useQueryClient();
	const navigate = useNavigate();
	const bridge = getDesktopPluginBridge();
	const fileInput = useRef<HTMLInputElement>(null);
	const fileTarget = useRef<string | undefined>(undefined);
	const searchRef = useRef<HTMLInputElement>(null);
	const returnFocus = useRef<HTMLElement | null>(null);
	const [group, setGroup] = useState<Group>('plugins');
	const [search, setSearch] = useState('');
	const [sourceInput, setSourceInput] = useState('');
	const [pluginSource, setPluginSource] = useState<'github' | 'npm'>('github');
	const [registry, setRegistry] = useState<NpmRegistry>('npm');
	const [mcpJson, setMcpJson] = useState('');
	const [mcpScope, setMcpScope] = useState<'all' | 'local' | 'remote'>('all');
	const [panel, setPanel] = useState<Panel | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const plugins = useQuery({
		queryKey: [...DESKTOP_PLUGINS_QUERY, 'installed'],
		queryFn: () => pluginResult(bridge?.list()),
		enabled: Boolean(bridge),
	});
	const mcp = useQuery({ queryKey: MCP_SERVERS, queryFn: () => mcpWorkshopApi.listServers() });
	const skills = useSkills();

	const installed = plugins.data ?? [];
	const servers = mcp.data?.servers ?? [];
	const githubConnected = servers.some(server => server.provider === 'github');
	const apps = servers.flatMap(server => server.application ? [{ server, application: server.application }] : []);
	const contributedSkills = installed.flatMap(plugin => plugin.skills.map(skill => ({ plugin, skill })));
	const contributedServers = installed.flatMap(plugin => plugin.mcpServers.map(server => ({ plugin, server })));
	const counts = {
		plugins: plugins.data?.length,
		apps: mcp.data ? apps.length : undefined,
		mcp: mcp.data ? servers.length + contributedServers.length : undefined,
		skills: !skills.loading && !skills.error ? skills.skills.length + contributedSkills.length : undefined,
	};
	const needle = search.trim().toLocaleLowerCase();
	const matches = (...parts: (string | null | undefined)[]) => parts.join(' ').toLocaleLowerCase().includes(needle);
	const fromPlugin = (plugin: InstalledPlugin) => t('integrations.fromPlugin', { name: plugin.name });
	const refreshPlugins = () => client.invalidateQueries({ queryKey: DESKTOP_PLUGINS_QUERY });
	const refreshMcp = () => client.invalidateQueries({ queryKey: MCP_SERVERS });
	const refreshSkills = () => client.invalidateQueries({ queryKey: ['skills'] });

	function show(next: Panel | null) {
		if (!panel && next && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
			returnFocus.current = document.activeElement;
		}
		setError(null);
		setNotice(null);
		setPanel(next);
	}

	function selectGroup(next: Group) {
		if (next === group) return;
		setGroup(next);
		setSearch('');
		setError(null);
		setNotice(null);
	}

	async function perform(action: () => Promise<void>) {
		setBusy(true);
		setError(null);
		setNotice(null);
		try { await action(); }
		catch (cause) {
			if (cause instanceof DesktopPluginError) {
				if (cause.message !== 'cancelled') setError(t(`desktopPlugins.errors.${cause.message}`, { defaultValue: t('desktopPlugins.errors.unexpected') }));
			} else setError(cause instanceof Error ? cause.message : t('common.error'));
		} finally { setBusy(false); }
	}

	function showReview(review: PluginReview) {
		if (review.reviewId) {
			selectGroup('plugins');
			show({ kind: 'review', review });
		} else setNotice(t('desktopPlugins.unchanged'));
	}

	async function preview(input: PluginInput) {
		showReview(await pluginResult(bridge?.preview(input)));
	}

	function chooseFile(expectedId?: string) {
		fileTarget.current = expectedId;
		fileInput.current?.click();
	}

	function importSkill() {
		const chooseFolder = (window as Window & { toraWindow?: { openFolderDialog?: () => Promise<string | null> } }).toraWindow?.openFolderDialog;
		void perform(async () => {
			const directory = await chooseFolder?.();
			if (!directory) return;
			await skillApi.importLocal(directory);
			selectGroup('skills');
			await refreshSkills();
		});
	}

	const confirmRemoval = (name: string, label: string, action: () => Promise<void>) => {
		show({ kind: 'remove', name, label, action });
	};

	function togglePlugin(plugin: InstalledPlugin, enabled: boolean) {
		void perform(async () => {
			await pluginResult(bridge?.setEnabled(plugin.id, plugin.revision, enabled));
			await refreshPlugins();
		});
	}

	function toggleMcp(server: McpServerDef, enabled: boolean) {
		void perform(async () => {
			await mcpWorkshopApi.updateServer(server.name, { enabled });
			await refreshMcp();
		});
	}

	function openEditor(mode: 'mcp' | 'app', server?: McpServerDef, template?: McpTemplate) {
		selectGroup(mode === 'app' ? 'apps' : 'mcp');
		show({ kind: 'mcp', mode, server, template });
	}

	function renderPanel(current: Panel) {
		switch (current.kind) {
			case 'catalog':
				return <>
					<DialogTitle>{t('discovery.title')}</DialogTitle>
					<DesktopDiscovery initial={group} installed={installed} githubConnected={githubConnected} busy={busy}
						onPreview={input => void perform(() => preview(input))} onMcp={template => openEditor('mcp', undefined, template)}
						onGithub={() => show({ kind: 'githubAuth' })} onSkills={() => { onClose(); navigate('/skill'); }} />
				</>;
			case 'pluginSource':
				return <>
					<DialogTitle>{t('discovery.addPlugin')}</DialogTitle>
					<form className="grid gap-3" onSubmit={event => {
						event.preventDefault();
						if (sourceInput.trim() && !busy) void perform(() => preview(pluginSource === 'github'
							? { type: 'github', url: sourceInput.trim() } : { type: 'npm', spec: sourceInput.trim(), registry }));
					}}>
						<select aria-label={t('discovery.installSource')} className="h-9 rounded-lg border bg-background px-2" value={pluginSource} disabled={busy} onChange={event => { setPluginSource(event.target.value === 'npm' ? 'npm' : 'github'); setSourceInput(''); }}>
							<option value="github">GitHub</option><option value="npm">{t('discovery.npmPackage')}</option>
						</select>
						<Input type={pluginSource === 'github' ? 'url' : 'text'} aria-label={t(pluginSource === 'github' ? 'desktopPlugins.github' : 'discovery.npmPackage')} dir="ltr" placeholder={pluginSource === 'github' ? 'https://github.com/owner/repository' : '@owner/tora-plugin@1.0.0'} required maxLength={2048}
							value={sourceInput} disabled={busy} onChange={event => setSourceInput(event.target.value)} />
						{pluginSource === 'npm' && <select aria-label={t('discovery.packageRegistry')} className="h-9 rounded-lg border bg-background px-2" value={registry} disabled={busy} onChange={event => setRegistry(event.target.value === 'mirror' ? 'mirror' : 'npm')}>
							<option value="npm">{t('discovery.npmOfficial')}</option><option value="mirror">{t('discovery.npmMirror')}</option>
						</select>}
						<Button type="submit" className="justify-self-end" disabled={busy || !sourceInput.trim()}>{t(busy ? 'common.loading' : 'desktopPlugins.preview')}</Button>
					</form>
					<div className="flex flex-wrap gap-2 border-t pt-3">
						<Button type="button" variant="outline" disabled={busy} onClick={() => void perform(async () => showReview(await pluginResult(bridge?.previewDirectory())))}><FolderOpen />{t('discovery.localFolder')}</Button>
						<Button type="button" variant="outline" disabled={busy} onClick={() => chooseFile()}><FileUp />{t('desktopPlugins.importFile')}</Button>
					</div>
				</>;
			case 'mcpJson':
				return <>
					<DialogTitle>{t('discovery.importMcp')}</DialogTitle>
					<p className="text-xs text-muted-foreground">{t('discovery.importMcpHint')}</p>
					<form className="grid gap-3" onSubmit={event => {
						event.preventDefault();
						if (!mcpJson.trim() || busy) return;
						void perform(async () => {
							await mcpWorkshopApi.importServers(mcpJson);
							await refreshMcp();
							setMcpJson(''); setMcpScope('all'); selectGroup('mcp'); show(null);
						});
					}}>
						<Textarea dir="ltr" spellCheck={false} rows={11} maxLength={128 * 1024} aria-label={t('discovery.importMcp')}
							value={mcpJson} onChange={event => setMcpJson(event.target.value)} className="font-mono text-xs"
							placeholder={JSON.stringify({ mcpServers: { example: { url: 'https://example.com/mcp' } } }, null, 2)} />
						<Button type="submit" className="justify-self-end" disabled={busy || !mcpJson.trim()}>{t('common.add')}</Button>
					</form>
				</>;
			case 'githubAuth':
				return <>
					<DialogTitle>GitHub</DialogTitle>
					<DialogDescription>{t('discovery.githubDesc')}</DialogDescription>
					<GithubAuth connected={githubConnected} busy={busy} onConnect={token => void perform(async () => {
						await pluginResult(bridge?.connectGithub(token));
						await refreshMcp(); selectGroup('apps'); show(null);
					})} onDisconnect={() => confirmRemoval('GitHub', 'discovery.disconnect', async () => {
						await pluginResult(bridge?.disconnectGithub());
						await refreshMcp();
					})} />
				</>;
			case 'review':
				return <>
					<DialogTitle>{t('desktopPlugins.preview')}</DialogTitle>
					<ReviewCard review={current.review} busy={busy} onCancel={() => show(null)} onInstall={() => void perform(async () => {
						if (!current.review.reviewId) return;
						await pluginResult(bridge?.install(current.review.reviewId));
						await refreshPlugins();
						show(null);
					})} />
				</>;
			case 'plugin': {
				const { plugin } = current;
				return <>
					<DialogHeader>
						<DialogTitle>{plugin.name}</DialogTitle>
						<DialogDescription>{plugin.version}{plugin.author && ` · ${plugin.author}`}</DialogDescription>
					</DialogHeader>
					<p className="break-words">{plugin.description}</p>
					<p className="text-xs text-muted-foreground"><Source source={plugin.source} /></p>
					{plugin.skills.length > 0 && <p className="break-words text-xs">{t('desktopPlugins.skills')} · {plugin.skills.map(skill => `/${plugin.id}:${skill.name}`).join(', ')}</p>}
					{plugin.commands.length > 0 && <p className="break-words text-xs">{t('desktopPlugins.commands')} · {plugin.commands.map(command => `/${plugin.id}:${command.name}`).join(', ')}</p>}
					<McpCommands servers={plugin.mcpServers} />
					<div className="flex flex-wrap justify-end gap-2">
						<Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => {
							const source = plugin.source;
							if (source.type === 'file') chooseFile(plugin.id);
							else void perform(() => preview({ ...source, expectedId: plugin.id }));
						}}>{t(plugin.source.type === 'file' ? 'desktopPlugins.updateFile' : 'desktopPlugins.checkUpdate')}</Button>
						<Button variant="destructive" size="sm" type="button" disabled={busy} onClick={() => confirmRemoval(plugin.name, 'desktopPlugins.remove', async () => {
							await pluginResult(bridge?.remove(plugin.id, plugin.revision));
							await refreshPlugins();
						})}>{t('desktopPlugins.remove')}</Button>
					</div>
				</>;
			}
			case 'skill': {
				const { skill } = current;
				const name = skill.display_name ?? skill.name;
				return <>
					<DialogTitle>{name}</DialogTitle>
					{skill.description && <DialogDescription>{skill.description}</DialogDescription>}
					<SkillDetails skill={skill} remove={() => confirmRemoval(name, 'desktopPlugins.remove', async () => { await skills.remove(skill.id); })} />
				</>;
			}
			case 'mcp': {
				const { mode, server, template } = current;
				const name = mode === 'app' ? server?.application?.name : server?.name;
				return <>
					<DialogHeader>
						<DialogTitle>{name ?? t(mode === 'app' ? 'integrations.addApp' : 'integrations.configureMcp')}</DialogTitle>
						<DialogDescription>{t(mode === 'app' ? 'integrations.linkDesc' : 'integrations.serverDesc')}</DialogDescription>
					</DialogHeader>
					<DesktopMcpEditor mode={mode} server={server} template={template} servers={servers}
						onCancel={() => show(null)} onSaved={async () => { await refreshMcp(); show(null); }} />
					{server && <Button size="sm" type="button" variant="ghost" className="justify-self-start text-destructive"
						onClick={() => confirmRemoval(name ?? server.name, mode === 'app' ? 'integrations.unlinkApp' : 'common.delete', async () => {
							if (mode === 'app') await mcpWorkshopApi.updateServer(server.name, { application: null });
							else await mcpWorkshopApi.removeServer(server.name);
							await refreshMcp();
						})}>{t(mode === 'app' ? 'integrations.unlinkApp' : 'common.delete')}</Button>}
				</>;
			}
			case 'remove':
				return <>
					<DialogTitle>{t(current.label)}</DialogTitle>
					<DialogDescription>{current.label === 'discovery.disconnect' ? t('discovery.disconnectHint')
						: current.label === 'integrations.unlinkApp' ? current.name : t('desktopPlugins.confirmRemove', { name: current.name })}</DialogDescription>
					<div className="flex justify-end gap-2">
						<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => show(null)}>{t('common.cancel')}</Button>
						<Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void perform(async () => {
							await current.action();
							show(null);
						})}>{t(current.label)}</Button>
					</div>
				</>;
		}
	}

	const pluginRows = installed.filter(plugin => matches(plugin.name, plugin.id, plugin.description, plugin.author, plugin.version)).map(plugin => (
		<IntegrationRow key={plugin.id} testId={`desktop-plugin-${plugin.id}`} icon={Puzzle} name={plugin.name} description={plugin.description}
			source={[plugin.version, plugin.author].filter(Boolean).join(' · ')} enabled={plugin.enabled} busy={busy}
			onOpen={() => show({ kind: 'plugin', plugin })} onEnabled={enabled => togglePlugin(plugin, enabled)} />
	));
	const appRows = apps.filter(({ application, server }) => matches(application.name, application.description, application.website, server.name)).map(({ application, server }) => (
		<IntegrationRow key={server.name} icon={Globe2} name={application.name} description={application.description} source={server.name}
			enabled={server.enabled} busy={busy} onOpen={() => server.provider === 'github' ? show({ kind: 'githubAuth' }) : openEditor('app', server)} onEnabled={enabled => toggleMcp(server, enabled)} />
	));
	const mcpRows = [
		...servers.filter(server => (mcpScope === 'all' || (mcpScope === 'remote') === Boolean(server.url)) && matches(server.name, server.command, server.url, server.application?.name)).map(server => (
			<IntegrationRow key={server.name} icon={Server} name={server.name} description={server.url ?? server.command}
				source={server.application?.name ?? (server.url ? 'Streamable HTTP' : 'stdio')} enabled={server.enabled} busy={busy}
				onOpen={() => openEditor('mcp', server)} onEnabled={enabled => toggleMcp(server, enabled)} />
		)),
		...contributedServers.filter(({ plugin, server }) => mcpScope !== 'remote' && matches(plugin.name, server.name, server.command)).map(({ plugin, server }) => (
			<IntegrationRow key={`${plugin.id}:${server.name}`} icon={Server} name={server.name} description={server.command} source={fromPlugin(plugin)}
				enabled={plugin.enabled} busy={busy} onOpen={() => show({ kind: 'plugin', plugin })} />
		)),
	];
	const skillRows = [
		...skills.skills.filter(skill => matches(skill.name, skill.display_name, skill.description, skill.description_zh, skill.author)).map(skill => (
			<IntegrationRow key={skill.id} icon={BookOpen} name={skill.display_name ?? skill.name} description={skill.description_zh || skill.description}
				source={skill.author ?? t('integrations.local')} enabled={skill.enabled !== false} busy={busy}
				onOpen={() => show({ kind: 'skill', skill })} onEnabled={enabled => void perform(async () => {
					await skillApi.setEnabled(skill.id, enabled);
					await refreshSkills();
				})} />
		)),
		...contributedSkills.filter(({ plugin, skill }) => matches(plugin.name, skill.name, skill.description)).map(({ plugin, skill }) => (
			<IntegrationRow key={`${plugin.id}:${skill.name}`} icon={BookOpen} name={skill.name} description={skill.description} source={fromPlugin(plugin)}
				enabled={plugin.enabled} busy={busy} onOpen={() => show({ kind: 'plugin', plugin })} />
		)),
	];

	if (!bridge) return <p role="status">{t('desktopPlugins.errors.unavailable')}</p>;

	return (
		<section className="grid min-w-0 gap-5" data-testid="desktop-plugins">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<h3 className="text-2xl font-semibold tracking-tight">{t('integrations.title')}</h3>
				<div className="flex items-center gap-2">
					<Button type="button" variant="outline" disabled={busy} onClick={() => show({ kind: 'catalog' })}><FolderOpen />{t('discovery.title')}</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" disabled={busy}><Plus />{t('common.add')}<ChevronDown data-icon="inline-end" /></Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-auto min-w-48">
							<DropdownMenuItem onSelect={() => show({ kind: 'pluginSource' })}><Puzzle />{t('discovery.addPlugin')}</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => openEditor('app')}><Blocks />{t('integrations.addApp')}</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => openEditor('mcp')}><Server />{t('integrations.configureMcp')}</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => { setMcpJson(''); show({ kind: 'mcpJson' }); }}><FileUp />{t('discovery.importMcp')}</DropdownMenuItem>
							<DropdownMenuItem onSelect={importSkill}><BookOpen />{t('integrations.addSkill')}</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
			<input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={event => {
				const file = event.target.files?.[0];
				event.target.value = '';
				const expectedId = fileTarget.current;
				if (file) void perform(async () => {
					if (file.size > 256 * 1024) throw new DesktopPluginError('manifestTooLarge');
					await preview({ type: 'file', content: await file.text(), label: file.name, expectedId });
				});
			}} />
			<Tabs.Root value={group} onValueChange={value => selectGroup(value as Group)} className="grid min-w-0 gap-4">
				<Tabs.List aria-label={t('integrations.title')} className="grid grid-cols-[repeat(auto-fit,minmax(104px,1fr))] gap-2">
					{groups.map(({ key, label, icon: Icon }) => {
						const title = key === 'mcp' ? 'MCP' : t(label);
						const count = counts[key];
						return <Tabs.Trigger key={key} value={key} aria-label={count === undefined ? title : `${title} ${count}`}
							className="grid min-w-0 gap-2 rounded-xl border bg-card/55 p-3 text-start text-sm text-muted-foreground hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring data-[state=active]:border-primary/55 data-[state=active]:bg-primary/8 data-[state=active]:text-foreground">
							<span className="flex items-center justify-between gap-1">
								<Icon className="size-4" aria-hidden="true" />
								{count !== undefined && <span className="text-xs tabular-nums text-muted-foreground">{count}</span>}
							</span>
							<span className="break-words font-medium">{title}</span>
						</Tabs.Trigger>;
					})}
				</Tabs.List>
				<label className="relative block">
					<Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input ref={searchRef} type="search" className="h-9 ps-9" aria-label={t('integrations.search')} placeholder={t('integrations.search')}
						value={search} onChange={event => setSearch(event.target.value)} />
				</label>
				{!panel && error && <p role="alert" className="text-sm text-destructive">{error}</p>}
				{!panel && notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
				<Tabs.Content value="plugins" className="rounded-lg focus-visible:outline-2 focus-visible:outline-ring">
					<Results loading={plugins.isPending} error={plugins.error} empty={t('desktopPlugins.empty')} searching={Boolean(needle)} retry={() => void plugins.refetch()}>{pluginRows}</Results>
				</Tabs.Content>
				<Tabs.Content value="apps" className="rounded-lg focus-visible:outline-2 focus-visible:outline-ring">
					<Results loading={mcp.isPending} error={mcp.error} empty={t('integrations.noApps')} searching={Boolean(needle)} retry={() => void mcp.refetch()}>{appRows}</Results>
				</Tabs.Content>
				<Tabs.Content value="mcp" className="rounded-lg focus-visible:outline-2 focus-visible:outline-ring">
					<div className="mb-3 flex flex-wrap gap-1.5">
						{([{ value: 'all', label: 'skill.allCategories' }, { value: 'local', label: 'discovery.localMcp' }, { value: 'remote', label: 'discovery.remoteMcp' }] as const).map(item => (
							<Button key={item.value} type="button" variant={mcpScope === item.value ? 'secondary' : 'ghost'} size="sm" aria-pressed={mcpScope === item.value} onClick={() => setMcpScope(item.value)}>{t(item.label)}</Button>
						))}
					</div>
					<Results loading={mcp.isPending} error={mcp.error} empty={t('settings.advanced.mcp.noServers')} searching={Boolean(needle)} retry={() => void mcp.refetch()}>{mcpRows}</Results>
				</Tabs.Content>
				<Tabs.Content value="skills" className="rounded-lg focus-visible:outline-2 focus-visible:outline-ring">
					<Results loading={skills.loading} error={skills.error} empty={t('skill.mineEmptyTitle')} searching={Boolean(needle)} retry={() => void skills.refetch()}>{skillRows}</Results>
				</Tabs.Content>
			</Tabs.Root>
			<Dialog open={panel !== null} onOpenChange={open => { if (!open && !busy) show(null); }}>
				{panel && <DialogContent aria-describedby={undefined} className="max-h-[82dvh] overflow-y-auto bg-popover sm:max-w-xl"
					onCloseAutoFocus={event => {
						event.preventDefault();
						const origin = returnFocus.current;
						(origin?.isConnected ? origin : searchRef.current)?.focus({ preventScroll: true });
					}}>
					{renderPanel(panel)}
					{error && <p className="text-sm text-destructive" role="alert">{error}</p>}
					{notice && <p className="text-sm text-muted-foreground" role="status">{notice}</p>}
				</DialogContent>}
			</Dialog>
		</section>
	);
}
