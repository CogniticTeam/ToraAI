// MCP 工坊：可视化管理 MCP 服务器
//
// 功能：
//  · 从预设模板或自定义命令添加服务器
//  · 探测连接 → 展示该服务器暴露的工具与描述
//  · 试调工具（填 JSON 参数，看返回结果）
//  · 编辑 / 删除服务器（删除会停掉常驻连接）

import { Plus, Play, Power, RefreshCw, Server, Trash2, Wrench } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { mcpWorkshopApi, type McpProbeResult, type McpTemplate } from '@/api/mcp-workshop';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useTranslation } from '@/i18n/useI18n';

interface ServerRow {
	name: string;
	command: string;
	args: string[];
	probe?: McpProbeResult | null;
}

export function McpWorkshopPanel() {
	const { i18n } = useTranslation();
	const zh = i18n.language.startsWith('zh');
	const [servers, setServers] = useState<ServerRow[]>([]);
	const [templates, setTemplates] = useState<McpTemplate[]>([]);

	// 新建表单
	const [tplId, setTplId] = useState<string>('fetch');
	const [name, setName] = useState('');
	const [command, setCommand] = useState('');
	const [argsStr, setArgsStr] = useState('');
	const [envStr, setEnvStr] = useState('');

	// 工具试调
	const [callTarget, setCallTarget] = useState<string | null>(null);
	const [callTool, setCallTool] = useState('');
	const [callArgs, setCallArgs] = useState('{}');
	const [callResult, setCallResult] = useState('');
	const [calling, setCalling] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const r = await mcpWorkshopApi.listServers();
			setServers(r.servers.map((s) => ({ ...s, probe: null })));
		} catch { /* 后端无此端点 */ }
	}, []);

	useEffect(() => {
		void refresh();
		void mcpWorkshopApi.templates().then((r) => setTemplates(r.templates)).catch(() => {});
	}, [refresh]);

	const applyTemplate = (id: string) => {
		const t = templates.find((x) => x.id === id);
		if (!t) return;
		setTplId(id);
		setName(t.name);
		setCommand(t.command);
		setArgsStr(t.args.join(' '));
		setEnvStr(Object.entries(t.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'));
	};

	const parseEnv = (raw: string): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const line of raw.split('\n')) {
			const i = line.indexOf('=');
			if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
		}
		return out;
	};

	const addServer = async () => {
		if (!name.trim() || !command.trim()) return;
		try {
			const args = argsStr.split(/\s+/).filter(Boolean);
			const env = parseEnv(envStr);
			await mcpWorkshopApi.addServer(name.trim(), command.trim(), args, env);
			toast.success(zh ? '服务器已添加' : 'Server added');
			setName(''); setCommand(''); setArgsStr(''); setEnvStr('');
			void refresh();
		} catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
	};

	const probe = async (sname: string) => {
		try {
			const r = await mcpWorkshopApi.probe(sname);
			setServers((prev) => prev.map((s) => (s.name === sname ? { ...s, probe: r } : s)));
		} catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
	};

	const remove = async (sname: string) => {
		try {
			await mcpWorkshopApi.removeServer(sname);
			void refresh();
		} catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
	};

	const runToolCall = async () => {
		if (!callTarget || !callTool) return;
		setCalling(true);
		setCallResult('');
		try {
			let args: unknown = {};
			if (callArgs.trim()) args = JSON.parse(callArgs);
			const r = await mcpWorkshopApi.callTool(callTarget, callTool, args);
			setCallResult(r.result);
		} catch (e) {
			setCallResult(e instanceof Error ? e.message : String(e));
		} finally {
			setCalling(false);
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2 pb-2 text-[11px]">
			{/* 新建服务器 */}
			<div className="flex flex-col gap-1 rounded-md border p-2">
				<div className="flex items-center gap-1">
					<Server className="size-3.5 text-muted-foreground" />
					<span className="font-medium">{zh ? '添加 MCP 服务器' : 'Add MCP server'}</span>
				</div>
				<Select value={tplId} onValueChange={applyTemplate}>
					<SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
					<SelectContent>
						{templates.map((t) => (
							<SelectItem key={t.id} value={t.id}>
								{t.name} — {t.description}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<div className="flex gap-1">
					<Input value={name} onChange={(e) => setName(e.target.value)} placeholder={zh ? '名称 (字母数字_-)' : 'Name (letters, numbers, _-)'} className="h-7 flex-1 text-[11px]" />
					<Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder={zh ? '命令 (npx)' : 'Command (npx)'} className="h-7 flex-1 text-[11px]" />
				</div>
				<Input value={argsStr} onChange={(e) => setArgsStr(e.target.value)} placeholder={zh ? '参数 (空格分隔)' : 'Arguments (space separated)'} className="h-7 text-[11px]" />
				<textarea
					value={envStr}
					onChange={(e) => setEnvStr(e.target.value)}
					placeholder={zh ? '环境变量 (KEY=VALUE，每行一个)' : 'Environment variables (KEY=VALUE, one per line)'}
					className="h-14 w-full resize-none rounded border bg-transparent px-2 py-1 text-[11px]"
				/>
				<Button size="sm" onClick={() => void addServer()}><Plus className="size-3" /> {zh ? '添加' : 'Add'}</Button>
			</div>

			{/* 服务器列表 */}
			<div className="flex flex-col gap-1 overflow-auto">
				{servers.map((s) => (
					<div key={s.name} className="rounded-md border p-2">
						<div className="flex items-center gap-1">
							<span className="font-medium">{s.name}</span>
							<span className="truncate text-[10px] text-muted-foreground">
								{s.command} {s.args.join(' ')}
							</span>
							<div className="ml-auto flex gap-0.5">
								<Button variant="ghost" size="icon-sm" onClick={() => void probe(s.name)} aria-label={zh ? '探测' : 'Probe'}>
									<RefreshCw className="size-3" />
								</Button>
								<Button variant="ghost" size="icon-sm" onClick={() => void remove(s.name)} aria-label={zh ? '删除' : 'Delete'}>
									<Trash2 className="size-3" />
								</Button>
							</div>
						</div>

						{s.probe ? (
							<div className="mt-1">
								<div className="flex items-center gap-1 text-[10px]">
									{s.probe.status === 'ok' ? (
										<span className="text-green-600">● {zh ? '连接正常' : 'Connected'} · {s.probe.tools.length} {zh ? '个工具' : 'tools'}</span>
									) : (
										<span className="text-red-500">● {zh ? '失败' : 'Failed'}: {s.probe.error}</span>
									)}
								</div>
								{s.probe.status === 'ok' && s.probe.tools.length > 0 ? (
									<div className="mt-1 flex flex-wrap gap-1">
										{s.probe.tools.map((t) => (
											<button
												key={t.name}
												className="rounded bg-muted px-1.5 py-0.5 text-[10px] hover:bg-accent"
												onClick={() => {
													setCallTarget(s.name);
													setCallTool(t.name);
													setCallResult('');
												}}
												title={t.description}
											>
												<Wrench className="mr-0.5 inline size-2.5" />{t.name}
											</button>
										))}
									</div>
								) : null}
								{s.probe.stderrTail ? (
									<pre className="mt-1 max-h-16 overflow-auto rounded bg-muted p-1 text-[10px] text-red-500">{s.probe.stderrTail}</pre>
								) : null}
							</div>
						) : (
							<div className="text-[10px] text-muted-foreground">{zh ? '点刷新探测连接与工具列表' : 'Click refresh to probe the connection and tools'}</div>
						)}
					</div>
				))}
				{servers.length === 0 ? (
					<div className="px-2 py-3 text-center text-muted-foreground">{zh ? '还没有 MCP 服务器' : 'No MCP servers yet'}</div>
				) : null}
			</div>

			{/* 工具试调 */}
			{callTarget ? (
				<div className="flex flex-col gap-1 rounded-md border p-2">
					<div className="flex items-center gap-1">
						<Power className="size-3.5 text-muted-foreground" />
						<span className="font-medium">{zh ? '试调' : 'Test'} {callTarget}.{callTool}</span>
					</div>
					<textarea
						value={callArgs}
						onChange={(e) => setCallArgs(e.target.value)}
						placeholder={zh ? '参数 JSON，例如 {"url":"https://example.com"}' : 'Arguments JSON, e.g. {"url":"https://example.com"}'}
						className="h-16 w-full resize-none rounded border bg-transparent px-2 py-1 font-mono text-[11px]"
					/>
					<Button size="sm" onClick={() => void runToolCall()} disabled={calling}>
						<Play className="size-3" /> {calling ? (zh ? '调用中…' : 'Calling…') : (zh ? '调用' : 'Call')}
					</Button>
					{callResult ? (
						<pre className="max-h-40 overflow-auto rounded bg-muted p-1 text-[10px] whitespace-pre-wrap">{callResult}</pre>
					) : null}
				</div>
			) : null}
		</div>
	);
}
