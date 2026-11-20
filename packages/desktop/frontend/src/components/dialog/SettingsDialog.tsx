// CoCode 设置窗口（参考 WorkBuddy 布局：左侧分类导航 + 右侧内容面板）。
// 不暴露后端连接配置——连接由 Electron 壳层/启动参数管理。
// 模型板块为三层结构（参考 WorkBuddy）：
//   列表（表格：模型/服务商/操作） → 添加模型弹窗（服务商网格） → 通过服务商添加表单

import {
  AudioWaveform, BotMessageSquare, Box, Brain, ChartColumn, ChevronLeft, ChevronRight, CircleDot, Cloud, CloudDrizzle,
  Cpu, Database, ExternalLink, Info, LaptopMinimal, Layers, Loader2, Moon,
  Pencil, Plus, Puzzle, Settings2, Shuffle, Smartphone, SquareTerminal, Sun, Trash2, TriangleAlert, UserRound, Waves, X, Zap
} from 'lucide-react';
import { Dialog as SettingsPrimitive } from 'radix-ui';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ChatModelConfig, CreateAgentRequest, UpdateAgentRequest } from '@/api';
import { ApiError } from '@/api/client';
import { codexApi, CODEX_PROVIDER } from '@/api/codex';
import { getDesktopPluginBridge } from '@/api/desktopPlugins';
import { AccountSection } from '@/components/dialog/AccountSection';
import { CodexSubscriptionView } from '@/components/dialog/CodexSubscriptionView';
import { DesktopPluginSection } from '@/components/dialog/DesktopPluginSection';
import { LanguageDialog } from '@/components/dialog/LanguageDialog';
import { MemorySection } from '@/components/dialog/MemorySection';
import { UsageSection } from '@/components/dialog/UsageSection';
import { LlmSelect } from '@/components/select/LlmSelect';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownSelect } from '@/components/ui/dropdown-select';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useAgents } from '@/hooks/useAgents';
import { AVAILABLE_MODELS_KEY } from '@/hooks/useAvailableModels';
import { useTheme } from '@/hooks/useTheme';
import type { ThemePreference } from '@/hooks/useTheme';
import i18n, { LANGUAGE_OPTIONS, normalizeLanguage } from '@/i18n';
import { useTranslation } from '@/i18n/useI18n';
import { readRoleAvatar } from '@/lib/agentRoleAvatar';
import { normalizeSettingsSection, type SettingsSection } from '@/lib/openSettings';
import { PROVIDER_ICONS } from '@/lib/providerIcons';
import { queryClient } from '@/lib/query-client';
import {
	clearCustomSound,
	getCustomSound,
	loadSoundSettings,
	previewSound,
	saveCustomSound,
	saveSoundSettings,
	type SoundKind,
	type SoundSettings,
} from '@/lib/sound';
import { getToken } from '@/utils/authStore';
import { cloudFetch, syncLocalModelMirror } from '@/utils/modelSync';

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onImportSessions?: () => void;
	returnFocusRef?: React.RefObject<HTMLElement | null>;
	/** 打开时定位到的板块（默认通用）。配合 key 重挂载可强制切换。 */
	initialTab?: Section;
}

const apiBase = () => (localStorage.getItem('server_url') || 'http://127.0.0.1:3210').replace(/\/+$/, '');
const apiUrl = (p: string) => `${apiBase()}${p}`;

type Section = SettingsSection;

type RuntimeBehavior = {
	maxTokensBudget: number;
	toolOutputLimit: number;
	maxTurns: number;
};

type UpdateResult = {
	status: 'available' | 'development' | 'downloading' | 'error' | 'unavailable' | 'up-to-date';
	version?: string;
	message?: string;
};

type UpdateBridge = { checkForUpdates: () => Promise<UpdateResult>; getAppVersion?: () => string };

function getUpdateBridge(): UpdateBridge | null {
	return (window as unknown as { toraWindow?: UpdateBridge }).toraWindow ?? null;
}

/**
 * 参考 Trae Agent 的 YAML 执行配置，把常用的上下文、工具输出和迭代上限
 * 收敛成三个可理解的一键档位；用户仍可在下面逐项微调。
 */
const RUNTIME_PRESETS: ReadonlyArray<{
	id: 'fast' | 'balanced' | 'deep';
	values: RuntimeBehavior;
}> = [
	{ id: 'fast', values: { maxTokensBudget: 12000, toolOutputLimit: 3000, maxTurns: 20 } },
	{ id: 'balanced', values: { maxTokensBudget: 24000, toolOutputLimit: 6000, maxTurns: 40 } },
	{ id: 'deep', values: { maxTokensBudget: 48000, toolOutputLimit: 12000, maxTurns: 80 } },
];

const SECTIONS: { key: Section; label: string; icon: typeof Settings2 }[] = [
	{ key: 'account', label: 'settings.sections.account', icon: UserRound },
	{ key: 'general', label: 'settings.sections.general', icon: Settings2 },
	{ key: 'usage', label: 'settings.sections.usage', icon: ChartColumn },
	{ key: 'agent', label: 'settings.sections.agent', icon: BotMessageSquare },
	{ key: 'model', label: 'settings.sections.model', icon: Cpu },
	{ key: 'plugins', label: 'integrations.title', icon: Puzzle },
	{ key: 'memory', label: 'settings.sections.memory', icon: Brain },
	{ key: 'data', label: 'settings.sections.data', icon: Database },
	{ key: 'about', label: 'settings.sections.about', icon: Info },
	{ key: 'developer', label: 'settings.advanced.title', icon: SquareTerminal },
];

// 服务商预设：全部 OpenAI 兼容接口；keyUrl = 获取 API 密钥的官网地址
interface ProviderDef {
	key: string;
	label: string;
	baseURL: string;
	needKey?: boolean; // 缺省 = 需要 Key；仅本地服务显式传 false
	keyUrl?: string;
	icon: typeof Box;
	color: string;
}

// Provider shape without i18n labels — labels are looked up at render time
// so `t()` (which is only available inside React) can fill them.
type ProviderDefBase = Omit<ProviderDef, 'label'>;

const PROVIDER_DEFS: ProviderDefBase[] = [
	{ key: 'custom', baseURL: '', needKey: true, icon: Box, color: 'bg-foreground text-background' },
	{ key: 'deepseek', baseURL: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys', icon: Waves, color: 'bg-blue-500 text-white' },
	{ key: 'minimax-cn', baseURL: 'https://api.minimax.chat/v1', keyUrl: 'https://platform.minimaxi.com', icon: AudioWaveform, color: 'bg-rose-500 text-white' },
	{ key: 'minimax-global', baseURL: 'https://api.minimax.io/v1', keyUrl: 'https://www.minimax.io', icon: AudioWaveform, color: 'bg-rose-400 text-white' },
	{ key: 'bigmodel', baseURL: 'https://open.bigmodel.cn/api/paas/v4', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', icon: Zap, color: 'bg-sky-500 text-white' },
	{ key: 'dashscope', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyUrl: 'https://bailian.console.aliyun.com', icon: Cloud, color: 'bg-orange-500 text-white' },
	{ key: 'mimo', baseURL: 'https://api.xiaomimimo.com/v1', keyUrl: 'https://www.xiaomimimo.com', icon: Smartphone, color: 'bg-stone-500 text-white' },
	{ key: 'siliconflow', baseURL: 'https://api.siliconflow.cn/v1', keyUrl: 'https://cloud.siliconflow.cn/account/ak', icon: Layers, color: 'bg-violet-500 text-white' },
	{ key: 'zai', baseURL: 'https://api.z.ai/api/paas/v4', keyUrl: 'https://z.ai', icon: Zap, color: 'bg-zinc-800 text-white' },
	{ key: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys', icon: Shuffle, color: 'bg-blue-600 text-white' },
	{ key: 'kimi-cn', baseURL: 'https://api.moonshot.cn/v1', keyUrl: 'https://platform.moonshot.cn/console/api-keys', icon: Moon, color: 'bg-neutral-800 text-white' },
	{ key: 'kimi-global', baseURL: 'https://api.moonshot.ai/v1', keyUrl: 'https://platform.moonshot.ai/console/api-keys', icon: Moon, color: 'bg-neutral-700 text-white' },
	{ key: 'hunyuan', baseURL: 'https://api.hunyuan.cloud.tencent.com/v1', keyUrl: 'https://console.cloud.tencent.com/hunyuan', icon: CloudDrizzle, color: 'bg-cyan-500 text-white' },
	{ key: 'ppio', baseURL: 'https://api.ppinfra.com/v3/openai', keyUrl: 'https://ppinfra.com', icon: CircleDot, color: 'bg-emerald-500 text-white' },
	{ key: 'ollama', baseURL: 'http://127.0.0.1:11434/v1', needKey: false, icon: SquareTerminal, color: 'bg-stone-700 text-white' },
];

// Brand-name providers are universal in English; the China-specific ones
// (火山引擎 / 阿里云 / etc.) get i18n'd via modelSection.providers.<key>.
// Ollama's "(本地)" suffix is locale-aware.
const BRAND_LABEL_KEYS: Record<string, string | null> = {
	custom: 'modelSection.providers.custom',
	dashscope: 'modelSection.providers.dashscope',
	siliconflow: 'modelSection.providers.siliconflow',
	hunyuan: 'modelSection.providers.hunyuan',
	ollama: 'modelSection.providers.ollama',
	// English-brand providers: no key, fall back to the hardcoded label below
	deepseek: null,
	'minimax-cn': null,
	'minimax-global': null,
	bigmodel: null,
	mimo: null,
	zai: null,
	openrouter: null,
	'kimi-cn': null,
	'kimi-global': null,
	byteplus: null,
	ppio: null,
};
const BRAND_LABELS: Record<string, string> = {
	deepseek: 'DeepSeek',
	'minimax-cn': 'MiniMax CN',
	'minimax-global': 'MiniMax Global',
	bigmodel: 'Bigmodel',
	mimo: 'Xiaomi MIMO',
	zai: 'Z.ai',
	openrouter: 'OpenRouter',
	'kimi-cn': 'Kimi CN',
	'kimi-global': 'Kimi Global',
	byteplus: 'BytePlus',
	ppio: 'PPIO',
};

function buildProviders(t: (key: string) => string): ProviderDef[] {
	return PROVIDER_DEFS.map((p) => {
		const keyPath = BRAND_LABEL_KEYS[p.key];
		const label = keyPath ? t(keyPath) : BRAND_LABELS[p.key];
		return { ...p, label };
	});
}
// Helper functions live inside ModelSection so they see the translated labels.

interface ModelItem {
	id: string;
	provider: string;
	label: string;
	model: string;
	baseURL: string;
	enabled: boolean;
	apiKeySet: boolean;
	localOnly?: boolean;
	/** apiKey 明文（仅云端下发，用于同步本地镜像；展示层不回显） */
	apiKey?: string;
	/** 视觉输入能力：true/false 强制开关；null = 按模型名自动判断 */
	vision?: boolean | null;
	/** CoCode 内置官方模型：不在设置界面展示，但需同步到本地镜像供 core 运行时使用 */
	isOfficial?: boolean;
}

function ProviderIcon({ p, size = 'size-7' }: { p: ProviderDef; size?: string }) {
	const src = PROVIDER_ICONS[p.key];
	if (src) {
		// 官方品牌图：白底圆角方块，logo 原色
		return (
			<span className={`flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-white ${size}`}>
				<img src={src} alt="" className="size-[72%] object-contain" draggable={false} />
			</span>
		);
	}
	const Icon = p.icon;
	return (
		<span className={`flex shrink-0 items-center justify-center rounded-md ${size} ${p.color}`}>
			<Icon className="size-4" />
		</span>
	);
}

function Row({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children?: React.ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-5 py-4">
			<div className="min-w-0">
				<div className="text-sm font-medium">{title}</div>
				{description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

// ==================== 模型板块（三层） ====================

type ModelView = 'list' | 'picker' | 'form' | 'codex';

export function ModelSection() {
	const { t } = useTranslation();
	// Build provider list with translated labels; the same array is used
	// by the dropdown, the picker grid, and the row-lookup helpers below.
	const PROVIDERS = useMemo(() => buildProviders(t), [t]);
	const GRID_PROVIDERS = useMemo(() => PROVIDERS.filter((p) => p.key !== 'custom'), [PROVIDERS]);
	const getProvider = (key: string): ProviderDef | undefined => key === CODEX_PROVIDER
		? { key: 'openai', label: 'Codex', baseURL: '', icon: Box, color: 'bg-foreground text-background' }
		: PROVIDERS.find((p) => p.key === key);
	const [codexBusy, setCodexBusy] = useState(false);
	const [view, setView] = useState<ModelView>('list');
	const [items, setItems] = useState<ModelItem[]>([]);
	const [loading, setLoading] = useState(false);
	const [listErr, setListErr] = useState<string | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const loggedIn = !!getToken();
	const listRequest = useRef(0);

	// 表单层状态
	const [fProvider, setFProvider] = useState('deepseek');
	const [fModel, setFModel] = useState('');
	const [fKey, setFKey] = useState('');
	const [fModels, setFModels] = useState<string[]>([]);
	const [fLoading, setFLoading] = useState(false);
	const [fErr, setFErr] = useState<string | null>(null);
	const [fShowAdvanced, setFShowAdvanced] = useState(false);
	const [fSelected, setFSelected] = useState<Set<string>>(new Set());
	const [fBaseURL, setFBaseURL] = useState('');
	// 视觉输入三态：'auto' 按模型名推断 / 'on' 强制支持 / 'off' 强制不支持
	const [fVision, setFVision] = useState<'auto' | 'on' | 'off'>('auto');
	const [submitting, setSubmitting] = useState(false);

	const fDef = getProvider(fProvider) ?? PROVIDERS[1];
	const effBaseURL = fDef.key === 'custom' ? fBaseURL.trim() : fDef.baseURL;

	async function loadList(silent = false) {
		const request = ++listRequest.current;
		const token = getToken();
		const current = () => request === listRequest.current && getToken() === token;
		if (!silent) setLoading(true);
		setListErr(null);
		try {
			if (!token) {
				setItems([]);
				setListErr(t('modelSection.errors.loginRequired'));
				return;
			}
			const [cloud, local] = await Promise.allSettled([
				(async () => {
					const res = await cloudFetch('/models', { signal: AbortSignal.timeout(10000) });
					const body = await res.json();
					if (!res.ok) throw new Error(body?.detail || t('modelSection.errors.backend', { status: res.status }));
					return (Array.isArray(body.models) ? body.models : []).filter((m: ModelItem) => !m.isOfficial).map((model: ModelItem) => ({ ...model, localOnly: false })) as ModelItem[];
				})(),
				codexApi.status(),
			]);
			if (!current()) return;
			const cloudModels = cloud.status === 'fulfilled' ? cloud.value : [];
			setItems([...cloudModels, ...(local.status === 'fulfilled' ? local.value.models : [])]);
			if (cloud.status === 'fulfilled') await syncLocalModelMirror(cloudModels, token);
			else setListErr(cloud.reason instanceof Error ? cloud.reason.message : String(cloud.reason));
			if (local.status === 'rejected') setListErr(t('codex.error'));
			if (current()) void queryClient.invalidateQueries({ queryKey: AVAILABLE_MODELS_KEY });
		} catch (e) {
			if (current()) setListErr(e instanceof Error ? e.message : String(e));
		} finally {
			if (current()) setLoading(false);
		}
	}

	useEffect(() => {
		const requestSequence = listRequest;
		void loadList();
		return () => { requestSequence.current++; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// 按 baseURL + key 拉取模型列表（服务端代理，绕 CORS）
	async function fetchModelList(base = effBaseURL, key = fKey) {
		if (!base) return;
		setFLoading(true);
		setFErr(null);
		try {
			const url = `${apiUrl('/admin/models')}?baseURL=${encodeURIComponent(base)}${key ? `&apiKey=${encodeURIComponent(key)}` : ''}`;
			const res = await fetch(url);
			const body = await res.json();
			if (!res.ok) throw new Error(body?.detail || t('modelSection.errors.backend', { status: res.status }));
			const ids: string[] = body.models ?? [];
			setFModels(ids);
			if (ids.length === 0) setFErr(t('modelSection.errors.noModels'));
		} catch (e) {
			setFModels([]);
			setFErr(e instanceof Error ? e.message : String(e));
		} finally {
			setFLoading(false);
		}
	}

	function openPicker() {
		if (!loggedIn) return; // 未登录不允许进入添加流程（提交也会 401）
		setView('picker');
	}

	function openForm(key: string) {
		const def = getProvider(key);
		setEditingId(null);
		setFProvider(key);
		setFModel('');
		setFKey('');
		setFModels([]);
		setFSelected(new Set());
		setFErr(null);
		setFShowAdvanced(key === 'custom');
		setFBaseURL(key === 'custom' ? '' : def?.baseURL ?? '');
		setFVision('auto');
		setView('form');
		// 本地服务无需 Key，进入表单即拉模型列表
		if (def && def.needKey === false) fetchModelList(def.baseURL, '');
	}

	function openEdit(item: ModelItem) {
		if (item.localOnly) { setEditingId(item.id); setView('codex'); return; }
		setEditingId(item.id);
		setFProvider(item.provider);
		setFModel(item.model);
		setFKey('');
		setFModels(item.model ? [item.model] : []);
		setFErr(null);
		setFShowAdvanced(item.provider === 'custom');
		setFBaseURL(item.baseURL);
		setFVision(item.vision === true ? 'on' : item.vision === false ? 'off' : 'auto');
		setView('form');
	}

	async function handleSubmit() {
		if (!effBaseURL) return;
		const selected = [...fSelected];
		const single = fModel.trim();
		if (selected.length === 0 && !single) return;
		setSubmitting(true);
		setFErr(null);
		try {
			const visionValue = fVision === 'auto' ? null : fVision === 'on';
			if (editingId) {
				// 编辑单条：走云端 PATCH
				const payload: Record<string, unknown> = { model: single, baseURL: effBaseURL, vision: visionValue };
				if (fKey.trim()) payload.apiKey = fKey.trim();
				const res = await cloudFetch(`/models/${editingId}`, {
					method: 'PATCH',
					body: JSON.stringify(payload),
				});
				const body = await res.json();
				if (!res.ok) throw new Error(body?.detail || t('modelSection.errors.backend', { status: res.status }));
			} else {
				// 新增：多选批量 / 单填 —— 走云端 POST，apiKey 留空则云端复用同供应商已有 key
				const models = selected.length ? selected : [single];
				const payload: Record<string, unknown> = { models, baseURL: effBaseURL, provider: fDef.key, label: fDef.label, vision: visionValue };
				if (fKey.trim()) payload.apiKey = fKey.trim();
				const res = await cloudFetch('/models', {
					method: 'POST',
					body: JSON.stringify(payload),
				});
				const body = await res.json();
				if (!res.ok) throw new Error(body?.detail || t('modelSection.errors.backend', { status: res.status }));
			}
			setView('list');
			await loadList(true); // 重新拉云端（拿到生成的 id/apiKey）+ 同步本地镜像
		} catch (e) {
			setFErr(t('modelSection.errors.submitFailed', { error: e instanceof Error ? e.message : String(e) }));
		} finally {
			setSubmitting(false);
		}
	}

	function codexChanged() {
		void queryClient.invalidateQueries({ queryKey: AVAILABLE_MODELS_KEY });
		return loadList(true);
	}

	async function updateCodexItem(item: ModelItem, enabled?: boolean) {
		if (codexBusy) return;
		setCodexBusy(true); setListErr(null);
		try {
			const status = await codexApi.status();
			const models = enabled === undefined ? status.models.filter(model => model.model !== item.model)
				: status.models.map(model => model.model === item.model ? { ...model, enabled } : model);
			const next = await codexApi.saveModels(models.map(model => ({ model: model.model, enabled: model.enabled })));
			setItems(current => [...current.filter(model => !model.localOnly), ...next.models]);
			await codexChanged();
		} catch { setListErr(t('codex.error')); }
		finally { setCodexBusy(false); }
	}

	async function handleToggle(item: ModelItem, enabled: boolean) {
		if (item.localOnly) { await updateCodexItem(item, enabled); return; }
		setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, enabled } : it)));
		try {
			const res = await cloudFetch(`/models/${item.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ enabled }),
			});
			if (!res.ok) throw new Error('toggle failed');
			await loadList(true); // 静默重拉 + 同步本地镜像
		} catch {
			setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, enabled: !enabled } : it)));
		}
	}

	async function handleDelete(item: ModelItem) {
		if (item.localOnly) { await updateCodexItem(item); return; }
		setItems((prev) => prev.filter((it) => it.id !== item.id));
		try {
			const res = await cloudFetch(`/models/${item.id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error('delete failed');
			await loadList(true); // 静默重拉 + 同步本地镜像
		} catch {
			loadList(true);
		}
	}

	if (view === 'codex') return <CodexSubscriptionView onBack={() => setView(editingId ? 'list' : 'picker')} onChanged={() => { void codexChanged(); }} onDone={() => setView('list')} />;

	// ---------- 第三层：通过服务商添加 / 编辑表单 ----------
	if (view === 'form') {
		const canSubmit = !!effBaseURL && (fSelected.size > 0 || !!fModel.trim()) && !submitting;
		return (
			<div data-model-form className="flex h-full flex-col animate-in fade-in slide-in-from-right-2 duration-250 ease-out">
				<div className="flex items-center gap-2">
					<button
						type="button"
						aria-label={t("modelSection.aria.back")}
						className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
						onClick={() => setView(editingId ? 'list' : 'picker')}
					>
						<ChevronLeft className="size-5" />
					</button>
					<h3 className="text-lg font-semibold">{editingId ? t('modelSection.form.titleEdit') : t('modelSection.form.titleAdd')}</h3>
				</div>

				<div className="mt-5 flex-1 space-y-5 overflow-y-auto pr-1">
					{/* 服务商 */}
					<div>
						<div className="text-sm font-medium">
							<span className="mr-1 text-destructive">*</span>{t('modelSection.form.provider')}
						</div>
						<DropdownSelect
							className="mt-2"
							value={fProvider}
							disabled={!!editingId}
							onChange={(v) => openForm(v)}
							options={PROVIDERS.map((p) => ({ value: p.key, label: p.label }))}
						/>
					</div>

				{/* API 密钥 */}
				{fDef.needKey !== false && (
					<div>
						<div className="flex items-center justify-between">
							<div className="text-sm font-medium">
								<span className="mr-1 text-destructive">*</span>{t('modelSection.form.apiKey')}
							</div>
							{fDef.keyUrl && (
								<a
									href={fDef.keyUrl}
									target="_blank"
									rel="noreferrer"
									className="flex items-center gap-1 text-sm font-medium underline underline-offset-2 hover:text-primary"
								>
									{t('modelSection.form.getApiKey')}
									<ExternalLink className="size-3.5" />
								</a>
							)}
						</div>
						<input
							type="password"
							value={fKey}
							onChange={(e) => setFKey(e.target.value)}
						onBlur={() => effBaseURL && fetchModelList()}
						placeholder={editingId && !fKey ? t('modelSection.form.apiKeyKeepEmpty') : t('modelSection.form.apiKeyPlaceholder')}
						className="mt-2 h-10 w-full rounded-lg border border-input bg-muted px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
					/>
				</div>
			)}

			{/* 模型（多选：同一 Key 可一次加多个） */}
			<div>
				<div className="text-sm font-medium">
					<span className="mr-1 text-destructive">*</span>{t('modelSection.form.model')}
				</div>
				{fModels.length > 0 && (
					<div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-input bg-muted p-1.5">
						<div className="flex items-center justify-between px-1 pb-1.5">
							<span className="text-xs text-muted-foreground">
								{t('modelSection.form.selectedCount', { count: fSelected.size })}
							</span>
							<button
								type="button"
								className="text-xs text-primary hover:underline"
								onClick={() => setFSelected((s) => s.size === fModels.length ? new Set() : new Set(fModels))}
							>
								{fSelected.size === fModels.length ? t('modelSection.form.deselectAll') : t('modelSection.form.selectAll')}
							</button>
						</div>
						{fModels.map((mi) => {
							const checked = fSelected.has(mi);
							const added = items.some((x) => x.provider === fDef.key && x.model === mi && x.apiKeySet);
							return (
								<label
									key={mi}
									className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted ${checked ? 'bg-primary-soft' : ''}`}
								>
									<input
										type="checkbox"
										checked={checked}
										onChange={(e) => setFSelected((s) => {
											const next = new Set(s);
											if (e.target.checked) next.add(mi); else next.delete(mi);
											return next;
										})}
										className="size-3.5 accent-primary"
									/>
									<span className="min-w-0 flex-1 truncate">{mi}</span>
									{added && <span className="text-[10px] text-emerald-600">✓{t('modelSection.form.alreadyAdded')}</span>}
								</label>
							);
						})}
					</div>
				)}
				{/* 手动输入兜底：列表为空 / 想加列表外的模型名 */}
				<input
					type="text"
					value={fModel}
					onChange={(e) => setFModel(e.target.value)}
					placeholder={fLoading ? t('modelSection.form.fetchingModels') : t('modelSection.form.modelInputPlaceholder')}
					className="mt-2 h-10 w-full rounded-lg border border-input bg-muted px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
				/>
					{fLoading && (
						<div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
							<Loader2 className="size-3 animate-spin" /> {t('modelSection.form.fetchingModels')}
						</div>
					)}
					{!fLoading && fModels.length === 0 && !fErr && (
						<div className="mt-1.5 text-xs text-muted-foreground">{t('modelSection.form.fetchHint')}</div>
					)}
				</div>

					{/* 高级配置 */}
					<div className="border-t border-border pt-3">
						<button
							type="button"
							className="flex items-center gap-1 text-sm font-semibold"
							onClick={() => setFShowAdvanced((v) => !v)}
						>
							{t('modelSection.form.advanced')}
							<ChevronRight className={`size-4 transition-transform ${fShowAdvanced ? 'rotate-90' : ''}`} />
						</button>
						{fShowAdvanced && (
							<div className="mt-3 space-y-3">
								<div>
									<div className="text-xs text-muted-foreground">{t('modelSection.form.baseUrl')}</div>
									<input
										type="url"
										value={fDef.key === 'custom' ? fBaseURL : fDef.baseURL}
										onChange={(e) => {
											if (fDef.key === 'custom') setFBaseURL(e.target.value);
										}}
										readOnly={fDef.key !== 'custom'}
										placeholder="https://your-host/v1"
										className="mt-1.5 h-10 w-full rounded-lg border border-input bg-muted px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring read-only:opacity-70"
									/>
								</div>
								<div>
									<div className="text-xs text-muted-foreground">{t('modelSection.form.vision.title')}</div>
									<div className="mt-1.5 inline-flex items-center rounded-lg border bg-muted p-0.5">
										{([
											{ value: 'auto', label: t('modelSection.form.vision.auto') },
											{ value: 'on', label: t('modelSection.form.vision.on') },
											{ value: 'off', label: t('modelSection.form.vision.off') },
										] as Array<{ value: 'auto' | 'on' | 'off'; label: string }>).map(({ value, label }) => (
											<button
												key={value}
												type="button"
												aria-pressed={fVision === value}
												onClick={() => setFVision(value)}
												className={
													'rounded-md px-2.5 py-1 text-xs transition-colors ' +
													(fVision === value
														? 'bg-background text-foreground shadow-sm'
														: 'text-muted-foreground hover:text-foreground')
												}
											>
												{label}
											</button>
										))}
									</div>
									<div className="mt-1 text-[11px] text-muted-foreground">{t('modelSection.form.vision.hint')}</div>
								</div>
							</div>
						)}
					</div>

					{fErr && <div className="rounded-md bg-destructive-soft px-3 py-2 text-xs text-destructive">{fErr}</div>}
				</div>

				{/* 底部操作条 */}
				<div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
					<div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
						<Info className="size-3.5 shrink-0" />
						{t('modelSection.form.saveHint')}
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<Button type="button" variant="outline" size="sm" disabled={submitting} onClick={() => setView(editingId ? 'list' : 'picker')}>
							{t('modelSection.form.reset')}
						</Button>
						<Button type="button" size="sm" disabled={!canSubmit} onClick={handleSubmit}>
							{submitting && <Loader2 className="size-3 animate-spin" />}
							{editingId ? t('modelSection.form.saveEdit') : t('modelSection.form.saveAdd')}
						</Button>
					</div>
				</div>
			</div>
		);
	}

	// ---------- 第一层：模型列表 ----------
	return (
		<>
			<h3 className="text-lg font-semibold">{t('modelSection.title')}</h3>
			<div className="mt-3 text-sm font-medium">{t('modelSection.subtitle')}</div>
			<div className="mt-1 text-xs text-muted-foreground">{t('modelSection.desc')}</div>

			<Button type="button" size="sm" variant="outline" className="mt-4" onClick={openPicker} disabled={!loggedIn}>
				<Plus className="size-4" />
				{t('modelSection.addModel')}
			</Button>

			{listErr && <div className="mt-3 rounded-md bg-destructive-soft px-3 py-2 text-xs text-destructive">{listErr}</div>}

			{loading ? (
				<div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
					<Loader2 className="size-3.5 animate-spin" /> {t('modelSection.loading')}
				</div>
			) : items.length === 0 ? (
				<div className="mt-4 rounded-xl border border-dashed border-border px-5 py-8 text-center text-xs text-muted-foreground">
					{t('modelSection.empty')}
				</div>
			) : (
				<div className="mt-4 overflow-hidden rounded-xl border border-border">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-border bg-muted text-left text-xs text-muted-foreground">
								<th className="px-4 py-2.5 font-medium">{t('modelSection.tableHeaders.model')}</th>
								<th className="px-4 py-2.5 font-medium">{t('modelSection.tableHeaders.provider')}</th>
								<th className="px-4 py-2.5 font-medium">{t('modelSection.tableHeaders.actions')}</th>
							</tr>
						</thead>
						<tbody>
							{items.map((it) => {
								const def = getProvider(it.provider) ?? PROVIDERS[0];
								return (
									<tr key={it.id} data-model-source={it.localOnly ? 'codex' : 'cloud'} className={`border-b border-border last:border-b-0 ${it.enabled ? '' : 'opacity-50'}`}>
										<td className="px-4 py-3">
											<div className="flex items-center gap-2.5">
												<ProviderIcon p={def} />
												<span className="truncate font-medium">{it.model}</span>
											</div>
										</td>
										<td className="px-4 py-3 text-muted-foreground">{it.label}{it.localOnly && <span className="mt-0.5 block text-xs">{t('codex.localOnly')}</span>}</td>
										<td className="px-4 py-3">
											<div className="flex items-center gap-2.5">
												<button
													type="button"
													aria-label={t('modelSection.aria.edit')}
													className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
													onClick={() => openEdit(it)}
															disabled={it.localOnly && codexBusy}
												>
													<Pencil className="size-3.5" />
												</button>
												<button
													type="button"
													aria-label={t('modelSection.aria.delete')}
													className="rounded-md p-1 text-muted-foreground hover:bg-destructive-soft hover:text-destructive"
													onClick={() => handleDelete(it)}
															disabled={it.localOnly && codexBusy}
												>
													<Trash2 className="size-3.5" />
												</button>
												<Switch
													size="sm"
													checked={it.enabled}
													onCheckedChange={(v) => handleToggle(it, v)}
															disabled={it.localOnly && codexBusy}
												/>
											</div>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}

			{/* ---------- 第二层：添加模型弹窗（服务商网格） ---------- */}
			{view === 'picker' && (
				<div
					className="absolute inset-0 z-10 flex items-start justify-center bg-background animate-in fade-in slide-in-from-right-2 duration-250 ease-out"
					onClick={() => setView('list')}
				>
					<div className="flex max-h-full w-full flex-col px-7 py-6" onClick={(e) => e.stopPropagation()}>
						<div className="flex items-center justify-between">
							<h3 className="text-lg font-semibold">{t('modelSection.addModel')}</h3>
							<button
								type="button"
								aria-label={t('modelSection.aria.close')}
								className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
								onClick={() => setView('list')}
							>
								<X className="size-4" />
							</button>
						</div>
						<div className="mt-4 flex-1 overflow-y-auto pr-1">
							<button type="button" data-testid="add-codex-subscription" className="mb-3 flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" onClick={() => { setEditingId(null); setView('codex'); }}>
								<ProviderIcon p={getProvider(CODEX_PROVIDER)!} size="size-9" />
								<span className="min-w-0 flex-1"><span className="block font-semibold">{t('codex.title')}</span><span className="mt-0.5 block text-xs text-muted-foreground">{t('codex.subtitle')}</span></span>
								<ChevronRight className="size-4 shrink-0 text-muted-foreground" />
							</button>
							<button
								type="button"
								className="mb-3 flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:bg-muted hover:shadow-md"
								onClick={() => openForm('custom')}
							>
								<ProviderIcon p={PROVIDERS[0]} size="size-9" />
								<span className="flex-1 font-semibold">{t('modelSection.providers.custom')}</span>
								<ChevronRight className="size-4 text-muted-foreground" />
							</button>
							<div className="grid grid-cols-2 gap-3">
								{GRID_PROVIDERS.map((p) => (
									<button
										key={p.key}
										type="button"
										className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:bg-muted hover:shadow-md"
										onClick={() => openForm(p.key)}
									>
										<ProviderIcon p={p} size="size-9" />
										<span className="flex-1 truncate font-medium">{p.label}</span>
										<ChevronRight className="size-4 text-muted-foreground" />
									</button>
								))}
							</div>
						</div>
					</div>
				</div>
			)}
		</>
	);
}

// ==================== 提示音板块 ====================

/** 自定义音效文件大小上限：音效不需要高保真，10MB 足够宽松。 */
const SOUND_FILE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 提示音设置（自包含：配置写 localStorage、自定义音频写 IndexedDB，
 * 不并入 runtime state —— 与高级板块同理，各自的存储路径不同）。
 * 配置结构见 lib/sound.ts；「试听」绕过开关与防抖，按当前表单值直接播。
 */
function SoundSection() {
	const { t } = useTranslation();
	const [s, setS] = useState<SoundSettings>(() => loadSoundSettings());
	const [customName, setCustomName] = useState<string | null>(null);
	const [fileErr, setFileErr] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	// 挂载时读取已存的自定义音效文件名（IndexedDB 是异步的，只能后置填充）
	useEffect(() => {
		let alive = true;
		void getCustomSound().then((rec) => {
			if (alive) setCustomName(rec?.name ?? null);
		});
		return () => {
			alive = false;
		};
	}, []);

	function update(patch: Partial<SoundSettings>) {
		setS((prev) => {
			const next = { ...prev, ...patch };
			saveSoundSettings(next);
			return next;
		});
	}

	async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0];
		e.target.value = '';
		if (!file) return;
		if (file.size > SOUND_FILE_MAX_BYTES) {
			setFileErr(t('settings.general.sound.tooLarge'));
			return;
		}
		setFileErr(null);
		try {
			await saveCustomSound(file);
			setCustomName(file.name);
			update({ kind: 'custom' });
		} catch {
			setFileErr(t('settings.general.sound.saveFailed'));
		}
	}

	async function onClearCustom() {
		try {
			await clearCustomSound();
		} catch {
			// 删不掉也无碍：切回内置音效，遗留记录下次覆盖。
		}
		setCustomName(null);
		if (s.kind === 'custom') update({ kind: 'ding' });
	}

	const kindLabels: Record<SoundKind, string> = {
		ding: t('settings.general.sound.kindDing'),
		crisp: t('settings.general.sound.kindCrisp'),
		soft: t('settings.general.sound.kindSoft'),
		custom: t('settings.general.sound.kindCustom'),
	};

	return (
		<>
			<Row title={t('settings.general.sound.title')} description={t('settings.general.sound.desc')}>
				<Switch size="sm" checked={s.enabled} onCheckedChange={(v) => update({ enabled: v })} />
			</Row>
			<Row title={t('settings.general.sound.replyDoneTitle')} description={t('settings.general.sound.replyDoneDesc')}>
				<Switch size="sm" checked={s.replyDone} disabled={!s.enabled} onCheckedChange={(v) => update({ replyDone: v })} />
			</Row>
			<Row title={t('settings.general.sound.needConfirmTitle')} description={t('settings.general.sound.needConfirmDesc')}>
				<Switch size="sm" checked={s.needConfirm} disabled={!s.enabled} onCheckedChange={(v) => update({ needConfirm: v })} />
			</Row>
			<Row title={t('settings.general.sound.kindTitle')} description={t('settings.general.sound.kindDesc')}>
				<div className="flex items-center gap-2">
					<DropdownSelect
						className="w-28"
						value={s.kind}
						disabled={!s.enabled}
						onChange={(v) => update({ kind: v as SoundKind })}
						options={(Object.keys(kindLabels) as SoundKind[]).map((k) => ({ value: k, label: kindLabels[k] }))}
					/>
					<Button variant="outline" size="sm" disabled={!s.enabled} onClick={() => previewSound()}>
						{t('settings.general.sound.preview')}
					</Button>
				</div>
			</Row>
			{s.kind === 'custom' && (
				<Row title={t('settings.general.sound.customTitle')} description={t('settings.general.sound.customDesc')}>
					<div className="flex items-center gap-2">
						{customName && (
							<span className="max-w-44 truncate text-xs text-muted-foreground" title={customName}>
								{customName}
							</span>
						)}
						<input ref={fileRef} type="file" accept="audio/*" className="hidden" onChange={(e) => void onPickFile(e)} />
						<Button variant="outline" size="sm" disabled={!s.enabled} onClick={() => fileRef.current?.click()}>
							{t('settings.general.sound.customChoose')}
						</Button>
						{customName && (
							<Button variant="ghost" size="sm" disabled={!s.enabled} onClick={() => void onClearCustom()}>
								{t('settings.general.sound.customClear')}
							</Button>
						)}
					</div>
				</Row>
			)}
			{fileErr && <div className="px-5 text-xs text-destructive">{fileErr}</div>}
			<Row title={t('settings.general.sound.volumeTitle')} description={t('settings.general.sound.volumeDesc')}>
				<DropdownSelect
					className="w-28"
					value={String(s.volume)}
					disabled={!s.enabled}
					onChange={(v) => update({ volume: Number(v) })}
					options={[
						{ value: '0.25', label: '25%' },
						{ value: '0.5', label: '50%' },
						{ value: '0.75', label: '75%' },
						{ value: '1', label: '100%' },
					]}
				/>
			</Row>
		</>
	);
}

// ==================== 智能体板块 ====================
// 原聊天页侧栏的智能体选择器 + 设置入口迁入此处（CoCode 定制）。

type AgentRoleFields = {
	name: string;
	avatar: string | null;
	personality: string;
	system_prompt: string;
	chat_model_config: ChatModelConfig | null;
};

type AgentRoleDraft = {
	agentId: string | null;
	overrides: Partial<AgentRoleFields>;
	saving?: boolean;
};

// Replay one detached request without rebuilding from live fields or retaining age.
type AgentRoleSaveSnapshot = {
	readonly draft: AgentRoleDraft;
	readonly context: string;
	readonly revision: number;
	readonly needsReview: boolean;
} & (
	| { readonly roleId: string; readonly body: Readonly<UpdateAgentRequest> }
	| { readonly roleId: null; readonly body: Readonly<CreateAgentRequest> }
);

const ROLE_MODERATION_ERROR_KEYS = new Map<string, string>([
	['ROLE_MODERATION_BLOCKED', 'agentSection.moderationBlocked'],
	['ROLE_AGE_RESTRICTED', 'agentSection.ageRestricted'],
	['ROLE_MODERATION_UNAVAILABLE', 'agentSection.moderationUnavailable'],
	['ROLE_MODERATION_TIMEOUT', 'agentSection.moderationTimeout'],
	['ROLE_REVIEW_STALE', 'agentSection.moderationStale'],
]);

function AgentSection({ draft, onDraftChange, onAddModel }: {
	draft: AgentRoleDraft | null;
	onDraftChange: React.Dispatch<React.SetStateAction<AgentRoleDraft | null>>;
	onAddModel: () => void;
}) {
	const { t } = useTranslation();
	const { agents, loading, error: loadError, refetch, create, update } = useAgents();
	const [reviewing, setReviewing] = useState<AgentRoleSaveSnapshot | null>(null);
	const saving = reviewing !== null || draft?.saving === true;
	const [uploading, setUploading] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [ageChallenge, setAgeChallenge] = useState<AgentRoleSaveSnapshot | null>(null);
	const ageChallengeRef = useRef<AgentRoleSaveSnapshot | null>(null);
	const mounted = useRef(false);
	const uploadScope = useRef(0);
	const saveLock = useRef(false);
	const reviewRevision = useRef(0);
	const reviewContext = useRef<string | null>(null);
	const liveDraft = useRef(draft);
	const fileInput = useRef<HTMLInputElement>(null);

	useLayoutEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			uploadScope.current += 1;
			reviewRevision.current += 1;
			ageChallengeRef.current = null;
		};
	}, []);

	useEffect(() => {
		if (draft || loading || loadError) return;
		onDraftChange(previous => previous ?? { agentId: agents[0]?.id ?? null, overrides: {} });
	}, [draft, agents, loading, loadError, onDraftChange]);

	const agentId = draft?.agentId ?? null;
	const current = agents.find(agent => agent.id === agentId);
	const overrides: Partial<AgentRoleFields> = draft?.overrides ?? {};
	const fields: AgentRoleFields = {
		name: current?.data.name ?? '',
		avatar: current?.data.avatar ?? null,
		personality: current?.data.personality ?? '',
		system_prompt: current?.data.system_prompt ?? '',
		chat_model_config: current?.data.chat_model_config ?? null,
		...overrides,
	};
	const { name, avatar, personality, system_prompt: prompt, chat_model_config: model } = fields;
	const editable = draft !== null && (agentId === null || current?.editable === true);
	const editableRef = useRef(editable);
	const busy = saving || uploading;
	const hasChanges = Object.keys(overrides).length > 0;
	const context = JSON.stringify({ draft: draft && { agentId, overrides }, current: current ?? null, fields });
	// Commit callback guards before any passive effects or user events can run.
	useLayoutEffect(() => {
		liveDraft.current = draft;
		editableRef.current = editable;
		if (reviewContext.current !== context) {
			reviewContext.current = context;
			reviewRevision.current += 1;
			ageChallengeRef.current = null;
		}
	}, [draft, editable, context]);
	// Forget mismatched state immediately so A → B → A cannot revive a challenge.
	if (ageChallenge && (ageChallenge.context !== context || !editable)) setAgeChallenge(null);
	const pendingAge = ageChallenge?.context === context && editable ? ageChallenge : null;
	const isCurrentSave = (snapshot: AgentRoleSaveSnapshot) => mounted.current && editableRef.current
		&& snapshot.revision === reviewRevision.current && snapshot.context === reviewContext.current;
	const invalidateAgeChallenge = () => {
		reviewRevision.current += 1;
		ageChallengeRef.current = null;
		setAgeChallenge(null);
	};
	const dismissAgeChallenge = (snapshot: AgentRoleSaveSnapshot | null) => {
		if (ageChallengeRef.current !== snapshot) return;
		ageChallengeRef.current = null;
		setAgeChallenge(null);
	};

	const select = (nextId: string | null) => {
		if (busy || saveLock.current || (draft && nextId === agentId)) return;
		invalidateAgeChallenge();
		uploadScope.current += 1;
		onDraftChange({ agentId: nextId, overrides: {} });
		setSaved(false);
		setError(null);
	};

	const change = (patch: Partial<AgentRoleFields>) => {
		if (busy || saveLock.current || !editable) return;
		invalidateAgeChallenge();
		onDraftChange(previous => previous && previous.agentId === agentId
			? { ...previous, overrides: { ...previous.overrides, ...patch } }
			: previous);
		setSaved(false);
	};

	const submitSnapshot = async (snapshot: AgentRoleSaveSnapshot, adult = false) => {
		if (saveLock.current || !isCurrentSave(snapshot)) return;
		const sourceDraft = liveDraft.current;
		if (!sourceDraft || sourceDraft.saving) return;
		saveLock.current = true;
		setReviewing(snapshot);
		const pendingDraft: AgentRoleDraft = { ...sourceDraft, saving: true };
		onDraftChange(previous => previous === sourceDraft ? pendingDraft : previous);
		setError(null);
		setSaved(false);
		try {
			let nextId = snapshot.roleId;
			if (snapshot.roleId !== null) {
				await update(snapshot.roleId, adult ? { ...snapshot.body, age_confirmation: 'adult' } : snapshot.body, { silent: true });
			} else {
				const result = await create(adult ? { ...snapshot.body, age_confirmation: 'adult' } : snapshot.body, { silent: true });
				nextId = result.agent_id;
			}
			onDraftChange(previous => previous === pendingDraft ? { agentId: nextId, overrides: {} } : previous);
			if (mounted.current && (liveDraft.current === pendingDraft || liveDraft.current === sourceDraft)) setSaved(true);
		} catch (cause) {
			if (!isCurrentSave(snapshot)) return;
			if (cause instanceof ApiError && cause.code === 'ROLE_AGE_REQUIRED') {
				ageChallengeRef.current = snapshot;
				setAgeChallenge(snapshot);
			} else {
				const key = cause instanceof ApiError ? ROLE_MODERATION_ERROR_KEYS.get(cause.code ?? '') : undefined;
				setError(key ? t(key) : t('agentSection.saveFailed', { error: cause instanceof Error ? cause.message : String(cause) }));
			}
		} finally {
			// Clear only our saving marker, even after unmount, without reviving a closed draft.
			onDraftChange(previous => previous === pendingDraft ? snapshot.draft : previous);
			if (mounted.current) setReviewing(null);
			saveLock.current = false;
		}
	};

	const handleSave = async () => {
		if (busy || saveLock.current || ageChallengeRef.current || !editable || !draft || (agentId && !hasChanges)) return;
		if (!name.trim()) { setError(t('agentSection.nameRequired')); return; }
		const captured = { draft: structuredClone({ agentId, overrides }), context, revision: reviewRevision.current };
		let snapshot: AgentRoleSaveSnapshot;
		if (agentId !== null) {
			const body = structuredClone(overrides);
			if (body.name !== undefined) body.name = body.name.trim();
			const needsReview = (['name', 'personality', 'system_prompt'] as const)
				.some(key => body[key] !== undefined && body[key] !== (current?.data[key] ?? ''));
			snapshot = { ...captured, roleId: agentId, body, needsReview };
		} else {
			snapshot = { ...captured, roleId: null, body: { ...structuredClone(fields), name: name.trim() }, needsReview: true };
		}
		await submitSnapshot(snapshot);
	};

	const confirmAge = (snapshot: AgentRoleSaveSnapshot, adult: boolean) => {
		if (busy || saveLock.current || ageChallengeRef.current !== snapshot || !isCurrentSave(snapshot)) return;
		dismissAgeChallenge(snapshot);
		if (adult) void submitSnapshot(snapshot, true);
		else setError(t('agentSection.ageRestricted'));
	};

	const upload = async (file: File) => {
		if (busy || saveLock.current || !editable || !draft) return;
		invalidateAgeChallenge();
		const scope = ++uploadScope.current;
		setUploading(true);
		setError(null);
		setSaved(false);
		try {
			const next = await readRoleAvatar(file);
			if (mounted.current && scope === uploadScope.current && editableRef.current) {
				onDraftChange(previous => previous === draft
					? { ...previous, overrides: { ...previous.overrides, avatar: next } }
					: previous);
			}
		} catch (cause) {
			if (mounted.current && scope === uploadScope.current && editableRef.current) setError(t(cause instanceof RangeError ? 'agentSection.avatarInvalid' : 'agentSection.avatarFailed'));
		} finally {
			if (mounted.current && scope === uploadScope.current) setUploading(false);
		}
	};

	const fieldClass = 'mt-2 w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
	return (
		<section data-testid="agent-role-settings">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<h3 className="text-lg font-semibold">{t('agentSection.title')}</h3>
					<p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">{t('agentSection.desc')}</p>
				</div>
				<Button type="button" size="sm" variant="outline" className="shrink-0" disabled={busy || loading} onClick={() => select(null)}>
					<Plus className="size-4" />{t('agentSection.add')}
				</Button>
			</div>
			{loading && !agents.length ? <p className="mt-8 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('common.loading')}</p>
				: loadError && !agents.length ? <div role="alert" className="mt-8 space-y-3 text-sm text-destructive">
					<p>{t('agentSection.loadFailed')}</p><Button type="button" variant="outline" onClick={() => void refetch()}>{t('error.retry')}</Button>
				</div> : <div className="mt-8 grid items-start gap-8 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
					<div role="group" aria-label={t('agentSection.select')} className="flex flex-col gap-1">
						{agents.length > 0 ? agents.map(agent => <button key={agent.id} type="button" disabled={busy} aria-pressed={agent.id === agentId} onClick={() => select(agent.id)}
							className={`flex min-w-0 items-center gap-2.5 rounded-xl px-2.5 py-2 text-start transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 ${agent.id === agentId ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'}`}>
							<Avatar aria-hidden className="size-8 shrink-0"><AvatarImage src={agent.data.avatar ?? undefined} alt="" /><AvatarFallback className="text-xs">{Array.from(agent.data.name.trim())[0]?.toLocaleUpperCase()}</AvatarFallback></Avatar>
							<span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{agent.data.name}</span><span className="block truncate text-[11px] text-muted-foreground">{agent.data.chat_model_config?.model || t('agentSection.inheritModel')}</span></span>
							{!agent.editable && <Badge variant="secondary" className="shrink-0 text-[10px]">{t('common.readOnly')}</Badge>}
						</button>) : <p className="px-2.5 py-2 text-sm text-muted-foreground">{t('agentSection.empty')}</p>}
					</div>
					<form className="space-y-6" onSubmit={event => { event.preventDefault(); void handleSave(); }}>
						<input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} aria-label={t('agentSection.uploadAvatar')} disabled={busy || !editable} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(file); }} />
						<div className="flex items-start gap-4">
							<Avatar aria-hidden className="size-16 shrink-0 rounded-2xl"><AvatarImage src={avatar ?? undefined} alt="" /><AvatarFallback className="rounded-2xl text-xl">{Array.from(name.trim())[0]?.toLocaleUpperCase() || 'C'}</AvatarFallback></Avatar>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<label className="text-sm font-medium" htmlFor="agent-role-name">{t('agentSection.name')}<span aria-hidden className="ms-1 text-destructive">*</span></label>
									{current && !current.editable && <Badge variant="secondary" className="shrink-0 text-[10px]">{t('common.readOnly')}</Badge>}
								</div>
								<Input id="agent-role-name" value={name} maxLength={100} disabled={busy || !editable} placeholder={t('agentSection.namePlaceholder')} className="mt-2" autoComplete="off" onChange={event => change({ name: event.target.value })} />
								<div className="mt-2 flex flex-wrap items-center gap-2">
									<Button type="button" variant="outline" size="sm" disabled={busy || !editable} onClick={() => fileInput.current?.click()}>{uploading && <Loader2 className="size-3 animate-spin" />}{t('agentSection.uploadAvatar')}</Button>
									{avatar && <Button type="button" variant="ghost" size="sm" disabled={busy || !editable} onClick={() => change({ avatar: null })}>{t('agentSection.removeAvatar')}</Button>}
								</div>
								<p className="mt-2 text-xs leading-5 text-muted-foreground">{t('agentSection.avatarHint')}</p>
							</div>
						</div>
						<div>
							<label htmlFor="agent-role-personality" className="text-sm font-medium">{t('agentSection.personality')}</label>
							<textarea id="agent-role-personality" value={personality} maxLength={8000} disabled={busy || !editable} placeholder={t('agentSection.personalityPlaceholder')} rows={3} className={fieldClass} onChange={event => change({ personality: event.target.value })} />
						</div>
						<div>
							<label htmlFor="agent-role-instructions" className="text-sm font-medium">{t('agentSection.systemPrompt')}</label>
							<textarea id="agent-role-instructions" value={prompt} maxLength={20000} disabled={busy || !editable} placeholder={t('agentSection.systemPromptPlaceholder')} rows={7} className={fieldClass} onChange={event => change({ system_prompt: event.target.value })} />
						</div>
						<div className="space-y-2">
							<label htmlFor="agent-role-default-model" className="block text-sm font-medium">{t('agentSection.defaultModel')}</label>
							<LlmSelect id="agent-role-default-model" value={model} allowClear clearLabel={t('agentSection.inheritModel')} placeholder={t('agentSection.inheritModel')} includeBuiltin={false} disabled={busy || !editable} className="max-w-full" onChange={next => change({ chat_model_config: next })} onAddCredential={() => { if (!busy && !saveLock.current && editable) { invalidateAgeChallenge(); onAddModel(); } }} />
							<p className="text-xs leading-5 text-muted-foreground">{t('agentSection.defaultModelHint')}</p>
						</div>
						<p className="text-xs leading-5 text-muted-foreground">{t('agentSection.moderationHint')}</p>
						<div className="flex flex-wrap items-center gap-3">
							<Button type="submit" size="sm" disabled={busy || !editable || (!!agentId && !hasChanges)} aria-busy={saving}>{saving && <Loader2 className="size-3 animate-spin" />}{t(agentId ? 'agentSection.save' : 'agentSection.create')}</Button>
							<span role="status" aria-live="polite" className="text-xs text-muted-foreground">{saving ? (reviewing?.needsReview ? t('agentSection.checking') : '') : saved ? t('agentSection.saved') : ''}</span>
							{error && <span role="alert" className="text-xs text-destructive">{error}</span>}
						</div>
					</form>
				</div>}
			<Dialog open={pendingAge !== null} onOpenChange={open => { if (!open) dismissAgeChallenge(pendingAge); }}>
				<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
					<DialogHeader>
						<DialogTitle className="pe-7 leading-snug">{t('agentSection.ageTitle')}</DialogTitle>
						<DialogDescription>{t('agentSection.ageDescription')}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="outline" disabled={busy} onClick={() => { if (pendingAge) confirmAge(pendingAge, false); }}>{t('agentSection.ageMinor')}</Button>
						<Button type="button" disabled={busy} onClick={() => { if (pendingAge) confirmAge(pendingAge, true); }}>{t('agentSection.ageAdult')}</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</section>
	);
}

// ==================== 设置主窗口 ====================

/**
 * 行为设置面板专用的数字输入：
 * - 失焦或回车时回调 onCommit（值被合法化后），输入中不打扰父级
 * - 范围限定 + 四舍五入，避免误输入小数或负数
 * - 右侧 `suffix` 是单位提示（不参与数值）
 */
function NumberField({
	value,
	min,
	max,
	step = 1,
	suffix,
	disabled,
	onCommit
}: {
	value: number;
	min: number;
	max: number;
	step?: number;
	suffix?: string;
	disabled?: boolean;
	onCommit: (next: number) => void;
}) {
	const [draft, setDraft] = useState<string>(String(value));
	// 父级 value 变化时（如后端 PATCH 成功回填）同步刷新输入框
	useEffect(() => { setDraft(String(value)); }, [value]);
	const commit = () => {
		const n = Number(draft);
		if (!Number.isFinite(n)) { setDraft(String(value)); return; }
		const clamped = Math.max(min, Math.min(max, Math.round(n / step) * step));
		if (clamped !== value) onCommit(clamped);
		else setDraft(String(clamped));
	};
	return (
		<div className="inline-flex items-center gap-2">
			<Input
				type="number"
				inputMode="numeric"
				className="w-32"
				min={min}
				max={max}
				step={step}
				disabled={disabled}
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
			/>
			{suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
		</div>
	);
}

// ==================== 高级板块（钩子 / 轨迹 / 索引 / 语言服务） ====================

/** `/admin/runtime` 里与"高级"相关的字段。 */
interface LspServerConfig {
	command: string;
	args?: string[];
	initializationOptions?: Record<string, unknown>;
}

interface McpServerConfig {
	command?: string;
	url?: string;
	args?: string[];
	env?: Record<string, string>;
	enabled?: boolean;
}

interface McpServerStatus {
	name: string;
	command: string;
	args: string[];
	status: 'ok' | 'error' | 'disabled';
	tools?: string[];
	error?: string;
	stderrTail?: string | null;
}

interface AdvancedRuntime {
	hooksEnabled?: boolean;
	traceEnabled?: boolean;
	traceFullBody?: boolean;
	changesAware?: boolean;
	lspServers?: Record<string, LspServerConfig>;
	mcpServers?: Record<string, McpServerConfig>;
}

interface LspEntry {
	ext: string;
	command: string;
	args: string[];
	label: string;
	path: string;
	/**
	 * Server-specific init params. For typescript-language-server this carries
	 * `tsserver.path` — without it the server looks for typescript inside the
	 * opened project and exits when it isn't there (which is the common case).
	 * The backend probes for a usable tsserver and fills this in.
	 */
	initializationOptions?: Record<string, unknown>;
}

interface LspProbe {
	installed: LspEntry[];
	configured: Record<string, LspServerConfig>;
}

interface IndexStats {
	cwd: string;
	semantic: { indexed: boolean; files?: number; tokens?: number };
	symbols: { files?: number; count?: number };
}

/**
 * 高级板块：钩子开关、轨迹开关、代码索引、语言服务、项目钩子信任。
 *
 * 自包含（自己 fetch / 自己 save），不并入上面那套 `runtime` state ——
 * 那套只认三个数字字段，硬塞进来会让它的类型和保存路径都变形。
 * 代价是打开设置页时多几次 GET，可接受。
 *
 * @returns 高级板块的行列表（无标题，标题由调用方渲染）。
 */
function AdvancedSection() {
	const { t } = useTranslation();
	const [rt, setRt] = useState<AdvancedRuntime | null>(null);
	const [lsp, setLsp] = useState<LspProbe | null>(null);
	const [idx, setIdx] = useState<IndexStats | null>(null);
	// 最近工作目录 —— 索引重建与项目钩子信任都需要一个具体目录，
	// 而设置页不属于任何会话，只能用"最近用过的那个"。
	const [recentCwd, setRecentCwd] = useState<string | null>(null);
	const [trusted, setTrusted] = useState<boolean | null>(null);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);
	// 探测失败 ≠ 没有。连不上后端时如果显示"未检测到已安装的 language server"，
	// 用户会去装 server，而真正该做的是检查连接 —— 两句话必须分开。
	const [loadErr, setLoadErr] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			const failed: string[] = [];
			const get = async (p: string) => {
				try {
					const r = await fetch(apiUrl(p));
					if (!r.ok) throw new Error(`HTTP ${r.status}`);
					return await r.json();
				} catch (e) {
					failed.push(`${p}（${e instanceof Error ? e.message : String(e)}）`);
					return null;
				}
			};
			const [a, b, d] = await Promise.all([
				get('/admin/runtime'),
				get('/admin/lsp'),
				// 后端决定"现在该用哪个目录"（最近工作目录 → 最近有目录的会话），
				// 并负责归一化 —— 前端拼接很容易在 /var 与 /private/var 上翻车。
				get('/admin/current-workspace'),
			]);
			if (cancelled) return;
			setRt(a);
			setLsp(b);
			const cwd: string | null = (d as { cwd?: string | null } | null)?.cwd ?? null;
			setRecentCwd(cwd);
			// 索引统计与钩子状态都需要一个具体目录。不带 cwd 去问 /admin/index 会
			// 得到 422（"没有工作目录"）—— 那是预期答案，不是"读取失败"，所以这两
			// 个请求排在拿到 cwd 之后，且没有 cwd 时干脆不问。
			if (cwd) {
				const [c, hk] = await Promise.all([
					get(`/admin/index?cwd=${encodeURIComponent(cwd)}`),
					get(`/hooks?cwd=${encodeURIComponent(cwd)}`),
				]);
				if (cancelled) return;
				setIdx(c);
				setTrusted(Boolean(hk?.projectHooksTrusted));
			}
			if (!cancelled && failed.length) setLoadErr(failed.join('；'));
		})();
		return () => { cancelled = true; };
	}, []);

	async function save(patch: Partial<AdvancedRuntime>) {
		setBusy(true);
		setErr(null);
		try {
			const r = await fetch(apiUrl('/admin/runtime'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(patch),
			});
			if (!r.ok) throw new Error(await r.text().catch(() => String(r.status)));
			setRt(await r.json());
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	async function rebuildIndex() {
		if (!recentCwd) {
			setNote(t('settings.advanced.index.noWorkspace'));
			return;
		}
		setBusy(true);
		setNote(null);
		setErr(null);
		try {
			const r = await fetch(apiUrl('/admin/index'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ cwd: recentCwd, force: true }),
			});
			if (!r.ok) throw new Error(await r.text().catch(() => String(r.status)));
			const built = await r.json();
			setNote(
				t('settings.advanced.index.done', {
					files: built.symbols?.files ?? 0,
					symbols: built.symbols?.count ?? 0,
					tokens: built.semantic?.tokens ?? 0,
				}),
			);
			const again = await fetch(apiUrl(`/admin/index?cwd=${encodeURIComponent(recentCwd)}`));
			if (again.ok) setIdx(await again.json());
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	async function setTrust(next: boolean) {
		if (!recentCwd) return;
		setBusy(true);
		setErr(null);
		try {
			const r = await fetch(apiUrl('/hooks/trust'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ cwd: recentCwd, trust: next }),
			});
			if (!r.ok) throw new Error(await r.text().catch(() => String(r.status)));
			const body = await r.json();
			setTrusted(Boolean(body.trusted));
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	// ---- MCP 服务器 ----
	const [mcpProbe, setMcpProbe] = useState<McpServerStatus[] | null>(null);
	const [mcpProbing, setMcpProbing] = useState(false);
	const [mcpName, setMcpName] = useState('');
	const [mcpCommand, setMcpCommand] = useState('');
	const [mcpArgs, setMcpArgs] = useState('');

	const probeMcp = useCallback(async () => {
		setMcpProbing(true);
		try {
			const r = await fetch(apiUrl('/mcp/servers'));
			if (!r.ok) throw new Error(await r.text().catch(() => String(r.status)));
			const body = await r.json();
			setMcpProbe(body.servers ?? []);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setMcpProbing(false);
		}
	}, []);

	const saveMcp = async (next: Record<string, McpServerConfig>) => {
		await save({ mcpServers: next });
		void probeMcp();
	};

	const addMcp = async () => {
		const name = mcpName.trim();
		const command = mcpCommand.trim();
		if (!name || !command) return;
		const args = mcpArgs.trim().split(/\s+/).filter(Boolean);
		const next = { ...(rt?.mcpServers ?? {}), [name]: { command, args } };
		setMcpName('');
		setMcpCommand('');
		setMcpArgs('');
		await saveMcp(next);
	};

	const removeMcp = async (name: string) => {
		const next = { ...(rt?.mcpServers ?? {}) };
		delete next[name];
		await saveMcp(next);
	};

	/** 把探测到的 server 写进 lspServers；写绝对路径（它可能不在 PATH 上）。 */
	function enableLsp(entry: LspEntry) {
		const server: LspServerConfig = { command: entry.path, args: entry.args ?? [] };
		if (entry.initializationOptions) server.initializationOptions = entry.initializationOptions;
		const next: Record<string, LspServerConfig> = { ...(rt?.lspServers ?? {}), [entry.ext]: server };
		return save({ lspServers: next });
	}

	function disableLsp(ext: string) {
		const next = { ...(rt?.lspServers ?? {}) };
		delete next[ext];
		return save({ lspServers: next });
	}

	const configuredExts = Object.keys(rt?.lspServers ?? {});
	const symbolCount = idx?.symbols?.count ?? 0;
	const symbolFiles = idx?.symbols?.files ?? 0;

	return (
		<>
			{loadErr && (
				<div className="rounded-md border border-destructive bg-destructive-soft px-3 py-2 text-xs text-destructive">
					{t('settings.loadFailed', { error: loadErr })}
				</div>
			)}
			{err && (
				<div className="rounded-md border border-destructive bg-destructive-soft px-3 py-2 text-xs text-destructive">
					{err}
				</div>
			)}
			{note && (
				<div className="rounded-md border border-border bg-muted px-3 py-2 text-xs">{note}</div>
			)}

			<Row title={t('settings.advanced.hooks.title')} description={t('settings.advanced.hooks.desc')}>
				<Switch
					size="sm"
					checked={rt?.hooksEnabled !== false}
					disabled={busy || rt === null}
					onCheckedChange={(v) => void save({ hooksEnabled: v })}
				/>
			</Row>

			<Row title={t('settings.advanced.trace.title')} description={t('settings.advanced.trace.desc')}>
				<Switch
					size="sm"
					checked={rt?.traceEnabled !== false}
					disabled={busy || rt === null}
					onCheckedChange={(v) => void save({ traceEnabled: v })}
				/>
			</Row>

			<Row title={t('settings.advanced.traceFull.title')} description={t('settings.advanced.traceFull.desc')}>
				<Switch
					size="sm"
					checked={rt?.traceFullBody === true}
					disabled={busy || rt === null || rt?.traceEnabled === false}
					onCheckedChange={(v) => void save({ traceFullBody: v })}
				/>
			</Row>

			<Row title={t('settings.advanced.changes.title')} description={t('settings.advanced.changes.desc')}>
				<Switch
					size="sm"
					checked={rt?.changesAware !== false}
					disabled={busy || rt === null}
					onCheckedChange={(v) => void save({ changesAware: v })}
				/>
			</Row>

			{/* ---- 语言服务 ---- */}
			<Row title={t('settings.advanced.lsp.title')} description={t('settings.advanced.lsp.desc')}>
				<span className="text-xs text-muted-foreground">
					{configuredExts.length ? configuredExts.join(' · ') : '—'}
				</span>
			</Row>
			<div className="rounded-xl border border-border bg-card px-5 py-3">
				{lsp === null ? (
					<div className="text-xs text-muted-foreground">{t('settings.advanced.lsp.probeFailed', { error: '—' })}</div>
				) : (lsp.installed ?? []).length === 0 ? (
					<div className="text-xs text-muted-foreground">{t('settings.advanced.lsp.none')}</div>
				) : (
					<div className="space-y-2">
						{(lsp?.installed ?? []).map((entry) => {
							const on = configuredExts.includes(entry.ext);
							return (
								<div key={`${entry.ext}-${entry.command}`} className="flex items-center gap-3">
									<div className="min-w-0">
										<div className="text-xs font-medium">
											{entry.label} <span className="text-muted-foreground">{entry.ext}</span>
										</div>
										<div className="truncate font-mono text-[11px] text-muted-foreground">{entry.path}</div>
									</div>
									<Button
										type="button"
										variant={on ? 'ghost' : 'outline'}
										size="sm"
										className="ml-auto shrink-0"
										disabled={busy || rt === null}
										onClick={() => (on ? void disableLsp(entry.ext) : void enableLsp(entry))}
									>
										{on ? t('settings.advanced.lsp.disable') : t('settings.advanced.lsp.enable')}
									</Button>
								</div>
							);
						})}
					</div>
				)}
			</div>

			{/* ---- 索引 ---- */}
			<Row
				title={t('settings.advanced.index.title')}
				description={t('settings.advanced.index.desc')}
			>
				<div className="flex items-center gap-3">
					<span className="text-xs text-muted-foreground">
						{idx
							? t('settings.advanced.index.stats', { files: symbolFiles, symbols: symbolCount })
							: '—'}
					</span>
					<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void rebuildIndex()}>
						{busy ? <Loader2 className="size-3 animate-spin" /> : null}
						{t('settings.advanced.index.rebuild')}
					</Button>
				</div>
			</Row>

			{/* ---- 项目钩子信任 ---- */}
			<Row title={t('settings.advanced.trust.title')} description={t('settings.advanced.trust.desc')}>
				{recentCwd === null ? (
					<span className="text-xs text-muted-foreground">{t('settings.advanced.trust.none')}</span>
				) : (
					<div className="flex items-center gap-3">
						<span className="max-w-[16rem] truncate font-mono text-[11px] text-muted-foreground">
							{recentCwd}
						</span>
						<Button
							type="button"
							variant={trusted ? 'ghost' : 'outline'}
							size="sm"
							disabled={busy}
							onClick={() => void setTrust(!trusted)}
						>
							{trusted ? t('settings.advanced.trust.revoke') : t('settings.advanced.trust.trust')}
						</Button>
					</div>
				)}
			</Row>

			{/* ---- MCP 服务器 ---- */}
			<Row title={t('settings.advanced.mcp.title')} description={t('settings.advanced.mcp.desc')}>
				<div className="flex items-center gap-2">
					<Button type="button" variant="outline" size="sm" disabled={mcpProbing} onClick={() => void probeMcp()}>
						{mcpProbing ? t('settings.advanced.mcp.probing') : t('settings.advanced.mcp.probe')}
					</Button>
				</div>
			</Row>
			{(rt?.mcpServers && Object.keys(rt.mcpServers).length > 0) || (mcpProbe && mcpProbe.length > 0) ? (
				<ul className="flex flex-col gap-y-1.5">
					{Object.entries(rt?.mcpServers ?? {}).map(([name, def]) => {
						const st = mcpProbe?.find((p) => p.name === name);
						const endpoint = def.url ?? [def.command, ...(def.args ?? [])].filter(Boolean).join(' ');
						return (
							<li key={name} className="group flex items-center gap-x-2 rounded-md border px-2 py-1.5 text-xs">
								<span className="shrink-0 font-medium">{name}</span>
								<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={endpoint}>
									{endpoint}
								</span>
								{def.enabled === false || st?.status === 'disabled' ? (
									<Badge variant="secondary" className="shrink-0">{t('desktopPlugins.disabled')}</Badge>
								) : st?.status === 'ok' ? (
									<Badge variant="secondary" className="shrink-0">
										{t('settings.advanced.mcp.toolsCount', { count: st.tools?.length ?? 0 })}
									</Badge>
								) : st?.status === 'error' ? (
									<span className="shrink-0 text-destructive" title={st.error}>
										<TriangleAlert className="size-3.5" />
									</span>
								) : null}
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label={t('settings.advanced.mcp.delete')}
									className="ml-auto shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
									onClick={() => void removeMcp(name)}
								>
									<Trash2 />
								</Button>
							</li>
						);
					})}
				</ul>
			) : (
				<p className="px-1 text-xs text-muted-foreground">{t('settings.advanced.mcp.noServers')}</p>
			)}
			<div className="flex flex-wrap items-center gap-2">
				<Input
					value={mcpName}
					onChange={(e) => setMcpName(e.target.value)}
					placeholder={t('settings.advanced.mcp.namePlaceholder')}
					className="h-8 w-32 font-mono text-xs"
					spellCheck={false}
				/>
				<Input
					value={mcpCommand}
					onChange={(e) => setMcpCommand(e.target.value)}
					placeholder={t('settings.advanced.mcp.commandPlaceholder')}
					className="h-8 w-52 font-mono text-xs"
					spellCheck={false}
				/>
				<Input
					value={mcpArgs}
					onChange={(e) => setMcpArgs(e.target.value)}
					placeholder={t('settings.advanced.mcp.argsPlaceholder')}
					className="h-8 w-52 font-mono text-xs"
					spellCheck={false}
				/>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={!mcpName.trim() || !mcpCommand.trim() || busy}
					onClick={() => void addMcp()}
				>
					{t('settings.advanced.mcp.add')}
				</Button>
			</div>
		</>
	);
}

export function SettingsDialog({ open, onOpenChange, initialTab = 'general', onImportSessions, returnFocusRef }: Props) {
	const { t } = useTranslation();
	const restoreFocus = useRef(document.activeElement as HTMLElement | null);
	const [section, setSection] = useState<Section>(() => normalizeSettingsSection(initialTab));
	const [agentDraft, setAgentDraft] = useState<AgentRoleDraft | null>(null);

	const [languageOpen, setLanguageOpen] = useState(false);
	const currentLanguage = LANGUAGE_OPTIONS.find(option => option.value === normalizeLanguage(i18n.language));
	const [confirmWipe, setConfirmWipe] = useState(false);
	const [wiping, setWiping] = useState(false);
	const [wipeError, setWipeError] = useState<string | null>(null);
	// Agent 运行行为（上下文压缩预算 + 工具输出限制 + 最大迭代轮数）。
	// 与主题一样：保存时 PATCH /admin/runtime，磁盘持久化到 ~/.vega/config.json。
	const [runtime, setRuntime] = useState<RuntimeBehavior | null>(null);
	const [runtimeBusy, setRuntimeBusy] = useState(false);
	const [runtimeErr, setRuntimeErr] = useState<string | null>(null);
	const [checkingUpdate, setCheckingUpdate] = useState(false);
	const [updateMessage, setUpdateMessage] = useState<string | null>(null);
	const { preference: themePref, setPreference: setThemePref } = useTheme();

	// Open of an unrelated dialog would keep the user's last-chosen
	// preference across renders, but the section resets already done
	// below cover the rest of the dialog state. Theme is read on every
	// render so the segmented control always shows the live value — in
	// particular when another tab changed it via the storage event the
	// `useTheme` hook picks that up on its own.

	// 打开时重置到初始板块（外部可用 key 重挂载强制指定）
	useEffect(() => {
		if (!open) { setAgentDraft(null); return; }
		setSection(normalizeSettingsSection(initialTab));
		setLanguageOpen(false);
		setConfirmWipe(false);
		setWipeError(null);
		setUpdateMessage(null);
	}, [open, initialTab]);

	async function handleCheckForUpdates() {
		const bridge = getUpdateBridge();
		if (!bridge) {
			setUpdateMessage(t('settings.about.update.desktopOnly'));
			return;
		}
		setCheckingUpdate(true);
		setUpdateMessage(null);
		try {
			const result = await bridge.checkForUpdates();
			if (result.status === 'available') {
				setUpdateMessage(t('settings.about.update.available', { version: result.version || '' }));
			} else if (result.status === 'downloading') {
				setUpdateMessage(t('settings.about.update.downloading', { version: result.version || '' }));
			} else if (result.status === 'up-to-date') {
				setUpdateMessage(t('settings.about.update.upToDate'));
			} else if (result.status === 'development') {
				setUpdateMessage(t('settings.about.update.development'));
			} else if (result.status === 'unavailable') {
				setUpdateMessage(t('settings.about.update.unavailable'));
			} else {
				setUpdateMessage(t('settings.about.update.failed', { error: result.message || 'Unknown error' }));
			}
		} catch (error) {
			setUpdateMessage(t('settings.about.update.failed', { error: error instanceof Error ? error.message : String(error) }));
		} finally {
			setCheckingUpdate(false);
		}
	}

	// 关闭动画时机接管：open→false 不立即卸载，保持 DOM 200ms 播完
	// 退出过渡；open→true 立即恢复渲染。mounted 决定「DOM 是否存在」，
	// closing = mounted && !open 驱动退出动画类。
	const [mounted, setMounted] = useState(open);
	useEffect(() => {
		if (open) {
			setMounted(true);
			return;
		}
		const timer = setTimeout(() => setMounted(false), 200);
		return () => clearTimeout(timer);
	}, [open]);

	// 首次打开 + 切到开发者板块：拉一次运行时配置（关闭时不再请求，避免空闲轮询）
	const runtimeKey = open && section === 'developer' ? 'ready' : 'idle';
	useEffect(() => {
		if (runtimeKey !== 'ready') return;
		let cancelled = false;
		(async () => {
			try {
				const r = await fetch(apiUrl('/admin/runtime'));
				if (!r.ok) throw new Error(t('settings.errors.backend', { status: r.status }));
				const data = await r.json();
				if (cancelled) return;
				setRuntime(data);
				setRuntimeErr(null);
			} catch (e) {
				if (cancelled) return;
				setRuntimeErr(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => { cancelled = true; };
	}, [runtimeKey]);

	async function handleRuntimeSave(patch: Partial<RuntimeBehavior>) {
		setRuntimeBusy(true);
		setRuntimeErr(null);
		try {
			const r = await fetch(apiUrl('/admin/runtime'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(patch)
			});
			if (!r.ok) {
				const responseText = await r.text().catch(() => '');
				throw new Error(t('settings.errors.runtimeSave', { status: r.status, text: responseText || r.statusText }));
			}
			const next = await r.json();
			setRuntime(next);
		} catch (e) {
			setRuntimeErr(e instanceof Error ? e.message : String(e));
		} finally {
			setRuntimeBusy(false);
		}
	}

	function isRuntimePreset(preset: RuntimeBehavior) {
		return runtime !== null &&
			runtime.maxTokensBudget === preset.maxTokensBudget &&
			runtime.toolOutputLimit === preset.toolOutputLimit &&
			runtime.maxTurns === preset.maxTurns;
	}

	async function handleWipe() {
		setWiping(true);
		setWipeError(null);
		try {
			// CoCode 扩展端点：服务端清空 sessions + credentials + agents
			const res = await fetch(apiUrl('/admin/reset'), { method: 'POST' });
			if (!res.ok) throw new Error(t('settings.errors.backend', { status: res.status }));
			setTimeout(() => window.location.reload(), 400);
		} catch (e) {
			setWipeError(e instanceof Error ? e.message : String(e));
			setConfirmWipe(false);
		} finally {
			setWiping(false);
		}
	}

	if (!mounted) return null;

	// closing：DOM 仍在（mounted）但 open 已切 false —— 播退出动画的窗口期。
	const closing = mounted && !open;

	return (
		<SettingsPrimitive.Root open={open} onOpenChange={onOpenChange}>
		<SettingsPrimitive.Portal forceMount>
		<SettingsPrimitive.Content forceMount asChild aria-describedby={undefined} onCloseAutoFocus={event=>{
			event.preventDefault();
			if(document.querySelector('[role="dialog"][data-state="open"]'))return;
			(returnFocusRef?.current??restoreFocus.current)?.focus({preventScroll:true});
		}}>
		<div
			aria-hidden={closing}
			className={
				'fixed inset-0 z-50 bg-background text-card-foreground ' +
				(closing
					? 'animate-out fade-out-0 duration-200'
					: 'animate-in fade-in-0 duration-200')
			}
		>
			<SettingsPrimitive.Title className="sr-only">{t('settings.title')}</SettingsPrimitive.Title>
			{/* 全屏设置：左侧导航保持上下文，右侧为集中阅读区。 */}
			<div
				className={
					'relative flex h-full w-full overflow-hidden bg-background text-card-foreground ease-out ' +
					(closing
						? 'animate-out fade-out-0 duration-200'
						: 'animate-in fade-in-0 duration-200')
				}
			>
				{/* 左侧导航 */}
				<nav className="app-no-drag flex w-72 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 pb-4 pt-14">
					<button
						type="button"
						className="app-no-drag mb-5 flex items-center gap-2 rounded-rect px-2 py-2 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
						onClick={() => onOpenChange(false)}
					>
						<ChevronLeft className="size-4" />
						{t('settings.backToApp')}
					</button>
					<div className="px-2 pb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">{t('settings.title')}</div>
					<div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
					{SECTIONS.filter(section => section.key !== 'plugins' || getDesktopPluginBridge()).map(({ key, label, icon: Icon }) => (
						<button
							key={key}
							type="button"
							className={
								'flex items-center gap-2.5 rounded-rect px-3 py-2 text-sm transition-colors duration-150 ' +
								(section === key
									? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
									: 'text-sidebar-foreground hover:bg-sidebar-accent')
							}
							onClick={() => setSection(key)}
						>
							<Icon className="size-4" />
							{t(label)}
						</button>
					))}
					</div>
				</nav>

				{/* 右侧内容 */}
				<div className="relative flex min-w-0 flex-1 flex-col">
					{/* key={section} 让板块切换时重挂载触发入场动画 */}
					<div key={section} className="min-h-0 flex-1 overflow-y-auto animate-in fade-in slide-in-from-bottom-1 duration-250">
						<div className="mx-auto w-full max-w-4xl has-[[data-model-form]]:max-w-none px-8 py-14 sm:px-12 lg:py-16">
						{section === 'general' && (
							<>
								<h3 className="text-lg font-semibold">{t('settings.general.title')}</h3>
								<div className="mt-2 text-xs text-muted-foreground">{t('settings.general.common')}</div>
<div className="mt-3 space-y-3">
							<Row title={t('settings.theme.modeTitle')} description={t('settings.theme.modeDesc')}>
								<div className="inline-flex items-center rounded-lg border bg-muted p-0.5">
									{([
										{ value: 'light', icon: Sun, label: 'settings.theme.light' },
										{ value: 'dark', icon: Moon, label: 'settings.theme.dark' },
										{ value: 'system', icon: LaptopMinimal, label: 'settings.theme.system' },
									] as Array<{ value: ThemePreference; icon: typeof Sun; label: string }>).map(
										({ value, icon: Icon, label }) => {
											const active = themePref === value;
											return (
												<button
													key={value}
													type="button"
													aria-pressed={active}
													onClick={() => setThemePref(value)}
													className={
														'flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition-colors ' +
														(active
															? 'bg-background text-foreground shadow-sm'
															: 'text-muted-foreground hover:text-foreground')
													}
												>
													<Icon className="size-3.5" />
													{t(label)}
												</button>
											);
										},
									)}
								</div>
							</Row>
							<Row title={t('settings.general.language.title')} description={t('settings.general.language.desc')}>
								<Button type="button" variant="outline" onClick={() => setLanguageOpen(true)} aria-label={t('languageDialog.title')}>
									{currentLanguage?.nativeName ?? t('languageDialog.title')}
								</Button>
									</Row>
									<SoundSection />
								</div>

								</>
						)}

						{section === 'usage' && (
							<>
								<h3 className="text-lg font-semibold">{t('settings.usage.title')}</h3>
								<div className="mt-1 text-xs text-muted-foreground">{t('settings.usage.desc')}</div>
								<div className="mt-5">
									<UsageSection />
								</div>
							</>
						)}

						{section === 'account' && (
							<>
								<h3 className="text-lg font-semibold">{t('settings.account.title')}</h3>
								<div className="mt-5">
									<AccountSection />
								</div>
							</>
						)}

						{section === 'model' && <ModelSection />}
						{open && section === 'plugins' && <DesktopPluginSection onClose={() => onOpenChange(false)} />}

					{open && section === 'agent' && <AgentSection draft={agentDraft} onDraftChange={setAgentDraft} onAddModel={() => setSection('model')} />}

						{section === 'memory' && (
							<>
								<h3 className="text-lg font-semibold">{t('settings.memory.title')}</h3>
								<div className="mt-1 text-xs text-muted-foreground">{t('settings.memory.desc')}</div>
								<div className="mt-5">
									<MemorySection />
								</div>
							</>
						)}

						{section === 'data' && (
							<>
								<h3 className="text-lg font-semibold">{t('settings.data.title')}</h3>
								<div className="mt-2 text-xs text-muted-foreground">{t('settings.data.subtitle')}</div>
								<div className="mt-3 space-y-3">
									{onImportSessions&&<Row title={t('sessionImport.title')} description={t('sessionImport.description')}>
										<Button type="button" variant="outline" size="sm" data-testid="open-session-import" onClick={onImportSessions}>{t('sessionImport.title')}</Button>
									</Row>}
									<Row title={t('settings.data.wipe.title')} description={t('settings.data.wipe.desc')}>
										{!confirmWipe ? (
											<Button
												type="button"
												variant="outline"
												size="sm"
												className="text-destructive hover:bg-destructive-soft"
												onClick={() => setConfirmWipe(true)}
											>
												<Trash2 className="size-3.5" />
												{t('settings.data.wipe.button')}
											</Button>
										) : (
											<div className="flex items-center gap-2">
												<Button type="button" variant="destructive" size="sm" disabled={wiping} onClick={handleWipe}>
													{wiping && <Loader2 className="size-3 animate-spin" />}
													{wiping ? t('settings.data.wipe.processing') : t('settings.data.wipe.confirm')}
												</Button>
												<Button type="button" variant="ghost" size="sm" onClick={() => setConfirmWipe(false)}>
													{t('settings.data.wipe.cancel')}
												</Button>
											</div>
										)}
									</Row>
									{wipeError && (
										<div className="rounded-md bg-destructive-soft px-3 py-2 text-xs text-destructive">
											{t('settings.data.wipe.error', { error: wipeError })}
										</div>
									)}
								</div>
							</>
						)}

						{section === 'about' && (
							<>
								<h3 className="text-lg font-semibold">{t('settings.about.title')}</h3>
								<div className="mt-3 space-y-3">
									<Row title="Tora" description={t('settings.about.tora', { version: getUpdateBridge()?.getAppVersion?.() || '—' })} />
									<Row title={t('settings.about.runtimeTitle')} description={t('settings.about.runtime')} />
									<Row title={t('settings.about.update.title')} description={t('settings.about.update.desc')}>
										<Button variant="outline" size="sm" onClick={handleCheckForUpdates} disabled={checkingUpdate}>
											{checkingUpdate && <Loader2 className="animate-spin" />}
											{checkingUpdate ? t('settings.about.update.checking') : t('settings.about.update.check')}
										</Button>
									</Row>
									{updateMessage && <div className="px-1 text-xs text-muted-foreground">{updateMessage}</div>}
								</div>
							</>
						)}

						{section === 'developer' && (
							<>
								<h3 className="text-lg font-semibold">{t('settings.advanced.title')}</h3>
								<div className="mt-1 text-xs text-muted-foreground">{t('settings.advanced.subtitle')}</div>

								{/* 行为：上下文压缩 / 工具输出 / 最大迭代轮数 */}
								<div className="mt-6 text-xs text-muted-foreground">{t('settings.general.behavior')}</div>
								<div className="mt-3 space-y-3">
									{runtimeErr && (
										<div className="rounded-md border border-destructive bg-destructive-soft px-3 py-2 text-xs text-destructive">
											{runtimeErr}
										</div>
									)}
									{runtime === null ? (
										<div className="text-xs text-muted-foreground">{t('settings.loadingRuntime')}</div>
									) : (
										<>
											<div>
												<div className="text-sm font-medium">{t('settings.behavior.presets.title')}</div>
												<p className="mt-0.5 text-xs text-muted-foreground">{t('settings.behavior.presets.desc')}</p>
												<div className="mt-2 grid grid-cols-3 gap-2">
													{RUNTIME_PRESETS.map((preset) => {
														const active = isRuntimePreset(preset.values);
														return (
															<Button
																key={preset.id}
																type="button"
																variant={active ? 'default' : 'outline'}
																className="h-auto min-h-16 flex-col items-start gap-0.5 px-3 py-2 text-left"
																disabled={runtimeBusy}
																aria-pressed={active}
																onClick={() => void handleRuntimeSave(preset.values)}
															>
																<span className="text-xs font-medium">{t(`settings.behavior.presets.${preset.id}.title`)}</span>
																<span className="text-[11px] leading-snug opacity-70">{t(`settings.behavior.presets.${preset.id}.desc`)}</span>
															</Button>
														);
													})}
												</div>
											</div>
											<Row
												title={t('settings.behavior.context.title')}
												description={t('settings.behavior.context.desc')}
											>
												<NumberField
													value={runtime.maxTokensBudget}
													min={2000}
													max={200000}
													step={1000}
													suffix={t('settings.behavior.context.suffix')}
													disabled={runtimeBusy}
													onCommit={(n) => handleRuntimeSave({ maxTokensBudget: n })}
												/>
											</Row>
											<Row
												title={t('settings.behavior.toolOutput.title')}
												description={t('settings.behavior.toolOutput.desc')}
											>
												<NumberField
													value={runtime.toolOutputLimit}
													min={200}
													max={50000}
													step={500}
													suffix={t('settings.behavior.toolOutput.suffix')}
													disabled={runtimeBusy}
													onCommit={(n) => handleRuntimeSave({ toolOutputLimit: n })}
												/>
											</Row>
											<Row
												title={t('settings.behavior.maxTurns.title')}
												description={t('settings.behavior.maxTurns.desc')}
											>
												<NumberField
													value={runtime.maxTurns}
													min={1}
													max={200}
													step={1}
													suffix={t('settings.behavior.maxTurns.suffix')}
													disabled={runtimeBusy}
													onCommit={(n) => handleRuntimeSave({ maxTurns: n })}
												/>
											</Row>
										</>
									)}
								</div>

								{/* 高级：钩子 / 轨迹 / 索引 / 语言服务 / 项目钩子信任 */}
								<div className="mt-6 text-xs text-muted-foreground">{t('settings.advanced.subtitle')}</div>
								<div className="mt-3 space-y-3">
									<AdvancedSection />
								</div>
							</>
						)}
						</div>
					</div>
				</div>
			</div>
		</div>
		</SettingsPrimitive.Content>
		</SettingsPrimitive.Portal>
		{open && languageOpen && <LanguageDialog onClose={() => setLanguageOpen(false)} />}
		</SettingsPrimitive.Root>
	);
}
