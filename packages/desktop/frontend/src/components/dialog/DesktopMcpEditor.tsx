import { ArrowUpRight, PlugZap } from 'lucide-react';
import { useId, useState } from 'react';

import { mcpWorkshopApi, type McpApplication, type McpProbeResult, type McpServerDef, type McpTemplate } from '@/api/mcp-workshop';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from '@/i18n/useI18n';

const NEW_SERVER = '[new]';
const fieldClass = 'grid gap-1.5 text-xs font-medium';

function parseArgs(raw: string) {
	const args: unknown = JSON.parse(raw || '[]');
	if (!Array.isArray(args) || args.length > 20 || args.some(arg => typeof arg !== 'string')) throw new Error('arguments');
	return args as string[];
}

function parseEnvironment(raw: string) {
	const env = raw.split(/\r?\n/).filter(line => line.trim()).map(line => {
		const separator = line.indexOf('=');
		const key = line.slice(0, separator).trim();
		if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('environment');
		return [key, line.slice(separator + 1)];
	});
	if (env.length > 20) throw new Error('environment');
	return Object.fromEntries(env);
}

function parseHeaders(raw: string) {
	const entries = raw.split(/\r?\n/).filter(line => line.trim()).map(line => {
		const separator = line.indexOf(':');
		const name = line.slice(0, separator).trim();
		if (separator < 1 || !/^[!#$%&'*+.^_\x60|~A-Za-z0-9-]+$/.test(name)) throw new Error('headers');
		return [name, line.slice(separator + 1).trim()];
	});
	if (entries.length > 20) throw new Error('headers');
	return Object.fromEntries(entries);
}

export function DesktopMcpEditor({ mode, server, template, servers, onSaved, onCancel }: {
	mode: 'mcp' | 'app';
	server?: McpServerDef;
	template?: McpTemplate;
	servers: McpServerDef[];
	onSaved: () => Promise<void>;
	onCancel: () => void;
}) {
	const { t } = useTranslation();
	const formId = useId();
	const existingKeys = server?.envKeys ?? [];
	const [transport, setTransport] = useState<'stdio' | 'http'>(server?.url || template?.url ? 'http' : 'stdio');
	const [url, setUrl] = useState(server?.url ?? template?.url ?? '');
	const [headers, setHeaders] = useState('');
	const attachable = servers.filter(row => !row.application);
	const [target, setTarget] = useState(server?.name ?? attachable[0]?.name ?? NEW_SERVER);
	const [name, setName] = useState(server?.name ?? template?.name ?? '');
	const [command, setCommand] = useState(server?.command ?? template?.command ?? '');
	const [args, setArgs] = useState(JSON.stringify(server?.args ?? template?.args ?? [], null, 2));
	const [env, setEnv] = useState(() => Object.entries(template?.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'));
	const [application, setApplication] = useState<McpApplication>(server?.application ?? { name: '', description: '', website: '' });
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [probing, setProbing] = useState(false);
	const [probe, setProbe] = useState<McpProbeResult | null>(null);
	const showServer = mode === 'mcp' || target === NEW_SERVER;
	const valid = (!showServer || (name.trim() && (transport === 'http' ? url.trim() : command.trim()))) && (mode !== 'app' || application.name.trim());

	async function save() {
		setError(null);
		let parameters: string[] = [];
		let variables: Record<string, string> = {};
		let requestHeaders: Record<string, string> = {};
		try {
			if (showServer && transport === 'stdio') {
				parameters = parseArgs(args);
				variables = parseEnvironment(env);
			}
			if (showServer && transport === 'http') requestHeaders = parseHeaders(headers);
		} catch {
			setError(t('integrations.invalidConfig'));
			return;
		}
		setSaving(true);
		try {
			if (mode === 'app' && target !== NEW_SERVER) {
				await mcpWorkshopApi.updateServer(target, { application });
			} else if (transport === 'http') {
				if (server) await mcpWorkshopApi.updateServer(server.name, { url: url.trim(), headerPatch: requestHeaders });
				else await mcpWorkshopApi.addRemoteServer(name.trim(), url.trim(), requestHeaders, mode === 'app' ? application : undefined);
			} else if (server) {
				await mcpWorkshopApi.updateServer(server.name, {
					command: command.trim(), args: parameters, ...(Object.keys(variables).length ? { envPatch: variables } : {}),
				});
			} else {
				await mcpWorkshopApi.addServer(name.trim(), command.trim(), parameters, variables,
					{ enabled: false, ...(mode === 'app' ? { application } : {}) });
			}
			await onSaved();
		} catch (cause) { setError(cause instanceof Error ? cause.message : t('common.error')); }
		finally { setSaving(false); }
	}

	async function testConnection() {
		if (!server) return;
		setError(null);
		setProbing(true);
		try { setProbe(await mcpWorkshopApi.probe(server.name)); }
		catch (cause) { setError(cause instanceof Error ? cause.message : t('common.error')); }
		finally { setProbing(false); }
	}

	return (
		<form className="grid gap-4" onSubmit={event => { event.preventDefault(); if (valid && !saving) void save(); }}>
			{mode === 'app' && (
				<>
					<label className={fieldClass}>{t('integrations.backingServer')}
						<select className="h-9 min-w-0 rounded-md border border-input bg-background px-2" value={target} onChange={event => setTarget(event.target.value)} disabled={Boolean(server) || saving}>
							{(server ? [server] : attachable).map(row => <option key={row.name} value={row.name}>{row.name}</option>)}
							{!server && <option value={NEW_SERVER}>{t('integrations.newServer')}</option>}
						</select>
					</label>
					<label className={fieldClass}>{t('integrations.appName')}
						<Input required maxLength={80} value={application.name} onChange={event => setApplication(current => ({ ...current, name: event.target.value }))} />
					</label>
					<label className={fieldClass}>{t('integrations.appDescription')}
						<Textarea rows={2} maxLength={500} value={application.description} onChange={event => setApplication(current => ({ ...current, description: event.target.value }))} />
					</label>
					<label className={fieldClass}>{t('integrations.website')}
						<Input type="url" dir="ltr" maxLength={2048} placeholder="https://" value={application.website} onChange={event => setApplication(current => ({ ...current, website: event.target.value }))} />
					</label>
				</>
			)}
			{showServer && (
				<>
					<label className={fieldClass}>{t('common.name')}
						<Input required readOnly={Boolean(server)} pattern={String.raw`[A-Za-z0-9_\-]+`} dir="ltr" value={name} onChange={event => setName(event.target.value)} />
					</label>
					<label className={fieldClass}>{t('discovery.transport')}
						<select value={transport} onChange={event => setTransport(event.target.value === 'http' ? 'http' : 'stdio')} className="h-9 rounded-md border border-input bg-background px-2">
							<option value="stdio">{t('discovery.localMcp')} · stdio</option>
							<option value="http">{t('discovery.remoteMcp')} · Streamable HTTP</option>
						</select>
					</label>
					{transport === 'http' ? <>
						<label className={fieldClass}>{t('discovery.mcpUrl')}
							<Input required type="url" dir="ltr" maxLength={2048} placeholder="https://example.com/mcp" value={url} onChange={event => setUrl(event.target.value)} />
						</label>
						<label className={fieldClass}>{t('discovery.mcpHeaders')}
							<Textarea rows={3} dir="ltr" value={headers} onChange={event => setHeaders(event.target.value)} placeholder="Authorization: Bearer …" className="font-mono" />
						</label>
						{Boolean(server?.headerKeys?.length) && <p className="break-all text-xs text-muted-foreground">{server?.headerKeys?.join(', ')}</p>}
					</> : <>
					<label className={fieldClass}>{t('integrations.command')}
						<Input required dir="ltr" className="font-mono" value={command} onChange={event => setCommand(event.target.value)} />
					</label>
					<label className={fieldClass}>{t('integrations.arguments')}
						<Textarea rows={3} dir="ltr" className="font-mono" value={args} onChange={event => setArgs(event.target.value)} />
					</label>
					<label className={fieldClass}>{t('integrations.environment')}
						<Textarea rows={2} dir="ltr" aria-describedby={existingKeys.length ? formId : undefined} className="font-mono" value={env} onChange={event => setEnv(event.target.value)} />
					</label>
					{existingKeys.length > 0 && <p id={formId} className="break-all text-xs text-muted-foreground">{existingKeys.join(', ')}</p>}
					</>}
				</>
			)}
			{probe && <div role="status" className="grid gap-2 rounded-lg border bg-muted/35 p-3 text-xs">
				{probe.status === 'ok' ? <>
					<p className="font-medium">{t('settings.advanced.mcp.toolsCount', { count: probe.tools.length })}</p>
					{probe.tools.length > 0 && <ul className="grid gap-1 break-words">{probe.tools.map(tool => <li key={tool.name}>{tool.name}{tool.description && ` · ${tool.description}`}</li>)}</ul>}
				</> : <p>{probe.status === 'disabled' ? t('desktopPlugins.disabled') : t('settings.advanced.mcp.probeFailed', { error: probe.error ?? '' })}</p>}
			</div>}
			{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
			<div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
				<div className="flex flex-wrap gap-2">
					{server?.enabled && <Button type="button" size="sm" variant="outline" disabled={probing || saving} onClick={() => void testConnection()}>
						<PlugZap />{t(probing ? 'settings.advanced.mcp.probing' : 'settings.advanced.mcp.probe')}
					</Button>}
					{mode === 'app' && server?.application?.website && <Button asChild variant="ghost" size="sm">
						<a href={server.application.website} target="_blank" rel="noreferrer"><ArrowUpRight />{t('integrations.openWebsite')}</a>
					</Button>}
				</div>
				<div className="flex gap-2">
					<Button type="button" variant="outline" size="sm" disabled={saving} onClick={onCancel}>{t('common.cancel')}</Button>
					<Button type="submit" size="sm" disabled={!valid || saving || probing}>{t(saving ? 'common.saving' : 'common.save')}</Button>
				</div>
			</div>
		</form>
	);
}
