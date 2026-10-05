import type { ContentBlock, TextBlock } from '@agentscope-ai/agentscope/message';
import {
	Plus,
	Loader2,
	XIcon,
	FileText,
	ArrowUp,
	Sparkles,
	MousePointer2,
} from 'lucide-react';
import mime from 'mime';
import React, {
	useCallback,
	useState,
	useId,
	useRef,
	useMemo,
	useLayoutEffect,
	useEffect,
	type KeyboardEvent,
	useImperativeHandle,
	forwardRef,
} from 'react';

import {
	SlashCommandMenu,
	type SlashItem,
	type SlashCommandMenuHandle,
} from './SlashCommandMenu';
import { VoiceRecorder } from './VoiceRecorder';
import { CatgirlPackDialog } from '../dialog/CatgirlPackDialog';
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Kbd } from '../ui/kbd';
import {
	Attachment,
	AttachmentAction,
	AttachmentActions,
	AttachmentContent,
	AttachmentDescription,
	AttachmentGroup,
	AttachmentMedia,
	AttachmentTitle,
} from '@/components/ui/attachment.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ReplyPhase } from '@/hooks/useMessages';
import { useTranslation } from '@/i18n/useI18n.ts';
import { catgirlTrigger, useCatgirlSettings } from '@/lib/catgirl';
import {
	INSERT_CHAT_TEXT_EVENT,
	INSERT_ELEMENT_REF_EVENT,
	type ElementRef,
} from '@/lib/insertChatText';
import { cn } from '@/lib/utils';

/**
 * Represents a file that has been selected and processed (or is being processed).
 */
interface ProcessedFile {
	/** Original file name for display */
	name: string;
	/** Processing status */
	status: 'processing' | 'done';
	/** The resulting ContentBlock after processing (available when status === 'done') */
	block: ContentBlock | null;
}

interface TextInputProps {
	/** Single-row chat composer; the default work composer remains unchanged. */
	variant?: 'default' | 'capsule';
	onSend: (blocks: ContentBlock[], commands: SlashItem[]) => void;
	placeholder?: string;
	/** Status displayed inside the composer without replacing a draft. */
	notice?: string;
	autoComplete?: (input: string) => string | null;
	disabled?: boolean;
	className?: string;
	/**
	 * Controls which file types the file picker accepts.
	 * Uses standard MIME types and file extensions, e.g.:
	 *   - Images:    "image/*" or "image/jpeg", "image/png"
	 *   - Audio:     "audio/*" or "audio/mpeg", "audio/wav"
	 *   - Video:     "video/*"
	 *   - Plain text:"text/plain"
	 *   - PDF:       "application/pdf"
	 *   - Word:      ".doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	 *   - Excel:     ".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	 *
	 * When undefined → no restriction (all files allowed).
	 * When empty array [] → attachment button is disabled (model accepts no files).
	 */
	allowedInputTypes?: string[];
	/**
	 * Called immediately when a file is selected (at attach time, NOT at send time).
	 * Should resolve to a ContentBlock to include in the message, or null to skip the file.
	 * Runs concurrently for all selected files; the UI shows a loading state per file while processing.
	 */
	fileProcessor: (file: File) => Promise<ContentBlock | null>;
	/**
	 * The current reply lifecycle phase from ``useMessages``. Drives the
	 * send / stop button in one shot:
	 *   - ``idle`` — Send (enabled when there is content to send)
	 *   - ``streaming`` — Stop (click to interrupt)
	 *   - ``interrupting`` — Stop (disabled while the interrupt is in flight)
	 */
	phase?: ReplyPhase;
	autoFocus?: boolean;
	onInterrupt?: () => void;
	/**
	 * Optional project picker strip shown only on a new chat, above the card.
	 */
	headerSlot?: React.ReactNode;
	/** Composer card's bottom-left and bottom-right live controls. */
	footerLeft?: React.ReactNode;
	footerRight?: React.ReactNode;
	/**
	 * Items that power the slash ("/") command menu — typically the
	 * user's installed skills. When `undefined`, the menu stays closed
	 * even if the user types "/" so the input behaves as before.
	 */
	commandItems?: SlashItem[];
}

export interface TextInputRef {
	focus: () => void;
}

/** Composer text stays top-aligned above its separate action row. */
const LINE_HEIGHT_PX = 24;
const TEXTAREA_MIN_HEIGHT_PX = 42;
const TEXTAREA_PADDING_Y_PX = 8;
/** Growth stops after six lines of text; the textarea scrolls beyond that. */
const MAX_HEIGHT_PX = LINE_HEIGHT_PX * 6 + TEXTAREA_PADDING_Y_PX * 2;
/** Horizontal padding mirrored by the autocomplete overlay. */
const TEXTAREA_PADDING_X_PX = 16;
/** 录音时横跨整个输入区的音量柱数。 */
const VOICE_WAVE_BAR_COUNT = 56;

/**
 * A text input component with file attachment support and autocomplete functionality.
 *
 * @param root0 - The component props.
 * @param root0.onSend - Callback function to handle sending content blocks (incl. any slash commands).
 * @param root0.placeholder - Placeholder text for the input field.
 * @param root0.autoComplete - Function to provide autocomplete suggestions.
 * @param root0.disabled - Whether the input is disabled.
 * @param root0.className - Additional CSS classes for styling.
 * @returns A TextInput component.
 */
export const TextInput = forwardRef<TextInputRef, TextInputProps>(
	(
		{
			onSend,
			placeholder,
			notice,
			variant = 'default',
			autoComplete,
			disabled = false,
			className,
			allowedInputTypes,
			fileProcessor,
			phase = 'idle',
			autoFocus = true,
			onInterrupt,
			headerSlot,
			footerLeft,
			footerRight,
			commandItems,
		},
		ref,
	) => {
		const { t, i18n } = useTranslation();
		const { installed: catgirlInstalled } = useCatgirlSettings();
		const [catgirlDialog, setCatgirlDialog] = useState<'zh' | 'ja' | null>(null);
		const composing = useRef(false);
		const detectCatgirl = (text: string) => {
			const trigger = catgirlTrigger(text, i18n.language);
			if (!catgirlInstalled && trigger && !disabled) { setCatgirlDialog(trigger); return true; }
			return false;
		};
		const noticeId = useId();
		const defaultPlaceholder = placeholder || t('chat.inputPlaceholder');
		const [value, setValue] = useState('');
		const [files, setFiles] = useState<ProcessedFile[]>([]);
		const [isFocused, setIsFocused] = useState(false);
		const textareaRef = useRef<HTMLTextAreaElement>(null);
		// 语音录音/转写期间禁止文字输入（VAD 自动停止前输入框锁定）
		const [voiceBusy, setVoiceBusy] = useState(false);
		const [voiceRecording, setVoiceRecording] = useState(false);
		const voiceWaveformRef = useRef<HTMLDivElement>(null);
		const voiceWaveBarsRef = useRef<(HTMLSpanElement | null)[]>([]);
		const fileInputRef = useRef<HTMLInputElement>(null);

		// 录音组件逐帧回传 RMS 音量；仅改柱条 DOM，避免声音采样触发整块输入框重渲染。
		const updateVoiceWave = useCallback((level: number) => {
			const now = performance.now();
			voiceWaveformRef.current?.style.setProperty('--voice-energy', String(level));
			voiceWaveBarsRef.current.forEach((bar, index) => {
				if (!bar) return;
				// 用两层错相正弦形成不规则的呼吸感，音量越高，中心的扩散越明显。
				const center = 1 - Math.abs(index / (VOICE_WAVE_BAR_COUNT - 1) * 2 - 1);
				const wave = 0.5
					+ 0.3 * Math.sin(now / 118 + index * 0.57)
					+ 0.2 * Math.sin(now / 71 - index * 0.23);
				const scale = level <= 0
					? 0.06
					: Math.max(0.1, Math.min(1, 0.1 + level * wave * (0.48 + center * 1.02)));
				bar.style.transform = `scaleY(${scale})`;
				bar.style.opacity = String(level <= 0 ? 0 : 0.16 + level * (0.34 + center * 0.22));
			});
		}, []);

		// Derive the accept attribute for the hidden file input
		const acceptAttr =
			allowedInputTypes && allowedInputTypes.length > 0
				? allowedInputTypes.join(',')
				: undefined;

		// Attachment button is disabled when the model explicitly accepts no file types
		const attachDisabled =
			disabled || (allowedInputTypes !== undefined && allowedInputTypes.length === 0);

		// Whether any file is still being processed (block send until all done)
		const hasProcessing = files.some((f) => f.status === 'processing');

		// ─────── slash command menu state ───────
		// Selected items (skills / commands) attached to the message. Multi-select —
		// persisted across "/" toggles so the user can build up a list, see it as
		// a chip row above the textarea, then send with all of them at once.
		// `slashOpen` is derived rather than stored, so closing the menu is just a
		// matter of emptying the trigger character.
		const [selectedCommands, setSelectedCommands] = useState<SlashItem[]>([]);
		// Slash items are addressed by id; we keep a Set for O(1) membership tests
		// when rendering the row's checkbox state.
		const selectedIds = useMemo(
			() => new Set(selectedCommands.map((c) => c.id)),
			[selectedCommands],
		);
		// `slashOpen` is true exactly when the input starts with "/" and the user
		// hasn't dismissed the menu via Esc. The trigger sticks around as long as
		// value is "/..." so we get a transient filter UI for free.
		const slashOpen = commandItems !== undefined && value.startsWith('/');
		// Substring after the "/" — feeds the menu filter. Empty for "/" alone.
		const slashQuery = slashOpen ? value.slice(1) : '';
		const slashMenuRef = useRef<SlashCommandMenuHandle>(null);
		// Whether the textarea is *intentionally* in slash mode. Cleared on Esc
		// so the menu vanishes even though "/" is still in the input — without
		// this, pressing Esc would do nothing.
		const [slashDismissed, setSlashDismissed] = useState(false);
		// Effective open = trigger fires AND the user hasn't dismissed it.
		const slashMenuOpen = slashOpen && !slashDismissed;

		// 从浏览器面板「选择元素」投递来的元素引用：以 chip 附加，不占 textarea。
		// 发送时拼回内联文本（见 handleSend），对模型与历史消息保持纯文本可读。
		const [elementRefs, setElementRefs] = useState<ElementRef[]>([]);

		useImperativeHandle(ref, () => ({
			focus: () => textareaRef.current?.focus(),
		}));

		// 外部来源投递内容（浏览器面板等）：文本追加进输入框，页面元素转成
		// chip 附加。事件桥见 lib/insertChatText.ts —— 与 openPanel 同套路，
		// 跨组件不走 props。
		useEffect(() => {
			const onInsert = (e: Event) => {
				const text = (e as CustomEvent<{ text?: string }>).detail?.text;
				if (!text) return;
				setValue((prev) => (prev.trim() ? `${prev}\n${text}` : text));
				textareaRef.current?.focus();
			};
			const onElementRef = (e: Event) => {
				const ref = (e as CustomEvent<ElementRef>).detail;
				if (!ref?.selector) return;
				setElementRefs((prev) => [...prev, ref]);
				textareaRef.current?.focus();
			};
			window.addEventListener(INSERT_CHAT_TEXT_EVENT, onInsert);
			window.addEventListener(INSERT_ELEMENT_REF_EVENT, onElementRef);
			return () => {
				window.removeEventListener(INSERT_CHAT_TEXT_EVENT, onInsert);
				window.removeEventListener(INSERT_ELEMENT_REF_EVENT, onElementRef);
			};
		}, []);

		// Grow the textarea with its content. The ``auto`` reset is what lets it
		// shrink again — ``scrollHeight`` never reports less than the current height.
		useLayoutEffect(() => {
			const textarea = textareaRef.current;
			if (!textarea) return;
			textarea.style.height = 'auto';
			textarea.style.height = `${textarea.scrollHeight}px`;
			if (variant === 'capsule') {
				textarea.closest<HTMLElement>('.composer-shell')?.style.setProperty('--capsule-radius', textarea.scrollHeight > TEXTAREA_MIN_HEIGHT_PX ? '24px' : '9999px');
			}
		}, [value, variant]);

		// Calculate autocomplete suggestion using useMemo
		const suggestion = useMemo(() => {
			if (autoComplete && value && isFocused) {
				const result = autoComplete(value);
				// Only return the part after the cursor
				if (result && result.startsWith(value)) {
					return result.substring(value.length);
				}
				return result || '';
			}
			return '';
		}, [value, autoComplete, isFocused]);

		// ─────── slash command handlers ───────
		/**
		 * Toggle a command in/out of the selection.
		 * Click hits here from the menu row, but the menu owns its own visual
		 * state — we only carry the canonical list so both ends agree.
		 */
		const handleToggleCommand = useCallback((id: string) => {
			// A slash command is a prompt *template*, so picking one splices its
			// body into the composer for the user to edit — unlike a skill, which
			// is attached as a chip and whose body the agent loads itself. Two
			// kinds of row, two kinds of outcome; hence the early return.
			const picked = (commandItems ?? []).find((c) => c.id === id);
			if (picked?.kind === 'command') {
				setValue(picked.body ?? '');
				setSlashDismissed(true);
				textareaRef.current?.focus();
				return;
			}
			setSelectedCommands((prev) => {
				const idx = prev.findIndex((c) => c.id === id);
				if (idx >= 0) {
					const next = prev.slice();
					next.splice(idx, 1);
					return next;
				}
				const item = (commandItems ?? []).find((c) => c.id === id);
				return item ? [...prev, item] : prev;
			});
		}, [commandItems]);

		/** Click-X on a chip; identical semantics to a row toggle. */
		const handleRemoveCommand = useCallback(
			(id: string) => handleToggleCommand(id),
			[handleToggleCommand],
		);

		/** Click-X on an element chip; chips are identified by position. */
		const handleRemoveElement = useCallback((index: number) => {
			setElementRefs((prev) => prev.filter((_, i) => i !== index));
		}, []);

		/**
		 * Close the menu explicitly (click X / footer enter / outside-click).
		 * We wipe "/..." so the trigger character doesn't leak into the user
		 * message text. Selecting chips is unaffected — those live on a separate
		 * state axis.
		 */
		const handleCloseSlashMenu = useCallback(() => {
			setValue('');
			setSlashDismissed(false);
		}, []);

		const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
			// Tab key to select autocomplete
			if (e.key === 'Tab' && suggestion) {
				e.preventDefault();
				setValue(value + suggestion);
				return;
			}

			// Slash menu: Esc closes (but keeps selections).
			if (e.key === 'Escape' && slashMenuOpen) {
				e.preventDefault();
				handleCloseSlashMenu();
				return;
			}

			// Slash menu is open: ArrowUp/Down navigate, Enter picks highlighted,
			// Space toggles without closing. None of these bubble to send.
			if (slashMenuOpen) {
				if (e.key === 'ArrowDown') {
					e.preventDefault();
					slashMenuRef.current?.step(1);
					return;
				}
				if (e.key === 'ArrowUp') {
					e.preventDefault();
					slashMenuRef.current?.step(-1);
					return;
				}
				if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
					// Enter with text typed (a filter in progress) toggles the
					// highlighted row — Esc/click outside still commits by clearing.
					// Without text, a totally empty / (no filter) on Enter does a
					// no-op, since the menu only contains unknown-target rows.
					const hid = slashMenuRef.current?.highlightedId();
					if (hid) {
						e.preventDefault();
						handleToggleCommand(hid);
						return;
					}
				}
			}

			// Enter to send message, Shift+Enter for new line. We do NOT send
			// while the slash menu is open and no row is highlighted (let the user
			// keep typing the filter).
			if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
				e.preventDefault();
				handleSend();
			}

			// Backspace at an empty input pops the last chip — like an inbox chip
			// row. Without this, removing a chip requires precise mouse movement.
			// Element chips are popped first: they're the more transient kind.
			if (e.key === 'Backspace' && value === '') {
				if (elementRefs.length > 0) {
					e.preventDefault();
					setElementRefs((prev) => prev.slice(0, -1));
				} else if (selectedCommands.length > 0) {
					e.preventDefault();
					setSelectedCommands((prev) => prev.slice(0, -1));
				}
			}
		};

		const handleSend = () => {
			if (composing.current || catgirlDialog || detectCatgirl(value)) return;
			// While the slash menu is showing, the leading "/" is a command trigger,
			// not message content. Sending with the menu still open (clicking the
			// button instead of pressing Esc) used to leak a bare "/" into the
			// user's message. Strip the trigger and keep whatever filter text
			// followed it.
			const inputText = slashMenuOpen ? value.slice(1).trim() : value.trim();
			const hasText = inputText.length > 0;
			const hasSkills = selectedCommands.length > 0;
			const hasElements = elementRefs.length > 0;

			// ``phase`` is guarded here rather than only on the button, since Enter
			// calls this directly and would otherwise send during a running reply.
			// The skills-only case must be allowed too: the button already enables
			// itself when chips are attached, so bailing on `!value.trim()` here
			// made Enter (and the button) silently do nothing.
			if (phase !== 'idle' || (!hasText && !hasSkills && !hasElements) || disabled || hasProcessing) return;

			const blocks: ContentBlock[] = [];

			// Add text block: element chips flatten back into inline lines ahead of
			// the typed text, so the model and the history both see plain text.
			const elementLines = elementRefs.map((ref) =>
				t('textInput.elementRefLine', { selector: ref.selector }),
			);
			const composed = [...elementLines, inputText].filter(Boolean).join('\n');
			if (composed) {
				const textBlock: TextBlock = {
					id: crypto.randomUUID(),
					type: 'text',
					text: composed,
					created_at: new Date().toISOString(),
					finished_at: new Date().toISOString(),
				};
				blocks.push(textBlock);
			}

			// Add processed file blocks (skip errored ones)
			files.forEach((f) => {
				if (f.status === 'done' && f.block) {
					blocks.push(f.block);
				}
			});

			// Skills with no typed text: hand the model one sentence to anchor on.
			// An entirely empty user turn trips some providers, and an empty
			// bubble reads like a bug. Only reached when there is no text and no
			// attachment either.
			if (blocks.length === 0 && hasSkills) {
				blocks.push({
					id: crypto.randomUUID(),
					type: 'text',
					text: t('textInput.skillOnlyPrompt'),
					created_at: new Date().toISOString(),
					finished_at: new Date().toISOString(),
				});
			}

			// Pass selection alongside blocks: the parent merges commands into
			// the LLM-side context and renders the visible chip row above the
			// user bubble. Empty ``[]`` is fine — the parent treats absence and
			// zero-length the same.
			onSend?.(blocks, selectedCommands);
			setValue('');
			setFiles([]);
			setSelectedCommands([]);
			setElementRefs([]);
		};

		/**
		 * Send / stop button configuration derived from the current reply
		 * phase. One struct = one branch of rendering, so the JSX stays flat.
		 * Stop gets its own neutral identity (vs. the brand-purple send
		 * button) with a filled square glyph — a thin stroked icon reads too
		 * weak for such a high-stakes action.
		 */
		const sendButton: {
			mode: 'send' | 'stop' | 'stopping';
			tooltip: string;
			disabled: boolean;
			onClick: (() => void) | undefined;
		} = (() => {
			if (phase === 'streaming') {
				return {
					mode: 'stop',
					tooltip: t('textInput.stop'),
					disabled: false,
					onClick: onInterrupt,
				};
			}
			if (phase === 'interrupting') {
				return {
					mode: 'stopping',
					tooltip: t('textInput.stopping'),
					disabled: true,
					onClick: onInterrupt,
				};
			}
			return {
				mode: 'send',
				tooltip: selectedCommands.length > 0 && !value.trim()
					? t('textInput.sendWithSkills', { count: selectedCommands.length })
					: t('textInput.send'),
				// Allow send when only commands or element chips are attached —
				// chips with no text is a real use case (e.g. pick a button in the
				// browser, then just say "make it rounder").
				disabled:
					disabled || hasProcessing
					|| (!value.trim() && selectedCommands.length === 0 && elementRefs.length === 0),
				onClick: handleSend,
			};
		})();

		const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
			if (!e.target.files) return;
			const selected = Array.from(e.target.files);
			// Reset input value so the same file can be re-selected
			e.target.value = '';

			selected.forEach((file) => {
				// Insert a placeholder in processing state
					const placeholder: ProcessedFile = {
					name: file.name,
					status: 'processing',
					block: null,
				};

				setFiles((prev) => [...prev, placeholder]);

				fileProcessor(file)
					.then((block) => {
						setFiles(
							(prev) =>
								prev
									.map((f) =>
										f === placeholder
											? block
												? { ...f, status: 'done', block }
												: null
											: f,
									)
									.filter(Boolean) as ProcessedFile[],
						);
					})
					.catch(() => {
						// Caller is responsible for error notification (e.g. toast).
						// Just silently remove the entry here.
						setFiles((prev) =>
							prev.filter(
								(f) => f !== placeholder,
							),
						);
					});
			});
		};

		return (
			<div className={cn('flex flex-col', className)}>
				{headerSlot}
				{/* Selected-skill chip row — between headerSlot and the input pill.
				    Empty → null. */}
				{selectedCommands.length > 0 && (
					<div
						className="mb-1.5 flex flex-wrap gap-1.5 px-2 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-fast"
						aria-label={t('textInput.selectedSkills')}
					>
						{selectedCommands.map((c) => (
							<Badge
								key={c.id}
								variant="glass"
								className="h-7 gap-1 rounded-rect pl-1 pr-1.5 text-[12px]"
							>
								<Avatar className="size-5 rounded">
									<AvatarImage src={c.icon_url ?? undefined} alt={c.display_name || c.name} loading="lazy" />
									<AvatarFallback className="rounded text-[10px]">
										{(c.display_name || c.name).slice(0, 1).toUpperCase()}
									</AvatarFallback>
								</Avatar>
								<Sparkles className="size-3 text-primary" />
								<span className="font-medium">{c.display_name || c.name}</span>
								<button
									type="button"
									onClick={() => handleRemoveCommand(c.id)}
									aria-label={t('textInput.removeSkill', { name: c.display_name || c.name })}
									className="-mr-1 ml-0.5 flex size-5 items-center justify-center rounded-rect-sm text-muted-foreground hover:bg-surface-muted hover:text-foreground motion-safe:transition-colors"
								>
									<XIcon className="size-3" />
								</button>
							</Badge>
						))}
					</div>
				)}
				{/* Referenced-element chip row (picked in the browser panel).
				    Empty → null. Hovering shows the full selector + text summary. */}
				{elementRefs.length > 0 && (
					<div
						className="mb-1.5 flex flex-wrap gap-1.5 px-2 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-fast"
						aria-label={t('textInput.selectedElements')}
					>
						{elementRefs.map((ref, index) => (
							<Tooltip key={`${ref.selector}:${index}`}>
								<TooltipTrigger asChild>
									<Badge variant="glass" className="h-7 gap-1 rounded-rect pl-1.5 pr-1 text-[12px]">
										<MousePointer2 className="size-3 text-primary" />
										<span className="font-medium">{ref.tag}</span>
										<button
											type="button"
											onClick={() => handleRemoveElement(index)}
											aria-label={t('textInput.removeElement', { tag: ref.tag })}
											className="-mr-1 ml-0.5 flex size-5 items-center justify-center rounded-rect-sm text-muted-foreground hover:bg-surface-muted hover:text-foreground motion-safe:transition-colors"
										>
											<XIcon className="size-3" />
										</button>
									</Badge>
								</TooltipTrigger>
								<TooltipContent className="max-w-72">
									<p className="break-all font-mono text-xs">{ref.selector}</p>
									{ref.text ? (
										<p className="mt-0.5 truncate text-xs text-muted-foreground">{ref.text}</p>
									) : null}
								</TooltipContent>
							</Tooltip>
						))}
					</div>
				)}
				<div
					id="tour-chat-input"
					className={cn(
						'composer-shell relative z-10 flex w-full flex-col rounded-[24px] border border-border bg-background px-2 pb-2 pt-2',
						selectedCommands.length > 0 || elementRefs.length > 0 ? 'mt-2' : headerSlot ? '-mt-5' : '',
					)}
					data-tour="chat-input"
					data-composer-variant={variant}
					data-has-attachments={files.length > 0 ? 'true' : undefined}
				>
					{/* 声波只占上方文字区；底部操作按钮始终清晰可点。 */}
					{voiceRecording && (
						<div
							ref={voiceWaveformRef}
							className="voice-waveform pointer-events-none absolute left-5 right-5 top-2 z-0 flex h-7 items-center justify-between gap-[3px] overflow-hidden px-2"
							aria-hidden
						>
							{Array.from({ length: VOICE_WAVE_BAR_COUNT }, (_, index) => (
								<span
									key={index}
									ref={(element) => {
										voiceWaveBarsRef.current[index] = element;
									}}
									className="voice-wave-bar h-6 w-px shrink-0 origin-center rounded-[1px] bg-foreground text-foreground will-change-transform"
									style={{ transform: 'scaleY(0.08)', opacity: 0 }}
								/>
							))}
						</div>
					)}
					{files.length > 0 && (
						<AttachmentGroup className={'w-full max-w-full px-1 mt-1'}>
							{files.map((file, index) => {
								const isImage =
									file.block &&
									file.block.type === 'data' &&
									file.block.source.media_type.startsWith('image/');
								let data: undefined | string;
								if (file.block && file.block.type === 'data') {
									const block = file.block;
									data =
										block.source.type === 'url'
											? block.source.url
											: `data:${block.source.media_type};base64,${block.source.data}`;
								}

								return (
									<Attachment>
										<AttachmentMedia variant={isImage ? 'image' : 'icon'}>
											{file.status === 'processing' ? (
												<Loader2 className="size-3 shrink-0 animate-spin" />
											) : isImage ? (
												<img src={data} alt={file.name} />
											) : (
												<FileText className="size-3" />
											)}
										</AttachmentMedia>
										<AttachmentContent>
											<AttachmentTitle>{file.name}</AttachmentTitle>
											<AttachmentDescription>
												{file.status === 'processing'
													? t('common.uploading')
													: (
															mime.getExtension(
																mime.getType(file.name) || 'bin',
															) || 'bin'
														).toUpperCase()}
											</AttachmentDescription>
										</AttachmentContent>
										<AttachmentActions>
											<AttachmentAction
												onClick={() =>
													setFiles(files.filter((_, i) => i !== index))
												}
											>
												<XIcon />
											</AttachmentAction>
										</AttachmentActions>
									</Attachment>
								);
							})}
						</AttachmentGroup>
					)}

					{notice && <p id={noticeId} role="status" className="px-6 pb-2 pt-3 text-sm leading-6 text-muted-foreground">{notice}</p>}
					<div className="composer-body relative z-10 flex min-w-0 flex-col">
						<div className="composer-editor relative min-w-0">
							{/* ``block`` — inline-block would sit on the text baseline and
							    leave a descender gap that makes the wrapper taller. */}
							<textarea
								id="tour-chat-textarea"
								ref={textareaRef}
								value={value}
								onChange={(e) => { setValue(e.target.value); if (!composing.current) detectCatgirl(e.target.value); }}
								onCompositionStart={() => { composing.current = true; }}
								onCompositionEnd={e => { composing.current = false; detectCatgirl(e.currentTarget.value); }}
								onKeyDown={handleKeyDown}
								onFocus={() => setIsFocused(true)}
								onBlur={() => setIsFocused(false)}
								placeholder={voiceBusy || notice ? '' : defaultPlaceholder}
								aria-label={t('chat.inputPlaceholder')}
								aria-describedby={notice ? noticeId : undefined}
								disabled={disabled || voiceBusy}
								rows={1}
								className={cn(notice && !value ? 'hidden' : 'block', 'w-full resize-none border-0 bg-transparent text-base outline-none placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-70')}
								style={{
									minHeight: `${variant === 'capsule' ? 40 : TEXTAREA_MIN_HEIGHT_PX}px`,
									maxHeight: `${MAX_HEIGHT_PX}px`,
									lineHeight: `${LINE_HEIGHT_PX}px`,
									paddingLeft: `${variant === 'capsule' ? 8 : TEXTAREA_PADDING_X_PX}px`,
									paddingRight: `${variant === 'capsule' ? 8 : TEXTAREA_PADDING_X_PX}px`,
									paddingTop: `${TEXTAREA_PADDING_Y_PX}px`,
									paddingBottom: `${TEXTAREA_PADDING_Y_PX}px`,
									overflowY: 'auto',
								}}
								autoFocus={autoFocus}
							/>

							{/* Autocomplete overlay — its padding and line-height mirror the
							    textarea's, or the suggestion drifts off the real text. */}
							{suggestion && isFocused && (
								<div
									className="pointer-events-none absolute left-0 top-0 text-base"
									style={{
										lineHeight: `${LINE_HEIGHT_PX}px`,
										paddingLeft: `${variant === 'capsule' ? 8 : TEXTAREA_PADDING_X_PX}px`,
										paddingRight: `${variant === 'capsule' ? 8 : TEXTAREA_PADDING_X_PX}px`,
										paddingTop: `${TEXTAREA_PADDING_Y_PX}px`,
										paddingBottom: `${TEXTAREA_PADDING_Y_PX}px`,
										whiteSpace: 'pre-wrap',
										wordWrap: 'break-word',
									}}
								>
									{/* Invisible input text */}
									<span className="invisible">{value}</span>
									{/* Suggestion text */}
									<span className="text-muted-foreground">{suggestion}</span>
									{/* Tab hint */}
									<span className="ml-2 text-xs text-muted-foreground">
										<Kbd>Tab</Kbd> {t('textInput.toComplete')}
									</span>
								</div>
							)}
						</div>

						<div className="composer-controls relative z-10 flex min-w-0 items-center justify-between gap-2 px-1 pb-1">
							<div className="composer-leading-controls flex min-w-0 items-center gap-1">
								<Tooltip>
									<TooltipTrigger asChild>
										<Button type="button" variant="ghost" size="icon-lg" aria-label={t('textInput.attach')}
											onClick={() => fileInputRef.current?.click()} disabled={attachDisabled} className="shrink-0 rounded-rect">
											<Plus className="size-5" />
										</Button>
									</TooltipTrigger>
									<TooltipContent>{attachDisabled && allowedInputTypes?.length === 0 ? t('textInput.attachNotSupported') : t('textInput.attach')}</TooltipContent>
								</Tooltip>
								{footerLeft}
							</div>
							<div className="composer-trailing-controls flex min-w-0 items-center justify-end gap-1.5">
								{footerRight}
								<VoiceRecorder
									className="rounded-full"
									disabled={disabled}
									onBusyChange={setVoiceBusy}
									onRecordingChange={setVoiceRecording}
									onAudioLevelChange={updateVoiceWave}
									onTranscript={(text) => {
										setValue((prev) => (prev.trim() ? `${prev} ${text}` : text));
										textareaRef.current?.focus();
									}}
								/>
								<Tooltip>
									<TooltipTrigger asChild>
										{sendButton.mode === 'send' ? (
											<Button id="tour-send-button" type="button" onClick={sendButton.onClick}
												disabled={sendButton.disabled} size="icon-lg" aria-label={sendButton.tooltip}
												className="btn-brand size-[30px] shrink-0 rounded-full border-0">
												<ArrowUp className="size-4" />
											</Button>
										) : (
											<Button type="button" onClick={sendButton.onClick} disabled={sendButton.disabled}
												size="icon-lg" aria-label={sendButton.tooltip}
												className={cn('size-[30px] shrink-0 rounded-full border-0 bg-foreground text-background',
													'hover:scale-105 active:scale-95', sendButton.mode === 'stopping' && 'animate-pulse opacity-80')}>
												<span className="block size-3 rounded-[3px] bg-current" aria-hidden />
											</Button>
										)}
									</TooltipTrigger>
									<TooltipContent>{sendButton.tooltip}</TooltipContent>
								</Tooltip>
							</div>
							<input ref={fileInputRef} type="file" multiple accept={acceptAttr} onChange={handleFileSelect} className="hidden" />
						</div>
					</div>

				</div>

					{catgirlDialog && <CatgirlPackDialog language={catgirlDialog}
						onClose={() => setCatgirlDialog(null)}
						onAdded={() => { setValue(''); setCatgirlDialog(null); }} />}
					{/* Slash command menu — anchored ``absolute bottom-full`` so it floats *above*
					    the pill. Only mounts when there's something to show. */}
					{commandItems && commandItems.length > 0 && (
						<SlashCommandMenu
						ref={slashMenuRef}
						open={slashMenuOpen}
						items={commandItems}
						query={slashQuery}
						selectedIds={selectedIds}
						onToggle={handleToggleCommand}
						onConfirm={handleCloseSlashMenu}
						onClose={handleCloseSlashMenu}
						/>
					)}
				</div>
		);
	},
);

TextInput.displayName = 'TextInput';
