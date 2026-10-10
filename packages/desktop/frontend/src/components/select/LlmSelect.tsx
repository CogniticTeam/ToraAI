/** Original model list and detail panel; context uses the model maximum. */
import { Ban, Box, Check, ChevronDown, ChevronRight, PlusCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ChatModelConfig, CredentialView, ModelCard } from '@/api';
import {AgentQuotaMeter} from '@/components/chat/AgentQuotaMeter';
import { FIRST_RUN_CLOSE_MODEL_EVENT } from '@/components/onboarding/constants';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ProviderIcon } from '@/components/ui/provider-icon';
import { useAvailableModels } from '@/hooks/useAvailableModels';
import { useTranslation } from '@/i18n/useI18n.ts';
import { OPEN_SETTINGS_EVENT } from '@/lib/openSettings';
import { isBuiltinCredential, modelAllowedInMode, modelAvailable, toChatEffort, toChatModel } from '@/lib/tochatModels';
import { cn } from '@/lib/utils';
import { credentialLabel } from '@/utils/common';

/** One row of the flattened picker: a model plus where it came from. */
interface ModelEntry {
	type: string;
	credential: CredentialView;
	model: ModelCard;
}

type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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

/** Portal positioning avoids both horizontal and vertical window boundaries. */
function SubmenuRow({ label, current, currentLabel, options, onSelect }: {
 label: string; current: string; currentLabel: string; options: SubmenuOption[];
 onSelect: (value: string) => void;
}) {
 const [open,setOpen] = useState(false);
 return <Popover open={open} onOpenChange={setOpen}>
  <PopoverTrigger asChild><button type="button" className="flex w-full items-center justify-between rounded-xl bg-surface-muted px-3 py-2.5 text-sm hover:bg-surface-muted">
   <span>{label}</span><span className="flex items-center gap-0.5 text-muted-foreground">{currentLabel}<ChevronRight className="size-3.5" /></span>
  </button></PopoverTrigger>
  <PopoverContent data-testid="thinking-menu" side="right" align="start" sideOffset={8} collisionPadding={8} avoidCollisions sticky="always" className="z-50 w-36 gap-0 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-xl p-1.5">
   {options.map(option => <button key={option.value} type="button" disabled={option.disabled} title={option.hint} aria-pressed={option.value === current} onClick={() => {onSelect(option.value);setOpen(false);}} className={cn('flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm motion-safe:transition-colors',option.value === current ? 'bg-accent' : 'hover:bg-accent',option.disabled && 'cursor-not-allowed opacity-40')}>
    <span>{option.label}</span>{option.value === current && <Check className="size-4 text-primary" />}
   </button>)}
  </PopoverContent>
 </Popover>;
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
	const { groups, loading, refetch, builtinQuota, builtinUnavailable, error } = useAvailableModels();
	const { t } = useTranslation();
	// 凭证的模型列表加载失败会带回空 models 数组；丢弃避免渲染死行
	const groupEntries = Object.entries(groups)
		.map(([type, items]) => [type, items.filter((i) => i.models.length > 0 && (includeBuiltin || !isBuiltinCredential(i.credential.id)))] as const)
		.filter(([, usable]) => usable.length > 0);

	const allEntries: ModelEntry[] = groupEntries.flatMap(([type, usable]) =>
		usable.flatMap(({ credential, models }) => models.map((model) => ({ type, credential, model }))),
	);
	const entries: ModelEntry[] = allEntries.filter(entry => !isBuiltinCredential(entry.credential.id) || modelAllowedInMode(entry.model.name,'tocode'));
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
		if (isBuiltinCredential(entry.credential.id) && (builtinUnavailable || !modelAvailable(entry.model.name,builtinQuota?.models))) return;
		// 换模型保留思考强度 / 上下文窗口等参数偏好
		onChange?.({
			type: entry.type,
			credential_id: entry.credential.id,
			model: entry.model.name,
			parameters: isBuiltinCredential(entry.credential.id) ? { ...(value?.parameters ?? {}), contextWindow: 'max', contextSize: entry.model.context_size, thinking: true, thinkingEffort: toChatEffort(entry.model.name, String(value?.parameters?.thinkingEffort ?? 'high')) } : { ...(value?.parameters ?? {}), contextWindow: 'max', contextSize: entry.model.context_size },
		});
	};

	const handleThinking = (level: ThinkingLevel) => {
		const parameters: Record<string, unknown> = { ...(value?.parameters ?? {}), contextWindow: 'max' };
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
		<Popover open={popOpen} onOpenChange={open => {setPopOpen(open);if(open && (builtinUnavailable || error))refetch();}}>
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
			<PopoverContent
				align={composer ? 'end' : 'start'}
				sideOffset={6}
				className="w-auto gap-0 overflow-visible rounded-2xl p-0"
			>
				<div className="flex items-stretch max-sm:flex-col">
					{/* ─────────── 左列：模型清单 ─────────── */}
					<div className="w-60 shrink-0 overflow-y-auto p-1.5 max-sm:w-72" style={{ maxHeight: '26rem' }}>
						{!loading && !hasOptions ? (
							<div className="px-2 py-3 text-center text-sm text-muted-foreground">
								<p className="font-medium">{t('llm-select.empty.title')}</p>
								<p className="text-xs mt-1">{t('llm-select.empty.description')}</p>
							</div>
						) : (
							entries.map(({ type, credential, model }, idx) => {
								const selected =
									value?.credential_id === credential.id && value?.model === model.name;
								const showHeader = firstIdxByCredential.get(credential.id) === idx;
								return (
									<div key={`${credential.id}:${model.name}`}>
										{showHeader && (
											<div className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground first:pt-1">
												{isBuiltinCredential(credential.id) ? t('llm-select.builtinModels') : credentialLabel(credential, t('common.toraModels'))}
											</div>
										)}
										<button
											type="button"
											onClick={() => handleSelect({ type, credential, model })}
											disabled={isBuiltinCredential(credential.id) && (builtinUnavailable || !modelAvailable(model.name,builtinQuota?.models))}
											className={cn(
												'flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-sm motion-safe:transition-colors',
												selected ? 'bg-accent' : 'hover:bg-accent',
												'disabled:cursor-not-allowed disabled:opacity-50',
											)}
										>
											<ProviderIcon
												keyName={providerKeyOf(credential, model.name)}
												size="size-5"
												fallback={<Box className="size-4 shrink-0 text-muted-foreground" />}
											/>
											<span className="min-w-0 flex-1 truncate">{isBuiltinCredential(credential.id) ? toChatModel(model.name).name : model.name}</span>
											{isBuiltinCredential(credential.id)&&model.name==='deepseek-flash'&&!builtinQuota?.subscription&&(builtinQuota?.trial?.remaining||0)>0&&<span className="text-xs text-muted-foreground">{t('llm-select.trialRemaining',{count:builtinQuota?.trial?.remaining})}</span>}
											{selected && <Check className="size-4 shrink-0 text-primary" />}
										</button>
									</div>
								);
							})
						)}
						<div className="mt-1 border-t pt-1">
							{(error || builtinUnavailable) && <div className="px-2 py-2 text-xs text-muted-foreground">
								<p>{t('applicationModes.connectError')}</p><button type="button" className="mt-1 text-foreground underline" onClick={refetch}>{t('error.retry')}</button>
							</div>}
							{allowClear && (
								<button
									type="button"
									onClick={() => onChange?.(null)}
									disabled={!value}
									className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-sm text-muted-foreground hover:bg-accent disabled:opacity-40"
								>
									<Ban className="size-4" />
									<span>{clearLabel ?? t('llm-select.clear')}</span>
								</button>
							)}
							<button
								type="button"
								id={props.id === 'tour-llm-select' ? 'tour-add-model' : undefined}
								onClick={() => {
									setPopOpen(false);
									onAddCredential?.();
								}}
								className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-sm text-muted-foreground hover:bg-accent"
							>
								<PlusCircle className="size-4" />
								<span>{t('llm-select.addCredential')}</span>
							</button>
						</div>
					</div>

					{/* ─────────── 右侧：详情卡 ─────────── */}
					<div className="w-64 shrink-0 border-l p-4 max-sm:w-72 max-sm:border-l-0 max-sm:border-t">
						{!detail ? (
							<div className="flex h-full min-h-40 items-center justify-center text-center text-sm text-muted-foreground">
								{t('llm-select.pickForDetails')}
							</div>
						) : (
							<div className="flex h-full flex-col gap-3">
								<div className="flex items-center gap-2.5">
									<ProviderIcon
										keyName={providerKeyOf(detail.credential, detail.model.name)}
										size="size-7"
										fallback={<Box className="size-5 shrink-0 text-muted-foreground" />}
									/>
									<span className="min-w-0 truncate text-base font-semibold">{isBuiltinCredential(detail.credential.id) ? toChatModel(detail.model.name).name : detail.model.name}</span>
								</div>

								{/* 能力标签：多模态输入 / 上下文规模 */}
								<div className="flex flex-wrap gap-1.5">
									{detail.model.input_types.filter((x) => x !== 'text').map((x) => (
										<span key={x} className="rounded-md bg-primary-soft px-1.5 py-0.5 text-[11px] text-primary">
											{x === 'image' ? t('llm-select.vision') : x}
										</span>
									))}
									<span className="rounded-md bg-surface-muted px-1.5 py-0.5 text-[11px] text-muted-foreground tabular-nums">
										{t('llm-select.contextBadge', { size: detail.model.context_size >= 1000000 ? `${Number((detail.model.context_size / 1000000).toFixed(3))}M` : `${Math.round(detail.model.context_size / 1000)}K` })}
									</span>
								</div>

								{isBuiltinCredential(detail.credential.id) && <div className="space-y-1 text-xs text-muted-foreground"><p>{t('llm-select.builtinQuotaHint')}</p>{builtinQuota && <AgentQuotaMeter quota={builtinQuota} />}</div>}
								<div className="flex-1" />

								<SubmenuRow
									label={t('llm-select.thinking')}
									current={currentLevel}
									currentLabel={t(`llm-select.level.${currentLevel}`)}
									options={(isBuiltinCredential(value?.credential_id) ? toChatModel(value?.model).efforts : /(?:^|\/)gemini-3\.8-flash(?:-|$)/i.test(value?.model ?? '') ? ['off', 'low', 'medium', 'high'] : THINKING_LEVELS).map((level) => ({ value: level, label: t(`llm-select.level.${level}`) }))}
									onSelect={(v) => handleThinking(v as ThinkingLevel)}
								/>
							</div>
						)}
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
