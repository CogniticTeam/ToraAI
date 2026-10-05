/** Compact model list with discrete thinking controls and model-sized context. */
import { Ban, Box, Check, ChevronDown, ChevronRight, PlusCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { EffortSlider } from './EffortSlider';
import type { ChatModelConfig, CredentialView, ModelCard } from '@/api';
import { FIRST_RUN_CLOSE_MODEL_EVENT } from '@/components/onboarding/constants';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ProviderIcon } from '@/components/ui/provider-icon';
import { useAvailableModels } from '@/hooks/useAvailableModels';
import { useTranslation } from '@/i18n/useI18n.ts';
import { OPEN_SETTINGS_EVENT } from '@/lib/openSettings';
import { isBuiltinCredential, toChatEffort, toChatModel } from '@/lib/tochatModels';
import { cn } from '@/lib/utils';
import { credentialLabel } from '@/utils/common';

/** One row of the flattened picker: a model plus where it came from. */
interface ModelEntry {
	type: string;
	credential: CredentialView;
	model: ModelCard;
}

type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type ContextWindow = 'max' | '300k' | '1m';

// 思考档位 label 走 i18n（llm-select.level.*），这里只存档位键
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'high', 'max'];

interface SubmenuOption {
	value: string;
	label: string;
	/** 置灰不可选（如模型不支持 1M）。 */
	disabled?: boolean;
	/** 置灰原因的悬停提示。 */
	hint?: string;
}

/**
 * 详情卡里「标签 + 当前值 + 右延伸子菜单」的一行 —— 思考强度 / 上下文窗口
 * 共用同一套设计。子菜单默认向右延伸，右缘空间不足时翻转向左。
 */
function SubmenuRow({ label, current, currentLabel, options, onSelect }: {
	label: string;
	/** 当前选中的 option.value。 */
	current: string;
	currentLabel: string;
	options: SubmenuOption[];
	onSelect: (value: string) => void;
}) {
	const btnRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [side, setSide] = useState<'right' | 'left'>('right');
	const toggle = () => {
		if (!open) {
			const r = btnRef.current?.getBoundingClientRect();
			// 面板 w-36（144px）+ 间距，右缘放不下就翻转向左
			setSide(r && window.innerWidth - r.right < 170 ? 'left' : 'right');
		}
		setOpen((v) => !v);
	};
	// 点击空白处（行自身与子菜单之外）收起子菜单；capture 阶段监听，
	// 避免被业务层的 stopPropagation 拦掉。
	useEffect(() => {
		if (!open) return;
		const onDocPointerDown = (e: PointerEvent) => {
			const root = btnRef.current?.parentElement;
			if (root && e.target instanceof Node && !root.contains(e.target)) setOpen(false);
		};
		document.addEventListener('pointerdown', onDocPointerDown, true);
		return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
	}, [open]);
	return (
		<div className="relative">
			<button
				ref={btnRef}
				type="button"
				onClick={toggle}
				className="flex w-full items-center justify-between rounded-xl bg-surface-muted px-3 py-2.5 text-sm hover:bg-surface-muted"
			>
				<span>{label}</span>
				<span className="flex items-center gap-0.5 text-muted-foreground">
					{currentLabel}
					<ChevronRight className="size-3.5" />
				</span>
			</button>
			{open && (
				<div
					className={cn(
						'absolute top-0 z-10 w-36 rounded-xl border bg-popover p-1.5 shadow-md',
						side === 'right' ? 'left-full ml-2' : 'right-full mr-2',
					)}
				>
					{options.map((o) => (
						<button
							key={o.value}
							type="button"
							disabled={o.disabled}
							title={o.hint}
							onClick={() => {
								if (o.disabled) return;
								onSelect(o.value);
								setOpen(false);
							}}
							className={cn(
								'flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm motion-safe:transition-colors',
								o.value === current ? 'bg-accent' : 'hover:bg-accent',
								o.disabled && 'cursor-not-allowed opacity-40',
							)}
						>
							<span>{o.label}</span>
							{o.value === current && <Check className="size-4 text-primary" />}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/** 从 parameters 读出当前思考档（保留用户保存的 medium 档位）。 */
function thinkingLevelOf(parameters: Record<string, unknown> | undefined): ThinkingLevel {
	if (!parameters || parameters.thinking === false) return 'off';
	const effort = parameters.thinkingEffort;
	if (effort === 'low') return 'low';
	if (effort === 'medium') return 'medium';
	if (effort === 'xhigh') return 'xhigh';
	if (effort === 'max') return 'max';
	return 'high'; // high / 未设置（默认开、高强度）
}

function contextWindowOf(parameters: Record<string, unknown> | undefined): ContextWindow {
 const value = parameters?.contextWindow;
 return value === '300k' || value === '1m' ? value : 'max';
}
function contextSizeOf(model: ModelCard, context: ContextWindow) {
 const maximum = Math.max(1024, model.context_size || 128000);
 return context === 'max' ? maximum : Math.min(maximum, context === '1m' ? 1000000 : 300000);
}
function contextLabel(size: number) { return size >= 1000000 ? `${Number((size / 1000000).toFixed(3))}M` : `${Math.round(size / 1000)}K`; }

/**
 * Provider key for a single model.
 *
 * Credentials are one-per-provider ({@link credential.data.provider}), except
 * the synthesized `cocode-models` credential, which bundles models added
 * through the settings window and carries a per-model map instead. Unknown
 * providers fall through to `custom`, which renders the generic cube.
 */
function providerKeyOf(credential: CredentialView, modelName: string): string {
	if (/gemini/i.test(modelName)) return 'gemini';
	const data = credential.data as Record<string, unknown>;
	const map = data.model_providers as Record<string, unknown> | undefined;
	const mapped = map?.[modelName];
	if (typeof mapped === 'string' && mapped) return mapped;
	const provider = data.provider;
	return typeof provider === 'string' && provider ? provider : 'custom';
}

interface Props extends Omit<React.ComponentPropsWithoutRef<typeof Button>, 'onChange' | 'value'> {
	value?: ChatModelConfig | null;
	/** 输入卡片底部的紧凑文字式触发器。 */
	composer?: boolean;
	/**
	 * Called when the user selects a model, or — when `allowClear` is true —
	 * clears the selection (in which case `null` is emitted).
	 */
	onChange?: (value: ChatModelConfig | null) => void;
	onAddCredential?: () => void;
	refetchTrigger?: number;
	/** Override the trigger label shown when no model is selected. */
	placeholder?: string;
	/**
	 * When true, append a "clear selection" item to the dropdown that emits
	 * `null` via `onChange`. Used by the fallback selector.
	 */
	allowClear?: boolean;
	/** Override the label of the "clear selection" item. */
	clearLabel?: string;
	includeBuiltin?: boolean;
}

export function LlmSelect({
	value,
	composer = false,
	onChange,
	onAddCredential,
	refetchTrigger,
	placeholder,
	allowClear = false,
	clearLabel,
	includeBuiltin = true,
	className,
	...props
}: Props) {
	const { groups, loading, refetch } = useAvailableModels();
	const { t } = useTranslation();
	// 凭证的模型列表加载失败会带回空 models 数组；丢弃避免渲染死行
	const groupEntries = Object.entries(groups)
		.map(([type, items]) => [type, items.filter((i) => i.models.length > 0 && (includeBuiltin || !isBuiltinCredential(i.credential.id)))] as const)
		.filter(([, usable]) => usable.length > 0);

	const allEntries: ModelEntry[] = groupEntries.flatMap(([type, usable]) =>
		usable.flatMap(({ credential, models }) => models.map((model) => ({ type, credential, model }))),
	);
	const entries: ModelEntry[] = allEntries;
	// 每个凭证首次出现的下标 —— 左列在组首渲染凭证标题
	const firstIdxByCredential = new Map<string, number>();
	entries.forEach((e, idx) => {
		if (!firstIdxByCredential.has(e.credential.id)) firstIdxByCredential.set(e.credential.id, idx);
	});

	const hasOptions = entries.length > 0;

	// 详情卡跟随当前选中模型；左列 hover 只做高亮预览
	const selectedEntry = entries.find(
		(e) => e.credential.id === value?.credential_id && e.model.name === value?.model,
	);

	useEffect(() => {
		if (refetchTrigger !== undefined && refetchTrigger > 0) refetch();
	}, [refetchTrigger, refetch]);

	const handleSelect = (entry: ModelEntry) => {
		// 换模型保留思考强度 / 上下文窗口等参数偏好
		onChange?.({
			type: entry.type,
			credential_id: entry.credential.id,
			model: entry.model.name,
			parameters: isBuiltinCredential(entry.credential.id) ? { ...(value?.parameters ?? {}), contextWindow: value?.parameters?.contextWindow ?? 'max', contextSize: entry.model.context_size, thinking: true, thinkingEffort: toChatEffort(entry.model.name, String(value?.parameters?.thinkingEffort ?? 'high')) } : { ...(value?.parameters ?? {}), contextWindow: value?.parameters?.contextWindow ?? 'max', contextSize: entry.model.context_size },
		});
	};

	/** 更新当前选中模型的 parameters（思考档位 / 上下文窗口共用入口）。 */
	const patchParameters = (patch: Record<string, unknown>) => {
		if (!value) return;
		onChange?.({ ...value, parameters: { ...(value.parameters ?? {}), ...patch } });
	};

	const handleThinking = (level: ThinkingLevel) => {
		const parameters: Record<string, unknown> = { ...(value?.parameters ?? {}) };
		parameters.thinking = level !== 'off';
		if (level === 'off' || level === 'high') delete parameters.thinkingEffort; // high 是默认档
		else parameters.thinkingEffort = level;
		onChange?.({ ...value, parameters } as ChatModelConfig);
	};

	const displayLabel = value?.model
		? isBuiltinCredential(value.credential_id) ? toChatModel(value.model).name : value.model
		: loading
			? t('llm-select.loading')
			: (placeholder ?? t('llm-select.placeholder'));

	const detail = selectedEntry;
	const detailModel = detail?.model;
	const currentCtx: ContextWindow | null = detailModel ? contextWindowOf(value?.parameters) : null;
	const currentLevel = value && isBuiltinCredential(value.credential_id) ? toChatEffort(value.model, String(value.parameters?.thinkingEffort ?? 'high')) : thinkingLevelOf(value?.parameters);

	// 受控开关 + 文档级兜底：radix 自带外点关闭，但个别空白区域的事件可能被
	// 业务层吞掉，这里在 capture 阶段再兜一道 —— 点在 popover/触发器之外即关。
	const [popOpen, setPopOpen] = useState(false);
	useEffect(() => {
		const closeForSettings = () => setPopOpen(false);
		window.addEventListener(OPEN_SETTINGS_EVENT, closeForSettings);
		window.addEventListener(FIRST_RUN_CLOSE_MODEL_EVENT, closeForSettings);
		return () => {
			window.removeEventListener(OPEN_SETTINGS_EVENT, closeForSettings);
			window.removeEventListener(FIRST_RUN_CLOSE_MODEL_EVENT, closeForSettings);
		};
	}, []);
	useEffect(() => {
		if (!popOpen) return;
		const onDocPointerDown = (e: PointerEvent) => {
			const t = e.target;
			if (t instanceof Element && t.closest('[data-slot="popover-content"],[data-slot="popover-trigger"]')) return;
			setPopOpen(false);
		};
		document.addEventListener('pointerdown', onDocPointerDown, true);
		return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
	}, [popOpen]);

	return (
		<Popover open={popOpen} onOpenChange={setPopOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className={cn(
						'gap-1.5 rounded-rect font-normal',
						composer ? 'max-w-56 border-0 bg-transparent px-2 text-sm text-foreground hover:bg-muted/60' : 'border border-transparent hover:border-border hover:bg-transparent',
						className,
					)}
					{...props}
				>
					{!composer && <ProviderIcon
						keyName={selectedEntry ? providerKeyOf(selectedEntry.credential, selectedEntry.model.name) : 'custom'}
						size="size-4"
						fallback={<Box className="size-3.5 shrink-0 text-muted-foreground" />}
					/>}
					<span className={cn('truncate', composer ? 'max-w-36' : 'max-w-56')}>{displayLabel}</span>
					{composer && value?.model && <span className="shrink-0 text-muted-foreground">{t(`llm-select.level.${currentLevel}`)}</span>}
					<ChevronDown className="size-3.5 text-muted-foreground" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align={composer ? 'end' : 'start'} sideOffset={8} className="w-72 gap-0 max-w-[calc(100vw-24px)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-2xl p-2">
    <p className="px-3 py-2 text-sm font-medium text-muted-foreground">{t('llm-select.placeholder')}</p>
    {!loading && !hasOptions && <p className="px-3 py-4 text-sm text-muted-foreground">{t('llm-select.empty.description')}</p>}
    {entries.map(({type, credential, model}, idx) => <div key={`${credential.id}:${model.name}`}>
     {firstIdxByCredential.get(credential.id) === idx && <div className="px-3 pb-2 pt-1"><p className="text-sm font-medium">{isBuiltinCredential(credential.id) ? t('llm-select.defaultSet') : credentialLabel(credential, t('common.toraModels'))}</p>{isBuiltinCredential(credential.id) && <p className="text-xs text-muted-foreground">{t('llm-select.recommendedSet')}</p>}</div>}
     <button type="button" aria-pressed={value?.credential_id === credential.id && value?.model === model.name} onClick={() => handleSelect({type, credential, model})} className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-start text-sm hover:bg-accent"><span className="truncate">{isBuiltinCredential(credential.id) ? toChatModel(model.name).name : model.name}</span>{value?.credential_id === credential.id && value?.model === model.name && <Check className="size-4 shrink-0 text-muted-foreground" />}</button>
    </div>)}
    {detail && <div className="mt-2 border-t">
     <EffortSlider model={isBuiltinCredential(detail.credential.id) ? toChatModel(detail.model.name).name : detail.model.name} value={currentLevel} levels={isBuiltinCredential(detail.credential.id) ? toChatModel(detail.model.name).efforts : /gemini-3\.8-flash/i.test(detail.model.name) ? ['off','low','medium','high'] : THINKING_LEVELS} onChange={level => handleThinking(level as ThinkingLevel)} />
     {currentCtx && <SubmenuRow label={t('llm-select.contextWindow')} current={currentCtx} currentLabel={contextLabel(contextSizeOf(detail.model, currentCtx))} options={[{value:'max',label:`${t('llm-select.maximumContext')} · ${contextLabel(detail.model.context_size)}`}, ...(['300k','1m'] as const).filter(key => (key === '1m' ? 1000000 : 300000) < detail.model.context_size).map(key => ({value:key,label:key === '1m' ? '1M' : '300K'}))]} onSelect={contextWindow => patchParameters({contextWindow,contextSize:detail.model.context_size})} />}
    </div>}
    <div className="mt-2 border-t pt-1">
     {allowClear && <button type="button" onClick={() => onChange?.(null)} disabled={!value} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-muted-foreground hover:bg-accent disabled:opacity-40"><Ban className="size-4" />{clearLabel ?? t('llm-select.clear')}</button>}
     <button type="button" id={props.id === 'tour-llm-select' ? 'tour-add-model' : undefined} onClick={() => {setPopOpen(false);onAddCredential?.();}} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-muted-foreground hover:bg-accent"><PlusCircle className="size-4" />{t('llm-select.addCredential')}</button>
    </div>
   </PopoverContent>
		</Popover>
	);
}
