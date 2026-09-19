import {
	Blocks,
	Check,
	Download,
	FolderUp,
	Plug,
	Sparkles,
	Trash2,
	TriangleAlert,
	X,
} from 'lucide-react';
import { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import type { HubCategory, HubInfo, ResolvedSkill, SkillCard, SkillResolveResult, SkillView } from '@/api';
import { hubApi, skillApi } from '@/api';
import { ApiError } from '@/api/client';
import { ResourceDetailDrawer } from '@/components/drawer/ResourceDetailDrawer.tsx';
import { LoadMore } from '@/components/hub/LoadMore.tsx';
import { ResourcePanel } from '@/components/hub/ResourcePanel.tsx';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@/components/ui/empty.tsx';
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from '@/components/ui/item.tsx';
import {
	Sidebar,
	SidebarContent,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from '@/components/ui/sidebar.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { useHubCategories } from '@/hooks/useHubCategories.ts';
import { useResourceDrawer } from '@/hooks/useResourceDrawer.ts';
import { useSkillHubCards } from '@/hooks/useSkillHubCards.ts';
import { useSkillHubs } from '@/hooks/useSkillHubs.ts';
import { useSkills } from '@/hooks/useSkills.ts';
import { useTranslation } from '@/i18n/useI18n';
import { categoryLabel, skillDescription } from '@/lib/skillText';
import { cn } from '@/lib/utils';
import { avatarTint, formatTime } from '@/utils/common';

interface CardItemProps {
	card: SkillCard;
	installed: boolean;
	installing: boolean;
	/** "Now" in epoch seconds, pinned by the panel so every row in a
	 *  render agrees and the age does not shift on unrelated re-renders. */
	now: number;
	onInstall: () => void;
	onOpen: () => void;
}

function CardItem({ card, installed, installing, now, onInstall, onOpen }: CardItemProps) {
	const { t } = useTranslation();

	return (
		<Item
			className={cn(
				'cursor-pointer items-start rounded-none border-l-2 py-[13px] pr-[18px] pl-4 hover:bg-row-hover',
				// The left rule is the "installed" marker. Only the icon
				// dims with it — fading the whole row would drop the
				// description to a 2.4:1 contrast ratio.
				installed ? 'border-l-foreground' : 'border-l-transparent',
			)}
			onClick={onOpen}
		>
			<ItemMedia className={cn('translate-y-0', installed && '')}>
				<Avatar className="rounded-md">
					<AvatarImage
						src={card.icon_url ?? undefined}
						alt={card.display_name || card.name}
						loading="lazy"
					/>
					<AvatarFallback className="rounded-md" style={avatarTint(card.name)}>
						{(card.display_name || card.name).slice(0, 1).toUpperCase()}
					</AvatarFallback>
				</Avatar>
			</ItemMedia>

			<ItemContent>
				{/* Name, author, tags — each step lighter than the last, so
				    the eye lands on the name first. */}
				<ItemTitle>
					<span className="font-medium">{card.display_name || card.name}</span>
					{card.author && (
						<span className="text-xs text-muted-foreground">@{card.author}</span>
					)}
					{card.tags.slice(0, 4).map((tag) => (
						<Badge
							key={tag}
							variant="secondary"
							className="rounded-rect-sm bg-secondary px-1.75 py-0.5 font-mono text-[10px] font-normal text-text-tertiary"
						>
							{tag}
						</Badge>
					))}
					{/* Explicit null check: a hub reporting 0 downloads is
					    saying something, one that does not count them is not. */}
					{card.downloads != null && (
						<Badge
							variant="secondary"
							className="gap-x-1 rounded-rect-sm bg-secondary px-1.75 py-0.5 font-mono text-[10px] font-normal text-text-tertiary"
						>
							<Download className="size-2.5" />
							{card.downloads.toLocaleString()}
						</Badge>
					)}
				</ItemTitle>
				<ItemDescription className="line-clamp-1">
					{skillDescription(card)}
				</ItemDescription>
			</ItemContent>

			<ItemActions className="items-center gap-3 self-center">
				<span className="font-mono text-[10px] text-text-data whitespace-nowrap">
					{/* updated_at is in seconds, as is formatTime. */}
					{card.updated_at
						? now - card.updated_at < 3600
							? t('skill.updatedRecently')
							: t('skill.updatedAgo', {
									ago: formatTime(now - card.updated_at, {
										leadingUnitOnly: true,
									}),
								})
						: null}
				</span>
				<div className="flex h-8 items-center gap-2">
					{installed ? (
						// A state, not an action — a disabled button would
						// still read as something you could have clicked.
						<span className="flex h-7 items-center gap-x-[5px] rounded-rect bg-surface-muted px-3 text-[11.5px] text-muted-foreground">
							<Check className="size-3" />
							{t('skill.installed')}
						</span>
					) : (
						<Button
							className="h-7 rounded-rect px-3.5 text-xs font-normal"
							disabled={installing}
							// Installing straight from the row must not also
							// open the drawer behind it.
							onClick={(e) => {
								e.stopPropagation();
								onInstall();
							}}
						>
							{installing && <Spinner />}
							{t('skill.install')}
						</Button>
					)}
				</div>
			</ItemActions>
		</Item>
	);
}


/**
 * Category filter strip.
 *
 * Pinned to the top of the scrolling body so the active category stays visible
 * while the card list scrolls under it. Horizontally scrollable rather than
 * wrapping: a hub can ship 20+ categories, and a wrapping row would eat half
 * the panel before the first card.
 */
function CategoryChips({
	categories,
	active,
	onSelect,
}: {
	categories: HubCategory[];
	active: string | null;
	onSelect: (id: string | null) => void;
}) {
	const { t } = useTranslation();
	if (categories.length === 0) return null;
	return (
		<div className="sticky top-0 z-10 border-b border-border bg-card px-4 py-2">
			<div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
				<Button
					type="button"
					variant={active === null ? 'secondary' : 'ghost'}
					size="sm"
					className={cn(
						'h-7 shrink-0 rounded-rect px-2.5 text-xs',
						active === null && 'font-medium',
					)}
					onClick={() => onSelect(null)}
				>
					{t('skill.allCategories')}
				</Button>
				{categories.map((c) => (
					<Button
						key={c.id}
						type="button"
						variant={active === c.id ? 'secondary' : 'ghost'}
						size="sm"
						className={cn(
							'h-7 shrink-0 rounded-rect px-2.5 text-xs',
							active === c.id && 'font-medium',
						)}
						onClick={() => onSelect(active === c.id ? null : c.id)}
					>
						{categoryLabel(c.id)}
						{c.count !== null && (
							<span className="text-text-tertiary">
								{c.approximate ? '~' : ''}
								{c.count}
							</span>
						)}
					</Button>
				))}
			</div>
		</div>
	);
}

/** One resolved skill, with its install affordance. */
function ResolvedRow({
	skill,
	hubId,
	installedKeys,
	installingId,
	onInstall,
	emphasis,
}: {
	skill: ResolvedSkill;
	hubId: string;
	installedKeys: Set<string>;
	installingId: string | null;
	onInstall: (card: SkillCard) => void;
	emphasis?: boolean;
}) {
	const { t } = useTranslation();
	const installed = installedKeys.has(`${hubId}:${skill.id}`);
	const card = {
		hub_id: hubId,
		id: skill.id,
		name: skill.id,
		display_name: skill.display_name,
		description: skill.description,
		tags: [],
		metadata: {},
	} as SkillCard;

	if (!emphasis) {
		// Alternatives are one-line chips: they exist to say "these were also in
		// the running", so a full row each would drown the actual winner.
		return (
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="h-6 shrink-0 rounded-rect-sm px-2 text-[11px] font-normal"
				disabled={installed || installingId === skill.id}
				title={skill.description}
				onClick={() => onInstall(card)}
			>
				{installed && <Check className="size-3" />}
				{skill.display_name}
				{skill.match_score !== null && (
					<span className="text-text-tertiary">{skill.match_score}</span>
				)}
			</Button>
		);
	}

	return (
		<div className="flex items-start gap-2.5">
			<Avatar className="mt-0.5 size-7 rounded-md">
				<AvatarFallback className="rounded-md" style={avatarTint(skill.id)}>
					{skill.display_name.slice(0, 1).toUpperCase()}
				</AvatarFallback>
			</Avatar>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-sm font-medium">{skill.display_name}</span>
					{skill.match_score !== null && (
						<Badge variant="glass" className="shrink-0 px-1.5 text-[10px]">
							{t('skill.matchScore', { score: skill.match_score })}
						</Badge>
					)}
					{skill.category && (
						<Badge
							variant="secondary"
							className="shrink-0 px-1.5 text-[10px] font-normal text-text-tertiary"
						>
							{categoryLabel(skill.category)}
						</Badge>
					)}
				</div>
				<p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
					{skill.description}
				</p>
			</div>
			<Button
				type="button"
				variant={installed ? 'outline' : 'default'}
				size="sm"
				className="shrink-0"
				disabled={installed || installingId === skill.id}
				onClick={() => onInstall(card)}
			>
				{installingId === skill.id ? (
					<Spinner />
				) : installed ? (
					<Check />
				) : (
					<Download />
				)}
				{installed ? t('skill.installed') : t('skill.install')}
			</Button>
		</div>
	);
}

/**
 * "Match a task" result.
 *
 * Only hubs with `supports_resolve` produce this. It is a *ranking*, not a
 * list, so it renders as a banner above the browse results instead of
 * replacing them — the user can keep browsing while it sits there.
 */
function ResolveBanner({
	hubId,
	result,
	installedKeys,
	installingId,
	onInstall,
	onDismiss,
}: {
	hubId: string;
	result: SkillResolveResult;
	installedKeys: Set<string>;
	installingId: string | null;
	onInstall: (card: SkillCard) => void;
	onDismiss: () => void;
}) {
	const { t } = useTranslation();
	if (!result.selected) return null;
	return (
		<div className="rounded-2xl border bg-surface-muted p-3">
			<div className="mb-2.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
				<Sparkles className="size-3.5 text-primary" />
				<span>{t('skill.matchRecommends')}</span>
				{result.total_searched !== null && (
					<span className="text-text-tertiary">
						· {t('skill.matchSearched', { count: result.total_searched })}
					</span>
				)}
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="ml-auto size-5"
					aria-label={t('skill.matchDismiss')}
					onClick={onDismiss}
				>
					<X className="size-3" />
				</Button>
			</div>

			<ResolvedRow
				skill={result.selected}
				hubId={hubId}
				installedKeys={installedKeys}
				installingId={installingId}
				onInstall={onInstall}
				emphasis
			/>

			{result.alternatives.length > 0 && (
				<div className="mt-2.5 flex items-center gap-1.5 overflow-x-auto border-t border-border pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
					<span className="shrink-0 text-[11px] text-text-tertiary">
						{t('skill.matchAlternatives')}
					</span>
					{result.alternatives.map((alt) => (
						<ResolvedRow
							key={alt.id}
							skill={alt}
							hubId={hubId}
							installedKeys={installedKeys}
							installingId={installingId}
							onInstall={onInstall}
						/>
					))}
				</div>
			)}

			{result.policy_summary && (
				<p className="mt-2 text-[11px] text-text-tertiary">
					{t('skill.matchPolicy', { policy: result.policy ?? '—' })} ·{' '}
					{result.policy_summary}
				</p>
			)}
		</div>
	);
}

interface HubPanelProps {
	hubId: string;
	hub?: HubInfo;
	/** `hub_id:card_id` of everything already in the library. */
	installedKeys: Set<string>;
	onInstalled: () => void;
}

function HubPanel({ hubId, hub, installedKeys, onInstalled }: HubPanelProps) {
	const { t } = useTranslation();
	const [query, setQuery] = useState('');
	const [category, setCategory] = useState<string | null>(null);
	const [installingId, setInstallingId] = useState<string | null>(null);
	// Task-matching state. `resolveError` is separate from the browse error so a
	// failed match does not blank out a perfectly good card list.
	const [resolving, setResolving] = useState(false);
	const [resolved, setResolved] = useState<SkillResolveResult | null>(null);
	const [resolveError, setResolveError] = useState(false);
	const drawer = useResourceDrawer(
		useCallback(
			(skill) => hubApi.skill.getCard(skill.hub_id as string, (skill as SkillCard).id),
			[],
		),
	);
	// Read once per mount: reading the clock during render is impure, and
	// a browse session is far shorter than the units this rounds to.
	const [now] = useState(() => Date.now() / 1000);
	const { cards, loading, loadingMore, error, hasMore, loadMore, refetch } = useSkillHubCards(
		hubId,
		query,
		category,
	);
	const { categories } = useHubCategories(hubId);

	const canResolve = hub?.supports_resolve === true;

	/**
	 * Ask the hub to rank skills against the text in the search box.
	 *
	 * Reuses the search box as the task description rather than adding a second
	 * input: the user has already typed the task when they want this, and two
	 * boxes side by side would be ambiguous about which one filters.
	 */
	const handleResolve = async () => {
		const task = query.trim();
		if (!task || resolving) return;
		setResolving(true);
		setResolveError(false);
		try {
			setResolved(await hubApi.skill.resolve(hubId, task));
		} catch {
			setResolveError(true);
			setResolved(null);
		} finally {
			setResolving(false);
		}
	};

	const isInstalled = (card: SkillCard) => installedKeys.has(`${card.hub_id}:${card.id}`);

	// A skill needs no configuration, so there is nothing to ask for —
	// unlike an MCP install, this goes straight through without a dialog.
	const handleInstall = async (card: SkillCard) => {
		setInstallingId(card.id);
		try {
			await hubApi.skill.install(card.hub_id, card.id);
			onInstalled();
		} catch (e) {
			// A 409 already surfaced as a toast from the client.
			if (!(e instanceof ApiError)) throw e;
		} finally {
			setInstallingId(null);
		}
	};

	return (
		// Falls back to the raw id while the hub list is still loading.
		<ResourcePanel
			title={hub?.display_name ?? hubId}
			description={hub?.description}
			icon={
				<Avatar className="rounded-md">
					<AvatarImage
						src={hub?.icon_url ?? undefined}
						alt={hub?.display_name ?? hubId}
					/>
					<AvatarFallback className="rounded-md" style={avatarTint(hubId)}>
						{(hub?.display_name ?? hubId).slice(0, 1).toUpperCase()}
					</AvatarFallback>
				</Avatar>
			}
			search={{
				value: query,
				// 开始手动搜索就退出分类浏览：显式搜索词优先于分类的代理关键词，
				// 让分类 chip 取消高亮，用户能看出"现在是自由检索"状态。
				onChange: (value: string) => {
					setCategory(null);
					setQuery(value);
				},
				placeholder: t('skill.searchPlaceholder'),
				// Only hubs that actually implement resolve get the button.
				action: canResolve ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-8 shrink-0 gap-1.5 text-xs"
						disabled={!query.trim() || resolving}
						title={query.trim() ? undefined : t('skill.matchHint')}
						onClick={handleResolve}
					>
						{resolving ? <Spinner /> : <Sparkles className="size-3.5" />}
						{t('skill.matchButton')}
					</Button>
				) : undefined,
			}}
		>
			<div className="app-no-drag flex flex-col">
				<CategoryChips categories={categories} active={category} onSelect={setCategory} />

				{(resolved || resolveError) && (
					<div className="px-4 pt-3">
						{resolveError ? (
							<p className="text-xs text-destructive">{t('skill.matchFailed')}</p>
						) : resolved ? (
							<ResolveBanner
								hubId={hubId}
								result={resolved}
								installedKeys={installedKeys}
								installingId={installingId}
								onInstall={handleInstall}
								onDismiss={() => setResolved(null)}
							/>
						) : null}
					</div>
				)}

				<div className="flex flex-col gap-y-4 p-4">
				{loading ? (
					<div className="flex justify-center py-10">
						<Spinner />
					</div>
				) : error ? (
					<Empty className="border-none py-10">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<TriangleAlert />
							</EmptyMedia>
							<EmptyTitle>{t('skill.loadFailedTitle')}</EmptyTitle>
							<EmptyDescription>{t('skill.loadFailedDescription')}</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button variant="outline" size="sm" onClick={refetch}>
								{t('skill.retry')}
							</Button>
						</EmptyContent>
					</Empty>
				) : cards.length === 0 ? (
					<Empty className="border-none py-10">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Blocks />
							</EmptyMedia>
							<EmptyTitle>{t('skill.noCardsTitle')}</EmptyTitle>
							<EmptyDescription>{t('skill.noCardsDescription')}</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<ItemGroup className="gap-0">
						{cards.map((card) => (
							<CardItem
								key={`${card.hub_id}:${card.id}`}
								card={card}
								installed={isInstalled(card)}
								installing={installingId === card.id}
								now={now}
								onInstall={() => handleInstall(card)}
								onOpen={() => drawer.open(card)}
							/>
						))}
					</ItemGroup>
				)}

				{/* Cursor pagination — no page numbers and no total to show. */}
				{hasMore && (
					<LoadMore shown={cards.length} loading={loadingMore} onLoad={loadMore} />
				)}
				</div>
			</div>

			<ResourceDetailDrawer
				skill={drawer.opened}
				loading={drawer.loading}
				onOpenChange={(open) => {
					if (!open) drawer.close();
				}}
				action={
					<Button
						disabled={
							drawer.opened !== null &&
							(isInstalled(drawer.opened as SkillCard) ||
								installingId === (drawer.opened as SkillCard).id)
						}
						onClick={() => drawer.opened && handleInstall(drawer.opened as SkillCard)}
					>
						{drawer.opened && isInstalled(drawer.opened as SkillCard) ? (
							<Check />
						) : (
							<Download />
						)}
						{t(
							drawer.opened && isInstalled(drawer.opened as SkillCard)
								? 'skill.installed'
								: 'skill.install',
						)}
					</Button>
				}
			/>
		</ResourcePanel>
	);
}

interface MinePanelProps {
	skills: SkillView[];
	loading: boolean;
	canImportLocal: boolean;
	onImportLocal: () => Promise<void>;
	onRemove: (skillId: string) => void;
}

function MinePanel({ skills, loading, canImportLocal, onImportLocal, onRemove }: MinePanelProps) {
	const { t } = useTranslation();
	const [query, setQuery] = useState('');
	const [importing, setImporting] = useState(false);
	const [importError, setImportError] = useState<string | null>(null);
	// The list view omits SKILL.md; the detail endpoint carries it.
	const drawer = useResourceDrawer(
		useCallback((skill) => skillApi.get((skill as SkillView).id), []),
	);

	// Filtered client-side: the library is the user's own and small, so a
	// round trip per keystroke would buy nothing.
	const needle = query.trim().toLowerCase();
	const shown = needle
		? skills.filter((skill) =>
				[
					skill.name,
					skill.display_name ?? '',
					skill.description,
					skill.description_zh ?? '',
					...skill.tags,
				].some(
					(field) => field.toLowerCase().includes(needle),
				),
			)
		: skills;

	const handleImportLocal = async () => {
		if (importing) return;
		setImporting(true);
		setImportError(null);
		try {
			await onImportLocal();
		} catch (error) {
			setImportError((error as Error).message);
		} finally {
			setImporting(false);
		}
	};

	return (
		<ResourcePanel
			title={t('common.my-skill')}
			description={t('skill.mineDescription')}
			icon={<Plug className="size-5 text-muted-foreground" />}
			search={
				// Hidden while there is nothing to search through.
				skills.length > 0
					? {
							value: query,
							onChange: setQuery,
							placeholder: t('skill.mineSearchPlaceholder'),
						}
					: undefined
			}
			action={
				canImportLocal ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="rounded-rect"
						disabled={importing}
						onClick={() => void handleImportLocal()}
					>
						{importing ? <Spinner /> : <FolderUp />}
						{t('panel.skill.importLocal')}
					</Button>
				) : undefined
			}
		>
			{importError && (
				<p className="mx-4 mt-4 rounded-rect-sm bg-destructive/10 px-3 py-2 text-sm text-destructive">
					{importError}
				</p>
			)}
			{loading ? (
				<div className="flex justify-center py-10">
					<Spinner />
				</div>
			) : skills.length === 0 ? (
				<Empty className="border-none py-10">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Plug />
						</EmptyMedia>
						<EmptyTitle>{t('skill.mineEmptyTitle')}</EmptyTitle>
						<EmptyDescription>{t('skill.mineEmptyDescription')}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : shown.length === 0 ? (
				<Empty className="border-none py-10">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Blocks />
						</EmptyMedia>
						<EmptyTitle>{t('skill.noCardsTitle')}</EmptyTitle>
						<EmptyDescription>{t('skill.noCardsDescription')}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<ItemGroup className="gap-0">
					{shown.map((skill) => (
						<Item
							key={skill.id}
							className="cursor-pointer hover:bg-accent"
							onClick={() => drawer.open(skill)}
						>
							<ItemMedia>
								<Avatar className="rounded-md">
									<AvatarImage
										src={skill.icon_url ?? undefined}
										alt={skill.display_name || skill.name}
										loading="lazy"
									/>
									<AvatarFallback
										className="rounded-md"
										style={avatarTint(skill.name)}
									>
										{(skill.display_name || skill.name)
											.slice(0, 1)
											.toUpperCase()}
									</AvatarFallback>
								</Avatar>
							</ItemMedia>

							<ItemContent>
								<ItemTitle>
									<span className="font-medium">
										{skill.display_name || skill.name}
									</span>
									{/* A hand-added skill has no hub to name. */}
									{skill.hub_id && (
										<span className="text-xs text-muted-foreground">
											@{skill.hub_id}
										</span>
									)}
									{skill.tags.slice(0, 4).map((tag) => (
										<span
											key={tag}
											className="text-xs text-muted-foreground"
										>
											#{tag}
										</span>
									))}
								</ItemTitle>
								<ItemDescription className="line-clamp-1">
									{skillDescription(skill)}
								</ItemDescription>
							</ItemContent>

							<ItemActions>
								{skill.version && (
									<span className="text-xs text-muted-foreground whitespace-nowrap">
										{skill.version}
									</span>
								)}
								<Button
									size="icon-sm"
									variant="ghost"
									// Deleting from the row must not also
									// open the drawer behind it.
									onClick={(e) => {
										e.stopPropagation();
										onRemove(skill.id);
									}}
									title={t('common.delete')}
								>
									<Trash2 />
								</Button>
							</ItemActions>
						</Item>
					))}
				</ItemGroup>
			)}

			<ResourceDetailDrawer
				skill={drawer.opened}
				loading={drawer.loading}
				onOpenChange={(open) => {
					if (!open) drawer.close();
				}}
				action={
					<Button
						variant="destructive"
						onClick={() => {
							if (drawer.opened) onRemove((drawer.opened as SkillView).id);
							drawer.close();
						}}
					>
						<Trash2 />
						{t('common.delete')}
					</Button>
				}
			/>
		</ResourcePanel>
	);
}

export function SkillHubPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	// No `hubId` in the URL means the "mine" tab, which is the default.
	const { hubId } = useParams<{ hubId?: string }>();
	const { hubs, loading: hubsLoading, error: hubsError, refetch } = useSkillHubs();
	// Loaded page-wide, not per panel: the hub view needs it to mark cards
	// as already installed, and the "mine" view to list them.
	const { skills, loading: skillsLoading, refetch: refetchSkills, remove } = useSkills();
	// 用 (hub_id, card_id) 判定"已安装"，不要用 name ——
	// 上游 list 的 name 常常是展示名（"Find Skills"），而 install 落库的 handle
	// 来自 detail（缺 name 时回退 slug，"find-skills"），拿 name 比对会永远不命中。
	const installedKeys = new Set(
		skills.filter((s) => s.hub_id && s.card_id).map((s) => `${s.hub_id}:${s.card_id}`),
	);
	const canImportLocal = !!(window as unknown as {
		cocodeWindow?: { openFolderDialog?: () => Promise<string | null> };
	}).cocodeWindow?.openFolderDialog;
	const handleImportLocal = useCallback(async () => {
		const path = await (window as unknown as {
			cocodeWindow?: { openFolderDialog: () => Promise<string | null> };
		}).cocodeWindow?.openFolderDialog();
		if (!path) return;
		await skillApi.importLocal(path);
		await refetchSkills();
	}, [refetchSkills]);

	return (
		// 拖拽区只留在 `SidebarHeader` 的标题条与 `main` 上。**不要**给最外层
		// wrapper 或 `SidebarContent` 加 `app-drag`：整块作为拖拽区、再靠内部
		// `app-no-drag` 逐块挖洞，在 Electron 里并不可靠（`SidebarContent` 还带
		// `overflow-auto`，Chromium 不支持滚动区当拖拽区），会表现为侧栏按钮点不动。
		<div className="flex size-full p-2 gap-2">
			<Sidebar collapsible="none" className="rounded-[22px]">
				<SidebarHeader className="app-drag flex flex-col p-[20px_18px_14px] gap-y-1">
					<div className="text-xl font-medium tracking-[-0.02em] text-foreground">
						{t('common.skill-hub')}
					</div>
					<div className="text-text-tertiary text-xs">{t('skill.subtitle')}</div>
				</SidebarHeader>
				<SidebarContent>
					<SidebarGroup className="app-no-drag mt-6 px-2 py-0">
						<SidebarGroupLabel>{t('common.mine')}</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu>
								<SidebarMenuItem>
									<SidebarMenuButton
										isActive={!hubId}
										onClick={() => navigate('/skill')}
									>
										<Plug />
										<span className="min-w-0 flex-1 truncate">
											{t('common.my-skill')}
										</span>
										<span className="font-mono text-[10px] text-text-data">
											{skills.length}
										</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>

					<SidebarGroup className="app-no-drag mt-5 px-2 py-0">
						<SidebarGroupLabel className="justify-between">
							{t('skill.hubsLabel')}
							{hubs.length > 0 && (
								<span className="text-[10px] text-text-data font-mono">
									{hubs.length}
								</span>
							)}
						</SidebarGroupLabel>
						<SidebarGroupContent>
							{hubsLoading ? (
								<div className="flex justify-center py-4">
									<Spinner />
								</div>
							) : hubsError ? (
								// Distinct from the empty state on purpose: a
								// failed request otherwise reads as "no hubs
								// configured", pointing at the wrong problem.
								<Empty className="border-none py-4 min-h-40">
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<TriangleAlert />
										</EmptyMedia>
										<EmptyTitle>{t('skill.loadFailedTitle')}</EmptyTitle>
										<EmptyDescription>
											{t('skill.loadFailedDescription')}
										</EmptyDescription>
									</EmptyHeader>
									<EmptyContent>
										<Button variant="outline" size="sm" onClick={refetch}>
											{t('skill.retry')}
										</Button>
									</EmptyContent>
								</Empty>
							) : hubs.length === 0 ? (
								<Empty className="border-none py-4 min-h-40">
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<Blocks />
										</EmptyMedia>
										<EmptyTitle>{t('skill.noHubsTitle')}</EmptyTitle>
										<EmptyDescription>
											{t('skill.noHubsDescription')}
										</EmptyDescription>
									</EmptyHeader>
								</Empty>
							) : (
								<SidebarMenu>
									{hubs.map((hub) => (
										<SidebarMenuItem key={hub.hub_id}>
											<SidebarMenuButton
												isActive={hubId === hub.hub_id}
												onClick={() => navigate(`/skill/${hub.hub_id}`)}
												title={hub.description}
											>
												<Avatar className="size-4 rounded-sm">
													<AvatarImage
														src={hub.icon_url ?? undefined}
														alt={hub.display_name}
													/>
													<AvatarFallback
														className="rounded-sm text-[10px]"
														style={avatarTint(hub.hub_id)}
													>
														{hub.display_name.slice(0, 1).toUpperCase()}
													</AvatarFallback>
												</Avatar>
												<span className="min-w-0 flex-1 truncate">
													{hub.display_name}
												</span>
											</SidebarMenuButton>
										</SidebarMenuItem>
									))}
								</SidebarMenu>
							)}
						</SidebarGroupContent>
					</SidebarGroup>
				</SidebarContent>
			</Sidebar>

			<main className="app-drag flex-1 min-w-0 min-h-0 overflow-hidden rounded-[22px] bg-card shadow-panel">
				{hubId ? (
					// Remount on hub change so the panel's query box resets.
					<HubPanel
						key={hubId}
						hubId={hubId}
						hub={hubs.find((h) => h.hub_id === hubId)}
						installedKeys={installedKeys}
						onInstalled={refetchSkills}
					/>
				) : (
					<MinePanel
						skills={skills}
						loading={skillsLoading}
						canImportLocal={canImportLocal}
						onImportLocal={handleImportLocal}
						onRemove={remove}
					/>
				)}
			</main>
		</div>
	);
}
