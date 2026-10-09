// Tora 设置窗口（参考 WorkBuddy 布局：左侧分类导航 + 右侧内容面板）。
// 不暴露后端连接配置——连接由 Electron 壳层/启动参数管理。
// 模型板块为三层结构（参考 WorkBuddy）：
//   列表（表格：模型/服务商/操作） → 添加模型弹窗（服务商网格） → 通过服务商添加表单

import {
  AudioWaveform, BotMessageSquare, Box, Brain, ChartColumn, ChevronLeft, ChevronRight, CircleDot, Cloud, CloudDrizzle,
  Cpu, Database, ExternalLink, Flame, Gauge, Import, Info, Layers, Loader2, Moon,
  Palette, Pencil, Plus, Repeat, Settings2, Shuffle, Smartphone, SquareTerminal, Trash2, UserRound, Waves, X, Zap
} from 'lucide-react';
import { Dialog as SettingsPrimitive } from 'radix-ui';
import { useEffect, useMemo, useRef, useState } from 'react';

import { agentApi, type AgentView } from '@/api';
import { AccountSection } from '@/components/dialog/AccountSection';
import { CatgirlPersonaSection } from '@/components/dialog/CatgirlPersonaSection';
import { LanguageFlag } from '@/components/dialog/LanguageFlag';
import { MemorySection } from '@/components/dialog/MemorySection';
import {QuotaSection} from '@/components/dialog/QuotaSection';
import { ThemeSection } from '@/components/dialog/ThemeSection';
import { ToChatModelSource } from '@/components/dialog/ToChatModelSource';
import { UsageSection } from '@/components/dialog/UsageSection';
import { WindowDragRegion } from '@/components/layout/WindowDragRegion';
import { Button } from '@/components/ui/button';
import { DropdownSelect } from '@/components/ui/dropdown-select';
import { Switch } from '@/components/ui/switch';
import { ReleaseNotesDialog } from '@/components/updates/ReleaseNotesDialog';
import { AVAILABLE_MODELS_KEY } from '@/hooks/useAvailableModels';
import i18n, { availableLanguageOptions, normalizeLanguage, setAppLanguage } from '@/i18n';
import { useTranslation } from '@/i18n/useI18n';
import { useCatgirlSettings } from '@/lib/catgirl';
import {normalizeSettingsSection,type SettingsSection} from '@/lib/openSettings';
import { PROVIDER_ICONS } from '@/lib/providerIcons';
import { queryClient } from '@/lib/query-client';
import { releaseNotesBridge, type ReleaseNotes } from '@/lib/releaseNotes';
import {
	getSearchEngine,
	isSearchEngineId,
	saveSearchEngine,
	SEARCH_ENGINES,
	type SearchEngineId,
} from '@/lib/searchEngine';
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
import { setSystemMessageNotificationsEnabled, systemMessageNotificationsEnabled } from '@/lib/systemNotifications';
import { getToken } from '@/utils/authStore';
import { cloudFetch, syncLocalModelMirror } from '@/utils/modelSync';

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onImportSessions?: () => void;
	/** 打开时定位到的板块（默认通用）。配合 key 重挂载可强制切换。 */
	initialTab?: Section;
}

const apiBase = () => (localStorage.getItem('server_url') || 'http://127.0.0.1:3210').replace(/\/+$/, '');
const apiUrl = (p: string) => `${apiBase()}${p}`;

type Section = SettingsSection;

type UpdateResult = {
	status: 'available' | 'development' | 'downloading' | 'ready' | 'error' | 'unavailable' | 'up-to-date';
	version?: string;
	message?: string;
};

type UpdateBridge = { checkForUpdates: () => Promise<UpdateResult>; getAppVersion?: () => string };

function getUpdateBridge(): UpdateBridge | null {
	return (window as unknown as { toraWindow?: UpdateBridge }).toraWindow ?? null;
}

const SECTIONS: { key: Section; label: string; icon: typeof Settings2 }[] = [
	{ key: 'account', label: 'settings.sections.account', icon: UserRound },
	{ key: 'general', label: 'settings.sections.general', icon: Settings2 },
	{ key: 'theme', label: 'settings.sections.theme', icon: Palette },
	{ key: 'quota', label: 'quotaSettings.title', icon: Gauge },
	{ key: 'usage', label: 'settings.sections.usage', icon: ChartColumn },
	{ key: 'agent', label: 'settings.sections.agent', icon: BotMessageSquare },
	{ key: 'model', label: 'settings.sections.model', icon: Cpu },
	{ key: 'memory', label: 'settings.sections.memory', icon: Brain },
	{ key: 'data', label: 'settings.sections.data', icon: Database },
	{ key: 'about', label: 'settings.sections.about', icon: Info },
];

// 服务商预设：Anthropic 走原生 Messages API，其余走 OpenAI 兼容接口；keyUrl = 官网密钥页
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
	{ key: 'openai', baseURL: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', icon: BotMessageSquare, color: 'bg-foreground text-background' },
	{ key: 'google', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey', icon: Cloud, color: 'bg-foreground text-background' },
	{ key: 'anthropic', baseURL: 'https://api.anthropic.com/v1', keyUrl: 'https://console.anthropic.com/settings/keys', icon: Brain, color: 'bg-foreground text-background' },
	{ key: 'deepseek', baseURL: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys', icon: Waves, color: 'bg-blue-500 text-white' },
	{ key: 'volcengine', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', keyUrl: 'https://console.volcengine.com/ark', icon: Flame, color: 'bg-indigo-500 text-white' },
	{ key: 'minimax-cn', baseURL: 'https://api.minimax.chat/v1', keyUrl: 'https://platform.minimaxi.com', icon: AudioWaveform, color: 'bg-rose-500 text-white' },
	{ key: 'minimax-global', baseURL: 'https://api.minimax.io/v1', keyUrl: 'https://www.minimax.io', icon: AudioWaveform, color: 'bg-rose-400 text-white' },
	{ key: 'bigmodel', baseURL: 'https://open.bigmodel.cn/api/paas/v4', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', icon: Zap, color: 'bg-sky-500 text-white' },
	{ key: 'dashscope', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyUrl: 'https://bailian.console.aliyun.com', icon: Cloud, color: 'bg-orange-500 text-white' },
	{ key: 'mimo', baseURL: 'https://api.xiaomimimo.com/v1', keyUrl: 'https://www.xiaomimimo.com', icon: Smartphone, color: 'bg-stone-500 text-white' },
	{ key: 'siliconflow', baseURL: 'https://api.siliconflow.cn/v1', keyUrl: 'https://cloud.siliconflow.cn/account/ak', icon: Layers, color: 'bg-violet-500 text-white' },
	{ key: 'stepfun', baseURL: 'https://api.stepfun.com/v1', keyUrl: 'https://platform.stepfun.com/interface-key', icon: Zap, color: 'bg-foreground text-background' },
	{ key: 'stepfun-global', baseURL: 'https://api.stepfun.ai/v1', keyUrl: 'https://platform.stepfun.ai/interface-key', icon: Zap, color: 'bg-foreground text-background' },
	{ key: 'zai', baseURL: 'https://api.z.ai/api/paas/v4', keyUrl: 'https://z.ai', icon: Zap, color: 'bg-zinc-800 text-white' },
	{ key: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys', icon: Shuffle, color: 'bg-blue-600 text-white' },
	{ key: 'apiyi', baseURL: 'https://api.apiyi.com/v1', keyUrl: 'https://api.apiyi.com/token', icon: Layers, color: 'bg-blue-600 text-white' },
	{ key: 'shuliuyun', baseURL: 'https://shuliuyun.com/v1', keyUrl: 'https://shuliuyun.com/console', icon: Layers, color: 'bg-blue-600 text-white' },
	{ key: 'kimi-cn', baseURL: 'https://api.moonshot.cn/v1', keyUrl: 'https://platform.moonshot.cn/console/api-keys', icon: Moon, color: 'bg-neutral-800 text-white' },
	{ key: 'kimi-global', baseURL: 'https://api.moonshot.ai/v1', keyUrl: 'https://platform.moonshot.ai/console/api-keys', icon: Moon, color: 'bg-neutral-700 text-white' },
	{ key: 'byteplus', baseURL: 'https://ark.ap-southeast.bytepluses.com/api/v3', keyUrl: 'https://www.byteplus.com', icon: Repeat, color: 'bg-blue-700 text-white' },
	{ key: 'hunyuan', baseURL: 'https://api.hunyuan.cloud.tencent.com/v1', keyUrl: 'https://console.cloud.tencent.com/hunyuan', icon: CloudDrizzle, color: 'bg-cyan-500 text-white' },
	{ key: 'ppio', baseURL: 'https://api.ppinfra.com/v3/openai', keyUrl: 'https://ppinfra.com', icon: CircleDot, color: 'bg-emerald-500 text-white' },
	{ key: 'ollama', baseURL: 'http://127.0.0.1:11434/v1', needKey: false, icon: SquareTerminal, color: 'bg-stone-700 text-white' },
];

// Brand-name providers are universal in English; the China-specific ones
// (火山引擎 / 阿里云 / etc.) get i18n'd via modelSection.providers.<key>.
// Ollama's "(本地)" suffix is locale-aware.
const BRAND_LABEL_KEYS: Record<string, string | null> = {
	custom: 'modelSection.providers.custom',
	volcengine: 'modelSection.providers.volcengine',
	dashscope: 'modelSection.providers.dashscope',
	siliconflow: 'modelSection.providers.siliconflow',
	shuliuyun: 'modelSection.providers.shuliuyun',
	stepfun: 'modelSection.providers.stepfun',
	'stepfun-global': 'modelSection.providers.stepfunGlobal',
	hunyuan: 'modelSection.providers.hunyuan',
	ollama: 'modelSection.providers.ollama',
	// English-brand providers: no key, fall back to the hardcoded label below
	openai: null,
	google: null,
	anthropic: null,
	deepseek: null,
	'minimax-cn': null,
	'minimax-global': null,
	bigmodel: null,
	mimo: null,
	zai: null,
	openrouter: null,
	apiyi: null,
	'kimi-cn': null,
	'kimi-global': null,
	byteplus: null,
	ppio: null,
};
const BRAND_LABELS: Record<string, string> = {
	openai: 'OpenAI',
	google: 'Google Gemini',
	anthropic: 'Anthropic',
	deepseek: 'DeepSeek',
	'minimax-cn': 'MiniMax CN',
	'minimax-global': 'MiniMax Global',
	bigmodel: 'Bigmodel',
	mimo: 'Xiaomi MIMO',
	zai: 'Z.ai',
	openrouter: 'OpenRouter',
	apiyi: 'APIYI',
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
	/** apiKey 明文（仅云端下发，用于同步本地镜像；展示层不回显） */
	apiKey?: string;
	/** 视觉输入能力：true/false 强制开关；null = 按模型名自动判断 */
	vision?: boolean | null;
}

function ProviderIcon({ p, size = 'size-7', model }: { p: ProviderDef; size?: string; model?: string }) {
	const src = PROVIDER_ICONS[model && /gemini/i.test(model) ? 'gemini' : p.key];
	if (src) {
		// 服务商品牌图：白底圆角方块，黑白配色
		return (
			<span className={`flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-white ${size}`}>
				<img src={src} alt="" className={`${p.key === 'openai' ? 'size-full' : 'size-[72%]'} object-contain`} draggable={false} />
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
		<div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card px-5 py-4">
			<div className="min-w-40 flex-1">
				<div className="text-sm font-medium">{title}</div>
				{description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
			</div>
			<div className="max-w-full shrink-0">{children}</div>
		</div>
	);
}

// ==================== 模型板块（三层） ====================

type ModelView = 'list' | 'picker' | 'form';

export function ModelSection() {
	const { t } = useTranslation();
	// Build provider list with translated labels; the same array is used
	// by the dropdown, the picker grid, and the row-lookup helpers below.
	const PROVIDERS = useMemo(() => buildProviders(t), [t]);
	const GRID_PROVIDERS = useMemo(() => PROVIDERS.filter((p) => p.key !== 'custom'), [PROVIDERS]);
	const getProvider = (key: string) => PROVIDERS.find((p) => p.key === key);
	const [view, setView] = useState<ModelView>('list');
	const [items, setItems] = useState<ModelItem[]>([]);
	const [loading, setLoading] = useState(false);
	const [listErr, setListErr] = useState<string | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const loggedIn = !!getToken();

	// 表单层状态
	const [fProvider, setFProvider] = useState('openai');
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
		const token = getToken();
		if (!silent) setLoading(true);
		setListErr(null);
		try {
			if (!token) {
				setItems([]);
				setListErr(t('modelSection.errors.loginRequired'));
				return;
			}
			const res = await cloudFetch('/models');
			const body = await res.json();
			if (getToken() !== token) return;
			if (!res.ok) throw new Error(body?.detail || t('modelSection.errors.backend', { status: res.status }));
			const models: ModelItem[] = body.models ?? [];
			setItems(models);
			await syncLocalMirror(models, token);
		} catch (e) {
			setListErr(e instanceof Error ? e.message : String(e));
		} finally {
			if (!silent) setLoading(false);
		}
	}

	/** 把完整自定义模型列表（含 apiKey）全量写进本地 config.modelList 镜像 */
	async function syncLocalMirror(models: ModelItem[], token: string) {
		try {
			await syncLocalModelMirror(models, token);
			queryClient.invalidateQueries({ queryKey: AVAILABLE_MODELS_KEY });
		} catch {
			// 本地镜像同步失败不阻塞云端展示（下次 loadList 会再试）
		}
	}

	useEffect(() => {
		loadList();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// 按 baseURL + key 拉取模型列表（服务端代理，绕 CORS）
	async function fetchModelList(base = effBaseURL, key = fKey, provider = fProvider) {
		if (!base) return;
		setFLoading(true);
		setFErr(null);
		try {
			const res = await fetch(apiUrl('/admin/models'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ baseURL: base, apiKey: key, provider }),
			});
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
		if (def && def.needKey === false) fetchModelList(def.baseURL, '', def.key);
	}

	function openEdit(item: ModelItem) {
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

	async function handleToggle(item: ModelItem, enabled: boolean) {
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
		setItems((prev) => prev.filter((it) => it.id !== item.id));
		try {
			const res = await cloudFetch(`/models/${item.id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error('delete failed');
			await loadList(true); // 静默重拉 + 同步本地镜像
		} catch {
			loadList(true);
		}
	}

	// ---------- 第三层：通过服务商添加 / 编辑表单 ----------
	if (view === 'form') {
		const canSubmit = !!effBaseURL && (fSelected.size > 0 || !!fModel.trim()) && !submitting;
		return (
			<div className="flex h-full flex-col animate-in fade-in slide-in-from-right-2 duration-250 ease-out">
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
							aria-label={t('modelSection.form.provider')}
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
							aria-label={t('modelSection.form.apiKey')}
							value={fKey}
							onChange={(e) => setFKey(e.target.value)}
						onBlur={() => effBaseURL && fKey.trim() && fetchModelList()}
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
					aria-label={t('modelSection.form.model')}
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
			<ToChatModelSource />
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
									<tr key={it.id} className={`border-b border-border last:border-b-0 ${it.enabled ? '' : 'opacity-50'}`}>
										<td className="px-4 py-3">
											<div className="flex items-center gap-2.5">
												<ProviderIcon p={def} model={it.model} />
												<span className="truncate font-medium">{it.model}</span>
											</div>
										</td>
										<td className="px-4 py-3 text-muted-foreground">{it.label}</td>
										<td className="px-4 py-3">
											<div className="flex items-center gap-2.5">
												<button
													type="button"
													aria-label={t('modelSection.aria.edit')}
													className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
													onClick={() => openEdit(it)}
												>
													<Pencil className="size-3.5" />
												</button>
												<button
													type="button"
													aria-label={t('modelSection.aria.delete')}
													className="rounded-md p-1 text-muted-foreground hover:bg-destructive-soft hover:text-destructive"
													onClick={() => handleDelete(it)}
												>
													<Trash2 className="size-3.5" />
												</button>
												<Switch
													size="sm"
													checked={it.enabled}
													onCheckedChange={(v) => handleToggle(it, v)}
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

function SystemNotificationSection() {
	const { t } = useTranslation();
	const [enabled, setEnabled] = useState(systemMessageNotificationsEnabled);
	const [testing, setTesting] = useState(false);
	const [testStatus, setTestStatus] = useState('');
	const nativeBridge = (window as { toraWindow?: { notifyNewMessage?: () => Promise<{ status: string }>; testMessageNotification?: () => Promise<{ status: string }> } }).toraWindow;
	if (!nativeBridge?.notifyNewMessage) return null;
	const testNotification = async () => {
		if (!nativeBridge.testMessageNotification || testing) return;
		setTesting(true);
		setTestStatus('');
		try {
			const result = await nativeBridge.testMessageNotification();
			setTestStatus(t(`settings.general.systemNotifications.${['shown', 'unsupported', 'unconfirmed'].includes(result?.status) ? result.status : 'failed'}`));
		} catch { setTestStatus(t('settings.general.systemNotifications.failed')); }
		finally { setTesting(false); }
	};
	return <>
		<Row title={t('settings.general.systemNotifications.title')} description={t('settings.general.systemNotifications.desc')}>
			<div className="flex items-center gap-2">
				{nativeBridge.testMessageNotification && <Button variant="outline" size="sm" disabled={!enabled || testing} onClick={() => void testNotification()}>{t(testing ? 'settings.general.systemNotifications.testing' : 'settings.general.systemNotifications.test')}</Button>}
				<Switch aria-label={t('settings.general.systemNotifications.title')} checked={enabled} onCheckedChange={(value) => { setEnabled(value); setSystemMessageNotificationsEnabled(value); setTestStatus(''); }} />
			</div>
		</Row>
		{testStatus && <p role="status" className="px-5 text-xs text-muted-foreground">{testStatus}</p>}
	</>;
}

/**
 * 提示音设置（自包含：配置写 localStorage、自定义音频写 IndexedDB，
 * 声音设置有独立存储路径）。
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

	const volumeOptions = [...new Set([0.25, 0.5, 0.75, 1, s.volume])].sort((a, b) => a - b)
		.map(value => ({ value: String(value), label: `${Math.round(value * 100)}%` }));

	const kindLabels: Record<SoundKind, string> = {
		ding: t('settings.general.sound.kindDing'),
		crisp: t('settings.general.sound.kindCrisp'),
		soft: t('settings.general.sound.kindSoft'),
		custom: t('settings.general.sound.kindCustom'),
	};

	return (
		<>
			<Row title={t('settings.general.sound.title')} description={t('settings.general.sound.desc')}>
				<Switch aria-label={t('settings.general.sound.title')} checked={s.enabled} onCheckedChange={(v) => update({ enabled: v })} />
			</Row>
			<Row title={t('settings.general.sound.replyDoneTitle')} description={t('settings.general.sound.replyDoneDesc')}>
				<Switch aria-label={t('settings.general.sound.replyDoneTitle')} checked={s.replyDone} disabled={!s.enabled} onCheckedChange={(v) => update({ replyDone: v })} />
			</Row>
			<Row title={t('settings.general.sound.needConfirmTitle')} description={t('settings.general.sound.needConfirmDesc')}>
				<Switch aria-label={t('settings.general.sound.needConfirmTitle')} checked={s.needConfirm} disabled={!s.enabled} onCheckedChange={(v) => update({ needConfirm: v })} />
			</Row>
			<Row title={t('settings.general.sound.kindTitle')} description={t('settings.general.sound.kindDesc')}>
				<div className="flex items-center gap-2">
					<DropdownSelect
						className="w-28"
						aria-label={t('settings.general.sound.kindTitle')}
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
					aria-label={t('settings.general.sound.volumeTitle')}
					value={String(s.volume)}
					disabled={!s.enabled}
					onChange={(v) => update({ volume: Number(v) })}
					options={volumeOptions}
				/>
			</Row>
		</>
	);
}

// ==================== 智能体板块 ====================
// 原聊天页侧栏的智能体选择器 + 设置入口迁入此处（Tora 定制）。

function AgentSection() {
	const { t } = useTranslation();
	const [agents, setAgents] = useState<AgentView[]>([]);
	const [agentId, setAgentId] = useState<string>('');
	const [name, setName] = useState('');
	const [prompt, setPrompt] = useState('');
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// 拉取返回时不得覆盖用户已开始编辑的内容（仅首次填充表单）
	const initialized = useRef(false);

	useEffect(() => {
		let alive = true;
		agentApi
			.list()
			.then((res) => {
				if (!alive) return;
				setAgents(res.agents);
				if (!initialized.current) {
					initialized.current = true;
					const first = res.agents[0];
					if (first) {
						setAgentId(first.id);
						setName(first.data.name ?? '');
						setPrompt(first.data.system_prompt ?? '');
					}
				}
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);

	const current = agents.find((a) => a.id === agentId) ?? null;

	const switchAgent = (id: string) => {
		setAgentId(id);
		const a = agents.find((x) => x.id === id);
		setName(a?.data.name ?? '');
		setPrompt(a?.data.system_prompt ?? '');
		setSaved(false);
		setError(null);
	};

	const handleSave = async () => {
		if (!current) return;
		setSaving(true);
		setSaved(false);
		setError(null);
		try {
			const updated = await agentApi.update(current.id, {
				name: name.trim() || current.data.name,
				system_prompt: prompt,
			});
			setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
			setSaved(true);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};

	return (
		<>
			<h3 className="text-lg font-semibold">{t('agentSection.title')}</h3>
			<CatgirlPersonaSection />
			<div className="mt-2 text-xs text-muted-foreground">
				{t('agentSection.desc')}
			</div>
			<div className="mt-4 space-y-4">
				{agents.length > 1 && (
					<div>
						<div className="text-sm font-medium">{t('agentSection.select')}</div>
						<DropdownSelect
							className="mt-2"
							aria-label={t('agentSection.select')}
							value={agentId}
							onChange={switchAgent}
							options={agents.map((a) => ({ value: a.id, label: a.data.name || a.id }))}
						/>
					</div>
				)}
				<div>
					<div className="text-sm font-medium">
						<span className="mr-1 text-destructive">*</span>{t('agentSection.name')}
					</div>
					<input
						type="text"
						aria-label={t('agentSection.name')}
						value={name}
						onChange={(e) => {
							setName(e.target.value);
							setSaved(false);
						}}
						placeholder={t('agentSection.namePlaceholder')}
						className="mt-2 h-10 w-full rounded-lg border border-input bg-muted px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
					/>
				</div>
				<div>
					<div className="text-sm font-medium">{t('agentSection.systemPrompt')}</div>
					<textarea
						aria-label={t('agentSection.systemPrompt')}
						value={prompt}
						onChange={(e) => {
							setPrompt(e.target.value);
							setSaved(false);
						}}
						placeholder={t('agentSection.systemPromptPlaceholder')}
						rows={8}
						spellCheck={false}
						className="mt-2 w-full resize-y rounded-lg border border-input bg-muted px-3 py-2 font-mono text-xs leading-relaxed outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
					/>
				</div>
				<div className="flex items-center gap-2">
					<Button type="button" size="sm" disabled={saving || !current} onClick={() => void handleSave()}>
						{saving && <Loader2 className="size-3 animate-spin" />}
						{t('agentSection.save')}
					</Button>
					{saved && <span className="text-xs text-emerald-600">{t('agentSection.saved')}</span>}
					{error && <span className="text-xs text-destructive">{t('agentSection.saveFailed', { error })}</span>}
				</div>
			</div>
		</>
	);
}

// ==================== 设置主窗口 ====================

export function SettingsDialog({ open, onOpenChange, initialTab = 'general', onImportSessions }: Props) {
	const { t } = useTranslation();
	const { installed: catgirlInstalled } = useCatgirlSettings();
	const [section, setSection] = useState<Section>(()=>normalizeSettingsSection(initialTab));

	const [lang, setLang] = useState(i18n.language);
	const [searchEngine, setSearchEngine] = useState<SearchEngineId>(() => getSearchEngine());
	const [confirmWipe, setConfirmWipe] = useState(false);
	const [wiping, setWiping] = useState(false);
	const [wipeError, setWipeError] = useState<string | null>(null);
	const [checkingUpdate, setCheckingUpdate] = useState(false);
	const [updateMessage, setUpdateMessage] = useState<string | null>(null);
	const [releaseNotes, setReleaseNotes] = useState<ReleaseNotes | null>(null);
	const showReleaseNotes = async () => {
		const version = getUpdateBridge()?.getAppVersion?.();
		if (!version) return;
		setReleaseNotes({ version, notes: '', url: '', status: 'loading' });
		try {
			const value = await releaseNotesBridge()?.getReleaseNotes?.(version);
			setReleaseNotes(current => current?.version === version ? value ?? { ...current, status: 'error' } : current);
		} catch { setReleaseNotes(current => current?.version === version ? { ...current, status: 'error' } : current); }
	};

	// 打开时重置到初始板块（外部可用 key 重挂载强制指定）
	useEffect(() => {
		if (!open) return;
		setSection(normalizeSettingsSection(initialTab));
		setLang(i18n.language);
		setSearchEngine(getSearchEngine());
		setConfirmWipe(false);
		setWipeError(null);
		setUpdateMessage(null);
		setReleaseNotes(null);
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
			} else if (result.status === 'ready') {
				setUpdateMessage(t('settings.about.update.ready', { version: result.version || '' }));
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
	const restoreFocus = useRef<HTMLElement | null>(null);
	const [mounted, setMounted] = useState(open);
	useEffect(() => {
		if (open) {
			restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			setMounted(true);
			return;
		}
		const timer = setTimeout(() => setMounted(false), 200);
		return () => clearTimeout(timer);
	}, [open]);

	function handleLang(next: string) {
		setLang(next);
		void setAppLanguage(next);
	}

	function handleSearchEngine(next: string) {
		if (!isSearchEngineId(next)) return;
		setSearchEngine(next);
		saveSearchEngine(next);
	}

	async function handleWipe() {
		setWiping(true);
		setWipeError(null);
		try {
			// Tora 扩展端点：服务端清空 sessions + credentials + agents
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
		<SettingsPrimitive.Content forceMount asChild aria-describedby={undefined} onCloseAutoFocus={event => {
			if (restoreFocus.current?.isConnected) { event.preventDefault(); restoreFocus.current.focus(); }
		}}>
		<div
			aria-hidden={closing}
			className={
				'app-wallpaper fixed inset-0 z-50 text-card-foreground ' +
				(closing
					? 'animate-out fade-out-0 duration-200'
					: 'animate-in fade-in-0 duration-200')
			}
		>
			<SettingsPrimitive.Title className="sr-only">{t('settings.title')}</SettingsPrimitive.Title>
			{/* 全屏设置：左侧导航保持上下文，右侧为集中阅读区。 */}
			<div
				className={
					'relative flex h-full w-full overflow-hidden bg-transparent text-card-foreground ease-out ' +
					(closing
						? 'animate-out fade-out-0 duration-200'
						: 'animate-in fade-in-0 duration-200')
				}
			>
				{/* 左侧导航 */}
				<nav className="app-no-drag flex w-72 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 pb-4 pt-14">
					<button
						type="button"
						className="app-no-drag mb-5 flex items-center gap-2 rounded-rect px-2 py-2 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring"
						onClick={() => onOpenChange(false)}
					>
						<ChevronLeft className="size-4" />
						{t('settings.backToApp')}
					</button>
					<div className="px-2 pb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">{t('settings.title')}</div>
					<div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
					{SECTIONS.map(({ key, label, icon: Icon }) => (
						<button
							key={key}
							aria-current={section === key ? 'page' : undefined}
							type="button"
							className={
								'flex items-center gap-2.5 rounded-rect px-3 py-2 text-sm transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring ' +
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
					<WindowDragRegion className="absolute inset-x-0 top-0 z-10 h-12" />
					{/* key={section} 让板块切换时重挂载触发入场动画 */}
					<div key={section} className="settings-section-transition min-h-0 flex-1 overflow-y-auto animate-in fade-in slide-in-from-bottom-1 duration-250">
						<div className="mx-auto w-full max-w-4xl px-8 py-14 sm:px-12 lg:py-16">
						{section === 'general' && (
							<>
								<h3 className="text-lg font-semibold">{t('settings.general.title')}</h3>
								<div className="mt-2 text-xs text-muted-foreground">{t('settings.general.common')}</div>
<div className="mt-3 space-y-3">
							<Row title={t('settings.general.language.title')} description={t('settings.general.language.desc')}>
										<DropdownSelect
											className="w-64 max-w-full"
											aria-label={t('settings.general.language.title')}
											value={normalizeLanguage(lang) ?? 'en-US'}
											onChange={handleLang}
											options={availableLanguageOptions(catgirlInstalled).map((option) => ({
												value: option.value,
												label: t(`settings.general.language.${option.key}`, { defaultValue: option.nativeName }),
												icon: <LanguageFlag language={option.value} />,
											}))}
										/>
									</Row>
									<Row title={t('settings.general.searchEngine.title')} description={t('settings.general.searchEngine.desc')}>
										<DropdownSelect
											className="w-44"
											aria-label={t('settings.general.searchEngine.title')}
											value={searchEngine}
											onChange={handleSearchEngine}
											options={SEARCH_ENGINES.map(({ id }) => ({
												value: id,
												label: t(`settings.general.searchEngine.engines.${id}`),
											}))}
										/>
									</Row>
									<SystemNotificationSection />
									<SoundSection />
								</div>

								</>
						)}
						{section === 'theme' && <ThemeSection />}

						{section === 'quota' && <QuotaSection/>}
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
								<p className="mt-2 text-xs text-muted-foreground">{t('settings.account.manager.description')}</p>
								<div className="mt-5">
									<AccountSection />
								</div>
							</>
						)}

						{section === 'model' && <ModelSection />}

					{section === 'agent' && <AgentSection />}

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
									{onImportSessions && <Row title={t('sessionImport.title')} description={t('sessionImport.description')}>
										<Button type="button" variant="outline" size="sm" data-testid="open-session-import" onClick={onImportSessions}>
											<Import className="size-3.5" />{t('sessionImport.title')}
										</Button>
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
									<Row title="Tora" description={t('settings.about.tora', { version: getUpdateBridge()?.getAppVersion?.() ?? '1.0.0' })} />
									<Row title={t('settings.about.runtimeTitle')} description={t('settings.about.runtime')} />
									<Row title={t('settings.about.update.title')} description={t('settings.about.update.desc')}>
										<Button variant="outline" size="sm" onClick={handleCheckForUpdates} disabled={checkingUpdate}>
											{checkingUpdate && <Loader2 className="animate-spin" />}
											{checkingUpdate ? t('settings.about.update.checking') : t('settings.about.update.check')}
										</Button>
									</Row>
									{updateMessage && <div className="px-1 text-xs text-muted-foreground">{updateMessage}</div>}
									{releaseNotesBridge()?.getReleaseNotes && <Button variant="outline" size="sm" onClick={() => void showReleaseNotes()}>{t('releaseNotes.view')}</Button>}
									{releaseNotes && <ReleaseNotesDialog notes={releaseNotes} onClose={() => setReleaseNotes(null)} onRetry={() => void showReleaseNotes()} />}
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
		</SettingsPrimitive.Root>
	);
}
