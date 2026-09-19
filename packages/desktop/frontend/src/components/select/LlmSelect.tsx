/**
 * 模型选择器（截图2 样式）：左列模型清单 + 右侧详情卡。
 *   · 详情卡含「思考强度」行 —— 点开子菜单**向右延伸**（关闭/低/高/极致）；
 *   · 「上下文窗口」行 —— 所有模型默认 300K，点击在 300K / 1M 间自由切换；
 *   · 两项都写进 chat_model_config.parameters，随会话持久化。
 * 思考档位映射：低=low，高=high，极致=max（model.js 对 reasoning_effort
 * 端点把 max 归一化为 high 发送）。
 */
import { Ban, Box, Check, ChevronDown, ChevronRight, PlusCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { ChatModelConfig, CredentialView, ModelCard } from '@/api';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ProviderIcon } from '@/components/ui/provider-icon';
import { useAvailableModels } from '@/hooks/useAvailableModels';
import { useTranslation } from '@/i18n/useI18n.ts';
import { cn } from '@/lib/utils';
import { credentialLabel } from '@/utils/common';

/** One row of the flattened picker: a model plus where it came from. */
interface ModelEntry {
	type: string;
	credential: CredentialView;
	model: ModelCard;
}

type ThinkingLevel = 'off' | 'low' | 'high' | 'max';
type ContextWindow = '300k' | '1m';

// 思考档位 label 走 i18n（llm-select.level.*），这里只存档位键
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'high', 'max'];

/**
 * 允许切 1M 的门槛。供应商元数据普遍**低报**上下文（实际支持 1M 的模型常登记
 * 成 128K/200K），按 ≥1M 判会误拦；因此只拦「明确的小上下文模型」（标称
 * < 100K，如 8K/32K 档），其余一律允许切 1M。
 */
const CTX_MIN_FOR_1M = 100 * 1024;

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

/** 从 parameters 读出当前思考档（旧数据里的 medium 归入 高）。 */
function thinkingLevelOf(parameters: Record<string, unknown> | undefined): ThinkingLevel {
	if (!parameters || parameters.thinking === false) return 'off';
	const effort = parameters.thinkingEffort;
	if (effort === 'low') return 'low';
	if (effort === 'max') return 'max';
	return 'high'; // high / medium / 未设置（默认开、高强度）
}

function contextWindowOf(parameters: Record<string, unknown> | undefined, model: ModelCard): ContextWindow {
	const v = parameters?.contextWindow;
	if (v === '1m' && model.context_size >= CTX_MIN_FOR_1M) return '1m';
	return '300k'; // 所有模型默认 300K；'1m' 仅在非小上下文模型上生效
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
	const data = credential.data as Record<string, unknown>;
	const map = data.model_providers as Record<string, unknown> | undefined;
	const mapped = map?.[modelName];
	if (typeof mapped === 'string' && mapped) return mapped;
	const provider = data.provider;
	return typeof provider === 'string' && provider ? provider : 'custom';
}

interface Props extends Omit<React.ComponentPropsWithoutRef<typeof Button>, 'onChange' | 'value'> {
	value?: ChatModelConfig | null;
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
}

export function LlmSelect({
	value,
	onChange,
	onAddCredential,
	refetchTrigger,
	placeholder,
	allowClear = false,
	clearLabel,
	className,
	...props
}: Props) {
	const { groups, loading, refetch } = useAvailableModels();
	const { t } = useTranslation();
	// 凭证的模型列表加载失败会带回空 models 数组；丢弃避免渲染死行
	const groupEntries = Object.entries(groups)
		.map(([type, items]) => [type, items.filter((i) => i.models.length > 0)] as const)
		.filter(([, usable]) => usable.length > 0);

	const allEntries: ModelEntry[] = groupEntries.flatMap(([type, usable]) =>
		usable.flatMap(({ credential, models }) => models.map((model) => ({ type, credential, model }))),
	);
	// 官方模型（cocode-models 合成凭证）稳定置顶，其余凭证保持原相对顺序
	const isOfficialEntry = (e: ModelEntry) =>
		!!(e.credential.data as Record<string, unknown>).official_models;
	const entries: ModelEntry[] = [
		...allEntries.filter(isOfficialEntry),
		...allEntries.filter((e) => !isOfficialEntry(e)),
	];
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
			parameters: { ...(value?.parameters ?? {}) },
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
		? value.model
		: loading
			? t('llm-select.loading')
			: (placeholder ?? t('llm-select.placeholder'));

	const detail = selectedEntry;
	const detailModel = detail?.model;
	const currentCtx: ContextWindow | null = detailModel ? contextWindowOf(value?.parameters, detailModel) : null;
	const currentLevel = thinkingLevelOf(value?.parameters);

	// 受控开关 + 文档级兜底：radix 自带外点关闭，但个别空白区域的事件可能被
	// 业务层吞掉，这里在 capture 阶段再兜一道 —— 点在 popover/触发器之外即关。
	const [popOpen, setPopOpen] = useState(false);
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
						'gap-1.5 rounded-rect border border-transparent font-normal hover:border-border hover:bg-transparent',
						className,
					)}
					{...props}
				>
					<ProviderIcon
						keyName={selectedEntry ? providerKeyOf(selectedEntry.credential, selectedEntry.model.name) : 'custom'}
						size="size-4"
						fallback={<Box className="size-3.5 shrink-0 text-muted-foreground" />}
					/>
					<span className="max-w-56 truncate">{displayLabel}</span>
					<ChevronDown className="size-3.5 text-muted-foreground" />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				sideOffset={6}
				className="w-auto gap-0 overflow-visible rounded-2xl p-0"
			>
				<div className="flex items-stretch">
					{/* ─────────── 左列：模型清单 ─────────── */}
					<div className="w-60 shrink-0 overflow-y-auto p-1.5" style={{ maxHeight: '26rem' }}>
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
								// cocode-models 合成凭证在 data.official_models 里标记官方模型名
								const credentialData = credential.data as Record<string, unknown>;
								const officialSet = credentialData.official_models as string[] | undefined;
								const isOfficial = officialSet?.includes(model.name) ?? false;
								return (
									<div key={`${credential.id}:${model.name}`}>
										{showHeader && (
											<div className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground first:pt-1">
												{credentialLabel(credential)}
											</div>
										)}
										<button
											type="button"
											onClick={() => handleSelect({ type, credential, model })}
											className={cn(
												'flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-sm motion-safe:transition-colors',
												selected ? 'bg-accent' : 'hover:bg-accent',
											)}
										>
											<ProviderIcon
												keyName={providerKeyOf(credential, model.name)}
												size="size-5"
												fallback={<Box className="size-4 shrink-0 text-muted-foreground" />}
											/>
											<span className="min-w-0 flex-1 truncate">{model.name}</span>
											{isOfficial && (
												<span className="shrink-0 rounded-md bg-gradient-to-r from-violet-500/15 to-pink-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-300">
															{t('common.officialModel')}
												</span>
											)}
											{selected && <Check className="size-4 shrink-0 text-primary" />}
										</button>
									</div>
								);
							})
						)}
						<div className="mt-1 border-t pt-1">
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
								onClick={onAddCredential}
								className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-sm text-muted-foreground hover:bg-accent"
							>
								<PlusCircle className="size-4" />
								<span>{t('llm-select.addCredential')}</span>
							</button>
						</div>
					</div>

					{/* ─────────── 右侧：详情卡 ─────────── */}
					<div className="w-64 shrink-0 border-l p-4">
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
									<span className="min-w-0 truncate text-base font-semibold">{detail.model.name}</span>
								</div>

								{/* 能力标签：多模态输入 / 上下文规模 */}
								<div className="flex flex-wrap gap-1.5">
									{detail.model.input_types.filter((x) => x !== 'text').map((x) => (
										<span key={x} className="rounded-md bg-primary-soft px-1.5 py-0.5 text-[11px] text-primary">
											{x === 'image' ? t('llm-select.vision') : x}
										</span>
									))}
									<span className="rounded-md bg-surface-muted px-1.5 py-0.5 text-[11px] text-muted-foreground tabular-nums">
										{t('llm-select.contextBadge', { size: currentCtx === '1m' ? '1M' : '300K' })}
									</span>
								</div>

								<div className="flex-1" />

								{/* 思考强度：子菜单行（与上下文窗口同款设计） */}
								<SubmenuRow
									label={t('llm-select.thinking')}
									current={currentLevel}
									currentLabel={t(`llm-select.level.${currentLevel}`)}
									options={THINKING_LEVELS.map((level) => ({ value: level, label: t(`llm-select.level.${level}`) }))}
									onSelect={(v) => handleThinking(v as ThinkingLevel)}
								/>

								{/* 上下文窗口：默认 300K；模型标称 <1M 时 1M 选项置灰不可选 */}
								{currentCtx && (
									<SubmenuRow
										label={t('llm-select.contextWindow')}
										current={currentCtx}
										currentLabel={currentCtx === '1m' ? '1M' : '300K'}
										options={[
											{ value: '300k', label: '300K' },
											{
												value: '1m',
												label: '1M',
												disabled: detailModel!.context_size < CTX_MIN_FOR_1M,
												hint: detailModel!.context_size < CTX_MIN_FOR_1M ? t('llm-select.hintSmallContext') : undefined,
											},
										]}
										onSelect={(v) => patchParameters({ contextWindow: v })}
									/>
								)}
							</div>
						)}
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
