import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Boxes, Globe2, Plus, Puzzle, RefreshCw, Search, Server, SlidersHorizontal, Trash2 } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { useState } from 'react';

import { DesktopPluginError, getDesktopPluginBridge, pluginResult, type InstalledPlugin, type PluginInput } from '@/api/desktopPlugins';
import { mcpWorkshopApi, type McpTemplate } from '@/api/mcp-workshop';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n/useI18n';

const INDEX_KEY = ['integration-plugin-indexes'] as const;
const selectClass = 'h-9 min-w-0 rounded-lg border bg-background px-2 text-sm';
export type DiscoveryTab = 'plugins' | 'apps' | 'mcp' | 'skills';

export function DesktopDiscovery({ initial, installed, githubConnected, busy, onPreview, onMcp, onGithub, onSkills }: {
	initial: DiscoveryTab;
	installed: InstalledPlugin[];
	githubConnected: boolean;
	busy: boolean;
	onPreview: (input: PluginInput) => void;
	onMcp: (template: McpTemplate) => void;
	onGithub: () => void;
	onSkills: () => void;
}) {
	const { t } = useTranslation();
	const client = useQueryClient();
	const bridge = getDesktopPluginBridge();
	const [tab, setTab] = useState(initial);
	const [query, setQuery] = useState('');
	const [index, setIndex] = useState('');
	const [managing, setManaging] = useState(false);
	const [address, setAddress] = useState('');
	const [category, setCategory] = useState('');
	const [sort, setSort] = useState('source');
	const [pending, setPending] = useState(false);
	const [error, setError] = useState('');
	const indexes = useQuery({ queryKey: INDEX_KEY, queryFn: () => pluginResult(bridge?.indexes()), enabled: tab === 'plugins' });
	const catalog = useQuery({ queryKey: [...INDEX_KEY, index], queryFn: () => pluginResult(bridge?.catalog(index)), enabled: tab === 'plugins' && Boolean(index) });
	const mcp = useQuery({ queryKey: ['integration-mcp-templates'], queryFn: mcpWorkshopApi.templates, enabled: tab === 'mcp' });
	const search = query.trim().toLocaleLowerCase();
	const matches = (...values: string[]) => values.join(' ').toLocaleLowerCase().includes(search);
	const entries = catalog.data?.plugins ?? [];
	const categories = [...new Set(entries.map(entry => entry.category).filter(Boolean))];
	const shown = entries.filter(entry => (!category || entry.category === category) && matches(entry.name, entry.id, entry.description));
	if (sort === 'name') shown.sort((a, b) => a.name.localeCompare(b.name));
	const templates = mcp.data?.templates.filter(template => (template.url || template.command) && matches(template.name, template.description)) ?? [];
	const tabs = [
		{ value: 'plugins', label: t('desktopPlugins.title') },
		{ value: 'apps', label: t('integrations.apps') },
		{ value: 'mcp', label: 'MCP' },
		{ value: 'skills', label: t('desktopPlugins.skills') },
	] as const;

	function explain(cause: unknown) {
		return cause instanceof DesktopPluginError
			? t(`desktopPlugins.errors.${cause.message}`, { defaultValue: t('desktopPlugins.errors.unexpected') })
			: t('common.error');
	}

	async function changeIndex(operation: () => Promise<void>) {
		setPending(true);
		setError('');
		try { await operation(); }
		catch (cause) { setError(explain(cause)); }
		finally { setPending(false); }
	}

	const empty = <p role="status" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t('skill.noCardsTitle')}</p>;
	const loading = <p role="status" className="px-3 py-4 text-sm text-muted-foreground">{t('common.loading')}</p>;
	return <Tabs.Root value={tab} onValueChange={value => { setTab(value as DiscoveryTab); setQuery(''); }} className="grid gap-4">
		<Tabs.List aria-label={t('discovery.title')} className="grid grid-cols-4 rounded-lg bg-muted p-1">
			{tabs.map(item => <Tabs.Trigger key={item.value} value={item.value} className="min-w-0 rounded-md px-1 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-ring data-[state=active]:bg-background data-[state=active]:font-medium">
				{item.label}
			</Tabs.Trigger>)}
		</Tabs.List>
		{tab !== 'skills' && <div className="relative">
			<Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
			<Input type="search" value={query} onChange={event => setQuery(event.target.value)} className="ps-9" aria-label={t('integrations.search')} placeholder={t('integrations.search')} />
		</div>}
		<Tabs.Content value="plugins" className="grid gap-3 data-[state=inactive]:hidden">
			<div className="flex flex-wrap items-center gap-2">
				<select aria-label={t('discovery.indexSources')} className={`${selectClass} flex-1`} value={index} onChange={event => { setIndex(event.target.value); setCategory(''); }}>
					<option value="">{t('desktopPlugins.exampleSource')}</option>
					{indexes.data?.map(item => <option key={item.url} value={item.url}>{item.name}</option>)}
				</select>
				<Button type="button" size="sm" variant="outline" aria-expanded={managing} onClick={() => setManaging(value => !value)}><SlidersHorizontal />{t('discovery.indexSources')}</Button>
				{index && <Button type="button" size="icon-sm" variant="outline" aria-label={t('discovery.refresh')} disabled={catalog.isFetching} onClick={() => void catalog.refetch()}><RefreshCw /></Button>}
			</div>
			{managing && <section className="grid gap-3 rounded-xl border bg-muted/30 p-3" aria-label={t('discovery.indexSources')}>
				<p className="text-xs text-muted-foreground">{t('discovery.indexHint')}</p>
				{indexes.error && <p role="alert" className="text-xs text-destructive">{explain(indexes.error)}</p>}
				{indexes.data?.map(source => <div key={source.url} className="flex items-center justify-between gap-2 text-sm">
					<div className="min-w-0"><p className="break-words font-medium">{source.name}</p><p className="break-all text-xs text-muted-foreground">{source.url}</p></div>
					<Button type="button" size="icon-sm" variant="ghost" aria-label={`${t('common.delete')} ${source.name}`} disabled={pending} onClick={() => void changeIndex(async () => {
						await pluginResult(bridge?.removeIndex(source.url));
						if (index === source.url) { setIndex(''); setCategory(''); }
						await client.invalidateQueries({ queryKey: INDEX_KEY });
					})}><Trash2 /></Button>
				</div>)}
				<form className="flex flex-wrap gap-2" onSubmit={event => {
					event.preventDefault();
					if (pending || !address.trim()) return;
					void changeIndex(async () => {
						const source = await pluginResult(bridge?.addIndex(address.trim()));
						await client.invalidateQueries({ queryKey: INDEX_KEY });
						setIndex(source.url); setCategory(''); setAddress('');
					});
				}}>
					<Input dir="ltr" type="url" aria-label={t('discovery.indexUrl')} placeholder="https://example.com/index.json" className="min-w-40 flex-1" value={address} onChange={event => setAddress(event.target.value)} />
					<Button type="submit" size="sm" disabled={pending || !address.trim()}>{t(pending ? 'common.loading' : 'common.add')}</Button>
				</form>
				{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
			</section>}
			{!index && (matches('Workspace Handoff', t('desktopPlugins.example')) ? <div className="flex items-center justify-between gap-2 rounded-lg border p-3">
				<div className="min-w-0"><p className="text-sm font-medium">Workspace Handoff</p><p className="text-xs text-muted-foreground">{t('desktopPlugins.exampleSource')}</p></div>
				<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onPreview({ type: 'catalog' })}><Puzzle />{t('desktopPlugins.example')}</Button>
			</div> : empty)}
			{index && (catalog.isPending ? loading : catalog.error ? <p role="alert" className="text-sm text-destructive">{explain(catalog.error)}</p> : <>
				<div className="flex flex-wrap gap-2">
					<select aria-label={t('skill.allCategories')} className={selectClass} value={category} onChange={event => setCategory(event.target.value)}>
						<option value="">{t('skill.allCategories')}</option>
						{categories.map(value => <option key={value}>{value}</option>)}
					</select>
					<select aria-label={t('discovery.sort')} className={selectClass} value={sort} onChange={event => setSort(event.target.value)}>
						<option value="source">{t('discovery.sourceOrder')}</option><option value="name">{t('common.name')}</option>
					</select>
				</div>
				{shown.length ? <ul className="divide-y overflow-hidden rounded-xl border bg-card/60">{shown.map(entry => (
					<li key={entry.id} className="flex min-w-0 items-center gap-3 p-3">
						<Puzzle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						<div className="min-w-0 flex-1"><p className="break-words font-medium">{entry.name}</p>
							{entry.description && <p className="break-words text-xs text-muted-foreground">{entry.description}</p>}
							<p className="break-words text-xs text-muted-foreground">{[entry.category, entry.version, installed.some(plugin => plugin.id === entry.id) ? t('desktopPlugins.installed') : ''].filter(Boolean).join(' · ')}</p>
						</div>
						<Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onPreview({ ...entry.source, expectedId: entry.id })}>{t('desktopPlugins.preview')}</Button>
					</li>
				))}</ul> : empty}
			</>)}
		</Tabs.Content>
		<Tabs.Content value="mcp" className="grid gap-2 data-[state=inactive]:hidden">
			{mcp.isPending ? loading : mcp.error ? <Button type="button" variant="outline" onClick={() => void mcp.refetch()}>{t('error.retry')}</Button>
				: templates.length ? <ul className="divide-y overflow-hidden rounded-xl border bg-card/60">{templates.map(template => (
					<li key={template.id} className="flex items-center gap-3 p-3">
						<Server className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap items-center gap-2">
								<p className="break-words font-medium">{template.url ? template.description : template.name}</p>
								<span className="rounded bg-muted px-1.5 text-xs text-muted-foreground">{t(template.url ? 'discovery.remoteMcp' : 'discovery.localMcp')}</span>
							</div>
							<p className="break-all font-mono text-xs text-muted-foreground">{template.url ?? [template.command, ...template.args].join(' ')}</p>
						</div>
						<Button type="button" variant="outline" size="sm" aria-label={`${t('common.add')} ${template.name}`} onClick={() => onMcp(template)}><Plus />{t('common.add')}</Button>
					</li>
				))}</ul> : empty}
		</Tabs.Content>
		<Tabs.Content value="apps" className="data-[state=inactive]:hidden">
			{matches('GitHub', t('discovery.githubDesc')) ? <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card/60 p-3">
				<Boxes className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
				<div className="min-w-0 flex-1"><h4 className="text-sm font-medium">GitHub</h4><p className="text-xs text-muted-foreground">{t('discovery.githubDesc')}</p></div>
				<Button type="button" size="sm" variant="outline" onClick={onGithub}><Globe2 />{t(githubConnected ? 'desktopPlugins.details' : 'discovery.connect')}</Button>
			</div> : empty}
		</Tabs.Content>
		<Tabs.Content value="skills" className="data-[state=inactive]:hidden">
			<Button type="button" variant="outline" onClick={onSkills}><BookOpen />{t('common.skill-hub')}</Button>
		</Tabs.Content>
	</Tabs.Root>;
}
