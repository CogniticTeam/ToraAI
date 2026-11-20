/** Original model list and detail panel; context uses the model maximum. */
import { Ban, Box, Check, ChevronDown, PlusCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatModelConfig, CredentialView, ModelCard } from '@/api';
import { FIRST_RUN_CLOSE_MODEL_EVENT } from '@/components/onboarding/constants';
import { ReasoningEffortLabel, ReasoningEffortSlider } from '@/components/select/ReasoningEffortSlider';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ProviderIcon } from '@/components/ui/provider-icon';
import { useAvailableModels } from '@/hooks/useAvailableModels';
import { useTranslation } from '@/i18n/useI18n.ts';
import { OPEN_SETTINGS_EVENT } from '@/lib/openSettings';
import { isBuiltinCredential, modelAllowedInMode, modelAvailable, toChatModel } from '@/lib/tochatModels';
import { cn } from '@/lib/utils';
import { credentialLabel } from '@/utils/common';

/** One row of the flattened picker: a model plus where it came from. */
interface ModelEntry {
	type: string;
	credential: CredentialView;
	model: ModelCard;
}

function thinkingSettings(model: ModelCard | undefined) {
	const properties = model?.parameter_schema?.properties as Record<string, { type?: string; enum?: unknown[]; default?: unknown }> | undefined;
	const declared = properties?.thinkingEffort;
	const supported = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
	const levels = Array.isArray(declared?.enum)
		? [...new Set(declared.enum.filter((level): level is string => typeof level === 'string' && supported.has(level)))] : [];
	if (properties?.thinking?.type === 'boolean') {
		if (levels.length) {
			if (!levels.includes('none')) levels.unshift('off');
		} else levels.push('off', 'on');
	}
	const defaultLevel = typeof declared?.default === 'string' && levels.includes(declared.default)
		? declared.default : levels.includes('high') ? 'high' : levels.at(-1) ?? '';
	return { levels, defaultLevel };
}

function thinkingLevelOf(parameters: Record<string, unknown> | undefined, model: ModelCard | undefined): string {
	const { levels, defaultLevel } = thinkingSettings(model);
	if (!levels.length) return '';
	if (parameters?.thinking === false) return levels.find(level => level === 'off' || level === 'none') ?? levels[0];
	const requested = parameters?.thinkingEffort;
	if (typeof requested === 'string' && levels.includes(requested)) return requested;
	if (requested === 'low' && levels.includes('minimal')) return 'minimal';
	if (requested === 'max' || requested === 'xhigh') return levels.at(-1) ?? defaultLevel;
	return defaultLevel;
}

function parametersWithThinking(parameters: Record<string, unknown> | undefined, level: string) {
	const next: Record<string, unknown> = { ...parameters, contextWindow: 'max', thinking: level !== 'off' && level !== 'none' };
	if (level === 'off' || level === 'on') delete next.thinkingEffort;
	else next.thinkingEffort = level;
	return next;
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
	onChange?: (value: ChatModelConfig | null) => void | Promise<void>;
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
	modelFilter?: (name: string) => boolean;
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
	includeBuiltin: _includeBuiltin = false,
	modelFilter,
	disabled = false,
	className,
	...props
}: Props) {
	void _includeBuiltin;
	const [saving, setSaving] = useState(false);
	const saveLock = useRef(false);
	const locked = disabled || saving;
	const { groups, loading, refetch, builtinQuota, builtinUnavailable, error } = useAvailableModels(false, false);
	const { t } = useTranslation();
	// 内置模型不再出现在选择器里。添加模型页仍然负责接入自定义服务商。
	const groupEntries = Object.entries(groups)
		.map(([type, items]) => [type, items.filter(i => !isBuiltinCredential(i.credential.id)).map(item => ({
			...item, models: modelFilter ? item.models.filter(model => modelFilter(model.name)) : item.models,
		})).filter(item => item.models.length > 0)] as const)
		.filter(([, usable]) => usable.length > 0);

	const allEntries: ModelEntry[] = groupEntries.flatMap(([type, usable]) =>
		usable.flatMap(({ credential, models }) => models.map((model) => ({ type, credential, model }))),
	);
	const entries: ModelEntry[] = allEntries.filter(entry => !isBuiltinCredential(entry.credential.id) || modelAllowedInMode(entry.model.name,'tocode',builtinQuota?.models));
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

	const save = useCallback(async (next: ChatModelConfig | null) => {
		if (disabled || saveLock.current || !onChange) return;
		saveLock.current = true;
		setSaving(true);
		try {
			await onChange(next);
		} catch {
			// The API client reports failures; the parent retains its confirmed value.
		} finally {
			saveLock.current = false;
			setSaving(false);
		}
	}, [disabled, onChange]);

	const handleSelect = (event: React.MouseEvent<HTMLButtonElement>) => {
		const entry = entries[Number(event.currentTarget.dataset.modelIndex)];
		if (locked || (isBuiltinCredential(entry.credential.id) && (builtinUnavailable || !modelAvailable(entry.model.name,builtinQuota?.models,'tocode')))) return;
		const parameters = { ...value?.parameters, contextWindow: 'max', contextSize: entry.model.context_size };
		const level = thinkingLevelOf(parameters, entry.model);
		void save({
			type: entry.type,
			credential_id: entry.credential.id,
			model: entry.model.name,
			parameters: level ? parametersWithThinking(parameters, level) : parameters,
		});
	};

	const handleThinking = async (level: string) => {
		if (!value || !thinkingSettings(selectedEntry?.model).levels.includes(level)) return;
		if (level === confirmedLevel) return;
		await save({ ...value, parameters: parametersWithThinking(value.parameters, level) });
	};

	const displayLabel = value?.model
		? isBuiltinCredential(value.credential_id) ? toChatModel(value.model,builtinQuota?.models).name : value.model
		: loading
			? t('llm-select.loading')
			: (placeholder ?? t('llm-select.placeholder'));

	const detail = selectedEntry;
	const shownLevel = thinkingLevelOf(value?.parameters, detail?.model);
	const confirmedLevel = value?.parameters?.thinking === false && shownLevel !== 'off' && shownLevel !== 'none' ? '' : shownLevel;
	const thinkingOptions = thinkingSettings(detail?.model).levels.map(level => ({
		value: level,
		label: t(`llm-select.level.${level === 'none' ? 'off' : level}`),
	}));

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
					disabled={locked}
				>
					{!composer && <ProviderIcon
						keyName={selectedEntry ? providerKeyOf(selectedEntry.credential, selectedEntry.model.name) : 'custom'}
						size="size-4"
						fallback={<Box className="size-3.5 shrink-0 text-muted-foreground" />}
					/>}
					<span className={cn('truncate', composer ? 'max-w-36' : 'max-w-56')}>{displayLabel}</span>
					{composer && value?.model && shownLevel && <ReasoningEffortLabel value={shownLevel} options={thinkingOptions} className="shrink-0" />}
					<ChevronDown className="size-3.5 text-muted-foreground" />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align={composer ? 'end' : 'start'}
				sideOffset={6}
				className="w-auto max-w-[calc(100vw-16px)] max-h-[var(--radix-popover-content-available-height)] gap-0 overflow-y-auto rounded-2xl p-0"
				data-testid="model-picker"
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
							entries.map(({ credential, model }, idx) => {
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
											data-model-index={idx}
											onClick={handleSelect}
											disabled={locked || (isBuiltinCredential(credential.id) && (builtinUnavailable || !modelAvailable(model.name,builtinQuota?.models,'tocode')))}
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
											<span className="min-w-0 flex-1 truncate">{isBuiltinCredential(credential.id) ? toChatModel(model.name,builtinQuota?.models).name : model.name}</span>
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
									onClick={() => { void save(null); }}
									disabled={locked || !value}
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
									<span className="min-w-0 truncate text-base font-semibold">{isBuiltinCredential(detail.credential.id) ? toChatModel(detail.model.name,builtinQuota?.models).name : detail.model.name}</span>
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

								<div className="flex-1" />

								{thinkingOptions.length > 0 ? <ReasoningEffortSlider
									key={`${value?.credential_id}:${value?.model}:${JSON.stringify(detail.model.parameter_schema)}:${disabled && !saving}`}
									scope={JSON.stringify(value?.parameters)}
									label={t('llm-select.thinking')}
									value={confirmedLevel}
									options={thinkingOptions}
									disabled={locked}
									onCommit={handleThinking}
								/> : <p className="rounded-xl bg-surface-muted px-3 py-2.5 text-xs text-muted-foreground" data-testid="thinking-unavailable">{t('llm-select.thinkingUnavailable')}</p>}
							</div>
						)}
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
