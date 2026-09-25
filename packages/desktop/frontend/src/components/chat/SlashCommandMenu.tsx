import { Check, Command, Sparkles, XIcon, Zap } from 'lucide-react';
import {
	Fragment,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from 'react';
import { forwardRef } from 'react';

import type { SkillView, UserCommand } from '@/api';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import i18n from '@/i18n';
import { useTranslation } from '@/i18n/useI18n';
import { cn } from '@/lib/utils';

/**
 * One entry in the slash command menu. The shape matches {@link SkillView}
 * so that callers can pass `useSkills().skills` directly without remapping,
 * but the type is intentionally narrow — the menu only needs id + name +
 * description, and any field a skill has stays opaque.
 */
export interface SlashItem {
	id: string;
	name: string;
	display_name?: string | null;
	description?: string;
	/** SkillHub's Chinese blurb — searched alongside `description`. */
	description_zh?: string | null;
	tags?: string[];
	icon_url?: string | null;
	/**
	 * What picking this row does.
	 *
	 * `skill` (default) — attach it to the message as a chip; the agent
	 * loads the skill's body itself.
	 * `command` — splice its `body` into the composer as prompt text. A
	 * slash command *is* a prompt template (`/review` → "审查这段改动，
	 * 关注…"), so the user is expected to edit it before sending. That
	 * difference is why the two kinds render differently.
	 */
	kind?: 'skill' | 'command';
	/** Prompt body for `kind: 'command'`. */
	body?: string;
	/** e.g. `[文件路径]` — shown after the name so the user knows what to type. */
	argument_hint?: string;
}

export interface SlashCommandMenuProps {
	open: boolean;
	/** All candidate items. Filter is applied client-side against `query`. */
	items: SlashItem[];
	/** Substring filter; "" → show all. */
	query: string;
	/** Currently selected ids (multi-select). */
	selectedIds: Set<string>;
	onToggle: (id: string) => void;
	/** Fired when the user wants to commit their selection (Enter / click outside). */
	onConfirm?: () => void;
	/** Fired when the menu dismisses without changes (Esc). */
	onDismiss?: () => void;
	/** Fired when the user wants to close the menu (click outside). */
	onClose: () => void;
}

export interface SlashCommandMenuHandle {
	/** Move the keyboard selection by +1 or -1 within the filtered list. */
	step: (delta: number) => void;
	/** Returns the currently highlighted item's id, or null. */
	highlightedId: () => string | null;
	/** Programmatic close — used by Escape from the parent. */
	close: () => void;
}

const MAX_VISIBLE = 8;

/**
 * Two-axis popover:
 *
 *   ╔══════════════════════════════════════╗
 *   ║ 已选 (2)   [Clear]                  ║   ← header with selection count
 *   ╟──────────────────────────────────────╢
 *   ║ ☐  • AI review code           代码审查 ║   ← row, multi-select
 *   ║ ☐    self-improving agent    [DEV]   ║   ← tags, selection marks
 *   ║ ☑    pdf-reader                   ⏎  ║
 *   ║ ☑  • commit-message helper        ⏎  ║
 *   ╚══════════════════════════════════════╝
 *
 * Multi-select is the primary affordance. Click anywhere on the row to toggle
 * (not just the checkbox) — most users will discover the toggle by clicking.
 * Space and Enter both toggle; ArrowUp/Down move focus; Escape closes.
 *
 * The host (TextInput) decides when to display this menu: it only renders
 * when the user has typed `/` at the start of an otherwise empty input.
 */
export const SlashCommandMenu = forwardRef<SlashCommandMenuHandle, SlashCommandMenuProps>(
	({ open, items, query, selectedIds, onToggle, onConfirm, onDismiss, onClose }, ref) => {
		const { t } = useTranslation();

		const filtered = useMemo(() => {
			const q = query.trim().toLowerCase();
			if (!q) return items;
			return items.filter((it) => {
				const hay = [
					it.name,
					it.display_name ?? '',
					it.description ?? '',
					it.description_zh ?? '',
					...(it.tags ?? []),
				]
					.join(' ')
					.toLowerCase();
				return hay.includes(q);
			});
		}, [items, query]);

		// The visible slice — the rows beyond the fold exist but aren't
		// keyboard-navigable. Empty state jumps to the headline copy.
		const visible = filtered.slice(0, MAX_VISIBLE);

		const [highlight, setHighlight] = useState(0);

		// Reset highlight as the filtered list shrinks / grows. ``length`` is
		// included in the deps because filter changes the *count*, not just the
		// order; clamped because the previous index can exceed the new length.
		useEffect(() => {
			setHighlight((h) => Math.min(Math.max(h, 0), Math.max(filtered.length - 1, 0)));
		}, [filtered.length, query]);

		const highlightId = useCallback(
			() => (visible[highlight] ? visible[highlight].id : null),
			[visible, highlight],
		);

		useImperativeHandle(
			ref,
			() => ({
				step: (delta) => {
					if (visible.length === 0) return;
					setHighlight((h) => (h + delta + visible.length) % visible.length);
				},
				highlightedId: highlightId,
				close: () => onClose(),
			}),
			[visible, highlightId, onClose],
		);

		// Dismiss-when-empty: if the parent clears its open flag while a
		// pending selection existed, propagate the closure so the parent can
		// drop the highlight state cleanly. Without this, clicking outside
		// looks like a no-op to the user.
		const prevOpenRef = useRef(open);
		useEffect(() => {
			if (prevOpenRef.current && !open) onDismiss?.();
			prevOpenRef.current = open;
		}, [open, onDismiss]);

		if (!open) return null;

		return (
			<div
				role="listbox"
				aria-label={t('textInput.slashMenu.selectedLabel')}
				aria-multiselectable="true"
				className={cn(
					'absolute left-0 right-0 bottom-full mb-2 z-50',
					// Glass card: matches the input pill aesthetic so the menu
					// reads as part of the input surface, not a separate dialog.
					'overflow-hidden rounded-2xl border bg-popover shadow-xl',
					'text-popover-foreground',
				)}
				// Pointer-down stops the parent textarea's blur handler from
				// firing prematurely on row clicks.
				onPointerDown={(e) => e.preventDefault()}
			>
				<SlashMenuHeader
					count={selectedIds.size}
					onClear={() => {
						for (const id of Array.from(selectedIds)) onToggle(id);
					}}
					onClose={() => onClose()}
				/>

				{filtered.length === 0 ? (
					<div className="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
						<Sparkles className="size-3.5" />
						<span>
							{query
								? t('textInput.slashMenu.emptyQuery', { query })
								: t('textInput.slashMenu.empty')}
						</span>
					</div>
				) : (
					<ul
						className="max-h-[calc(8_*_36px_+_8px)] overflow-y-auto py-1"
						role="presentation"
					>
						{visible.map((item, idx) => (
							<Fragment key={item.id}>
								{/* One heading where commands end and skills begin. Only
								    drawn when both kinds are present — with a single kind
								    a heading would just be a line with no counterpart. */}
								{idx > 0 &&
								visible[idx - 1].kind === 'command' &&
								item.kind !== 'command' ? (
									<li className="border-t px-3 pt-2 pb-1 text-[11px] text-muted-foreground">
										{t('common.skill-hub')}
									</li>
								) : null}
								<SlashRow
									item={item}
									selected={selectedIds.has(item.id)}
									highlighted={highlight === idx}
									onToggle={() => onToggle(item.id)}
								/>
							</Fragment>
						))}
						{filtered.length > MAX_VISIBLE && (
							<li className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
								{t('textInput.slashMenu.moreMatches', { count: filtered.length - MAX_VISIBLE })}
							</li>
						)}
					</ul>
				)}

				<SlashMenuFooter
					onConfirm={onConfirm}
					selectedCount={selectedIds.size}
					highlightedId={highlightId()}
				/>
			</div>
		);
	},
);

SlashCommandMenu.displayName = 'SlashCommandMenu';

// ───────────────────── Subcomponents ─────────────────────

function SlashMenuHeader({
	count,
	onClear,
	onClose,
}: {
	count: number;
	onClear: () => void;
	onClose: () => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex items-center justify-between border-b px-3 py-2 text-xs">
			<div className="flex items-center gap-2 text-muted-foreground">
				<Command className="size-3.5" />
				<span>
					{t('textInput.slashMenu.selectedLabel')}{' '}
					<Badge variant="glass" className="px-1.5 text-[10px]">
						{count}
					</Badge>{' '}
					/ {count > 0 ? t('textInput.slashMenu.hintSend') : t('textInput.slashMenu.hintSelect')}
				</span>
			</div>
			<div className="flex items-center gap-1">
				{count > 0 && (
					<button
						type="button"
						onClick={onClear}
						className="rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-surface-muted hover:text-foreground text-[11px] motion-safe:transition-colors"
					>
						{t('textInput.slashMenu.clear')}
					</button>
				)}
				<button
					type="button"
					onClick={onClose}
					className="rounded-md p-0.5 text-muted-foreground hover:bg-surface-muted hover:text-foreground motion-safe:transition-colors"
					aria-label={t('textInput.slashMenu.close')}
				>
					<XIcon className="size-3" />
				</button>
			</div>
		</div>
		);
}

function SlashRow({
	item,
	selected,
	highlighted,
	onToggle,
}: {
	item: SlashItem;
	selected: boolean;
	highlighted: boolean;
	onToggle: () => void;
}) {
	const label = item.display_name || item.name;
	const isCommand = item.kind === 'command';
	return (
		<li>
			<button
				type="button"
				role="option"
				aria-selected={selected}
				onClick={onToggle}
				className={cn(
					'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm',
					'motion-safe:transition-colors',
					highlighted ? 'bg-surface-muted' : 'hover:bg-surface-muted',
					selected && 'bg-primary-soft',
				)}
			>
				{/* Commands are one-shot (they fill the composer), so a checkbox
			    would promise a persistable selection that does not exist. */}
				{isCommand ? (
					<span className="flex size-4 shrink-0 items-center justify-center rounded border border-dashed text-[10px] text-muted-foreground">
						/
					</span>
				) : (
					<span
						className={cn(
							'flex size-4 shrink-0 items-center justify-center rounded border',
							selected
								? 'border-primary bg-primary text-primary-foreground'
								: 'border-border bg-background',
						)}
					>
						{selected && <Check className="size-2.5" strokeWidth={3} />}
					</span>
				)}
				<Avatar className="size-5 rounded">
					<AvatarImage src={item.icon_url ?? undefined} alt={label} loading="lazy" />
					<AvatarFallback className="rounded text-[10px] font-medium">
						{label.slice(0, 1).toUpperCase()}
					</AvatarFallback>
				</Avatar>
				<span className="min-w-0 flex-1 truncate font-medium">{label}</span>
				{/* The hint is what the template expects in place of $ARGUMENTS —
				    e.g. `/review [文件路径]`, so the user knows what to type next. */}
				{isCommand && item.argument_hint ? (
					<span className="shrink-0 font-mono text-[11px] text-muted-foreground">
						{item.argument_hint}
					</span>
				) : null}
				{item.tags && item.tags.length > 0 && (
					<Badge
						variant="secondary"
						className="px-1.5 py-0 text-[10px] font-normal text-text-tertiary"
					>
						{item.tags[0]}
					</Badge>
				)}
				{/* Right-edge cue: shows when the row currently holds keyboard focus. */}
				{highlighted && <Zap className="size-3 text-primary" />}
			</button>
		</li>
	);
}

function SlashMenuFooter({
	onConfirm,
	selectedCount,
	highlightedId,
}: {
	onConfirm?: () => void;
	selectedCount: number;
	highlightedId: string | null;
}) {
	const { t } = useTranslation();
	return (
		<div
			className="flex items-center justify-between border-t bg-surface-muted px-3 py-1.5 text-[11px] text-muted-foreground"
			onClick={() => onConfirm?.()}
			role="presentation"
		>
			<span>
				{selectedCount > 0 ? (
					<>
						<span className="text-foreground font-medium">
							{t('textInput.slashMenu.selectedCount', { count: selectedCount })}
						</span>
						{highlightedId && (
							<>
								{' · '}
								<span className="text-text-tertiary">
									{t('textInput.slashMenu.keyboardHighlight')}
								</span>
							</>
						)}
					</>
				) : (
					t('textInput.slashMenu.clickToMulti')
				)}
			</span>
			<span className="font-mono">⏎</span>
		</div>
		);
}

/**
 * Convenience adapter — narrows `SkillView[]` to `SlashItem[]` so callers don't
 * have to remap when passing the user's installed skills straight in.
 */
/**
 * Adapts user-authored slash commands into menu rows.
 *
 * Ids are prefixed so a command and a skill can share a name without
 * colliding in the selection set (the menu keys rows by id).
 *
 * @param commands - Commands discovered in `~/.cocode/commands` and
 *   `<cwd>/.cocode/commands`, project-level overriding user-level.
 * @returns Rows, in the order given (the composer sorts them first).
 */
export function commandsToSlashItems(commands: UserCommand[]): SlashItem[] {
	return commands.map((c) => ({
		id: `cmd:${c.name}`,
		name: c.name,
		display_name: `/${c.name}`,
		description: c.description,
		argument_hint: c.argument_hint || '',
		body: c.body,
		kind: 'command',
		tags: [c.source === 'project' ? (i18n.language.startsWith('zh') ? '项目' : 'Project') : (i18n.language.startsWith('zh') ? '用户' : 'User')],
	}));
}

export function fromLibrary(skills: SkillView[]): SlashItem[] {
	return skills.map((s) => ({
		id: s.id,
		name: s.name,
		display_name: s.display_name,
		description: s.description,
		description_zh: s.description_zh,
		tags: s.tags,
		icon_url: s.icon_url,
	}));
}
