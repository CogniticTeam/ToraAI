// SkillMD.ai 客户端（API base: claude-plugins.dev）
//
// 公开 REST，无需 Token。实测可用端点：
//   GET /api/skills?q=&limit=&offset=     列表 / 搜索（**真分页**）
//
// 三个源的差异（这个源最规整、内容最好）：
//   - 分页是真的：响应 `{ skills, total, limit, offset }`，`total` 是真实总量
//     （约 47k），`offset` 生效。另两个源一个忽略 limit、一个完全没有分页。
//   - **没有详情端点**。文档写的 `/api/skills/@owner/repo/name` 实测 404
//     （只有 `/api/skills` 列表存在）。但列表项本身就是完整元数据，而且带
//     `metadata.rawFileUrl` —— 指向 GitHub raw 的 SKILL.md 原文。
//   - 所以这是唯一能拿到**真实 SKILL.md 正文**的源（另两个一个正文常为空、
//     一个要自己合成）。正文只在详情阶段按需拉，列表不带，避免 20 条变几 MB。
//   - `q` 传**完整 namespace** 时命中很准（实测 total=3 且含目标），
//     详情就靠它反查。
//   - 没有分类字段、没有标签字段 → 不支持分类浏览。
//   - ⚠️ 延迟波动很大：实测同一请求 2s ~ 30s+ 都有，且会直接超时。所以
//     timeout 放宽到 30s，并加一层进程内缓存（列表里见过的卡片，详情不再请求）。

import { HubError } from './hub-error.js';

const BASE = 'https://claude-plugins.dev';
const TIMEOUT_MS = 30000;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

/** 列表项缓存 TTL：详情/安装都复用列表页已经拿到的数据，少打这个不稳定的上游。 */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** namespace → { card, at } */
const cardCache = new Map();

async function upstream(path, { params = null } = {}) {
	const url = new URL(path, BASE);
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			if (v === undefined || v === null || v === '') continue;
			url.searchParams.set(k, String(v));
		}
	}

	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
	let res;
	try {
		res = await fetch(url.toString(), {
			headers: { Accept: 'application/json' },
			signal: ac.signal,
		});
	} catch (e) {
		clearTimeout(timer);
		const timedOut = e instanceof Error && e.name === 'AbortError';
		throw new HubError(timedOut ? 'skillmd.ai upstream timeout' : 'skillmd.ai unreachable', {
			status: timedOut ? 504 : 0,
		});
	}
	clearTimeout(timer);

	if (!res.ok) {
		let body = '';
		try { body = await res.text(); } catch { /* ignore */ }
		throw new HubError(`skillmd.ai returned ${res.status}: ${body || res.statusText}`, {
			status: res.status,
			upstream: body.slice(0, 500),
		});
	}
	return res.json();
}

/** 纯文本拉取（GitHub raw 的 SKILL.md）。失败返回 null，不阻塞。 */
async function upstreamText(url) {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, { signal: ac.signal });
		if (!res.ok) return null;
		return await res.text();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function asInt(v, def) {
	const n = parseInt(v, 10);
	return Number.isFinite(n) ? n : def;
}
function clamp(n, lo, hi) { return Math.min(Math.max(n, lo), hi); }

function asNum(v) {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v === 'string' && v.trim() !== '') {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

/** ISO 串 → epoch 秒。 */
function asEpochSec(v) {
	if (typeof v !== 'string' || !v) return null;
	const t = Date.parse(v);
	return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

function firstStr(...vals) {
	for (const v of vals) {
		if (typeof v === 'string' && v.trim() !== '') return v;
	}
	return '';
}

/**
 * 上游列表项 → CoCode SkillCard。
 *
 * `namespace`（形如 `@owner/repo/skill-name`）是这里唯一的全局唯一标识，所以
 * 它同时当 `id`（详情路径）和 `name`（装库后的 handle）—— 只用 `skill-name`
 * 会在 47k 条里撞名。
 */
function normalize(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const ns = firstStr(raw.namespace, raw.id);
	if (!ns) return null;

	const meta = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
	const repoOwner = firstStr(meta.repoOwner, raw.author);
	const repoName = firstStr(meta.repoName);
	const repoSlug = repoOwner && repoName ? `${repoOwner}/${repoName}` : '';

	const tags = [];
	if (repoSlug) tags.push(repoSlug);

	return {
		hub_id: 'skillmd.ai',
		id: ns,
		name: ns,
		// 展示名用短名（`pdf`），作者已经在卡片上单独显示，重复一遍反而更长。
		display_name: firstStr(raw.name, ns),
		description: firstStr(raw.description),
		description_zh: null, // 上游全英文
		tags,
		version: firstStr(raw.version) || null,
		updated_at: asEpochSec(raw.updatedAt),
		author: repoOwner || null,
		icon_url: null,
		installs: asNum(raw.installs),
		downloads: null,
		url: firstStr(raw.sourceUrl) || `https://skillmd.ai/skills/${ns}`,
		// 列表不带正文：20 条 SKILL.md 就是几百 KB，而且上游本身就不稳。
		markdown: null,
		metadata: {
			score: null,
			source: 'skillmd.ai',
			stars: asNum(raw.stars),
			category: null, // 上游没有分类
			namespace: ns,
			repo: repoSlug || null,
			raw_file_url: firstStr(meta.rawFileUrl) || null,
			created_at: asEpochSec(raw.createdAt),
		},
	};
}

function cacheCard(card) {
	if (card) cardCache.set(card.id, { card, at: Date.now() });
}

/** 取缓存里的卡片（未过期）。 */
function fromCache(id) {
	const hit = cardCache.get(id);
	if (!hit) return null;
	if (Date.now() - hit.at > CACHE_TTL_MS) {
		cardCache.delete(id);
		return null;
	}
	return hit.card;
}

/**
 * 列表 / 搜索。
 *
 * 这是三个源里唯一有真分页的：`offset` 生效，`total` 是真实总量，所以
 * cursor 用 `String(nextOffset)` 就能正常翻页（前端会渲染"加载更多"）。
 */
export async function listSkillCards(_hubId, { q = null, category = null, cursor = null, limit = DEFAULT_LIMIT } = {}) {
	const offset = cursor === null || cursor === '' ? 0 : Math.max(asInt(cursor, 0), 0);
	const safeLimit = clamp(asInt(limit, DEFAULT_LIMIT) || DEFAULT_LIMIT, 1, MAX_LIMIT);

	// 显式搜索词优先；否则用分类的代理关键词。两者都没有就是"热门目录"。
	// 前端在用户开始输入时会清掉 category，所以这两者基本不会同时出现。
	const term = q || (category ? CATEGORY_BY_ID.get(category) : null) || '';

	const data = await upstream('/api/skills', {
		params: { q: term || undefined, limit: safeLimit, offset },
	});

	const items = Array.isArray(data?.skills) ? data.skills : [];
	const cards = items.map(normalize).filter(Boolean);
	cards.forEach(cacheCard);

	const total = asNum(data?.total);
	const nextOffset = offset + items.length;
	// 到末尾或这一页本来就是空的 → 没有下一页
	const nextCursor =
		items.length === 0 || (total !== null && nextOffset >= total) ? null : String(nextOffset);

	return { cards, next_cursor: nextCursor, total };
}

/**
 * 详情 —— 含真实 SKILL.md 正文。
 *
 * 上游没有详情端点，所以：先看缓存（列表页刚拿过就不用请求），否则用完整
 * namespace 回查搜索（实测 `q=@owner/repo/name` 返回极少几条且必含目标），
 * 最后按 `metadata.rawFileUrl` 拉 GitHub raw 正文。
 *
 * 正文拿不到不算失败 —— 返回卡片但 `markdown` 为 null，前端会退回 description。
 */
export async function getSkillCard(_hubId, cardId) {
	const cached = fromCache(cardId);
	if (cached) return { ...cached, markdown: await loadMarkdown(cached) };

	const data = await upstream('/api/skills', { params: { q: cardId, limit: 20 } });
	const items = Array.isArray(data?.skills) ? data.skills : [];
	const raw = items.find((s) => firstStr(s.namespace, s.id) === cardId);
	if (!raw) return null;

	const card = normalize(raw);
	if (!card) return null;
	cacheCard(card);
	return { ...card, markdown: await loadMarkdown(card) };
}

/**
 * GitHub raw 地址 → jsDelivr 镜像地址。
 *
 *   https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
 *   → https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}
 *
 * 不是可有可无的优化：raw.githubusercontent.com 在很多网络环境里不可达
 * （实测本机 Node 直接 fetch 失败、curl 却能过），而 jsDelivr 是公开 CDN。
 * 两条路都试，正文拿到的概率高得多。
 */
function mirrorUrl(rawUrl) {
	const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(rawUrl);
	if (!m) return null;
	const [, owner, repo, branch, rest] = m;
	return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${rest}`;
}

/**
 * 拉正文：先原始地址，失败再走镜像。
 *
 * 都拿不到就返回 null —— 前端会自动退回卡片 description 喂模型，不影响可用性。
 */
async function loadMarkdown(card) {
	const raw = card?.metadata?.raw_file_url;
	if (typeof raw !== 'string' || !raw) return null;

	const viaRaw = await upstreamText(raw);
	if (viaRaw) return viaRaw;

	const mirror = mirrorUrl(raw);
	if (!mirror) return null;
	return upstreamText(mirror);
}

/**
 * 分类 —— **关键词代理分类**，不是上游给的分类。
 *
 * ⚠️ 这个源没有分类字段，也**不支持任何服务端筛选**：`category=` / `tag=` /
 * `tags=` / `type=` / `sort=` 全部被静默忽略（返回结果与不带参数完全一致）。
 * 官网只在"插件仓库"层有 9 个分类（development / security / …），且只对首页
 * 精选仓库可见；技能详情页连这个都没有。所以拿不到真正的 per-skill 分类。
 *
 * 能用的只有 `q` —— 而它恰好是**语义检索**，覆盖全部 4.7 万条且很快
 * （实测 0.6~2s，`q=security` → 2008 条语义相关结果）。所以这里的做法是：
 * 每个分类 = 一个校准过的检索词。
 *
 * 这样做还有个实际好处：另两个源靠服务端分类过滤，而这个源如果做"前端过滤
 * 已加载的那 20 条"，在 4.7 万条里等于没过滤。走检索才是真覆盖全量。
 */
const CATEGORIES = [
	{ id: 'development', query: 'code' },
	{ id: 'ai-agent', query: 'agent' },
	{ id: 'document-processing', query: 'document' },
	{ id: 'data-analysis', query: 'data' },
	{ id: 'design-creative', query: 'design' },
	{ id: 'testing', query: 'test' },
	{ id: 'security', query: 'security' },
	{ id: 'web-automation', query: 'browser' },
	{ id: 'devops', query: 'deploy' },
	{ id: 'rag-knowledge', query: 'llm' },
	{ id: 'writing', query: 'writing' },
];

const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c.query]));

/**
 * 分类计数缓存。
 *
 * 计数靠 11 个并发 `limit=1` 探测拿到（理想情况 ~1.7s 全部成功）。但这个上游
 * 并发一高就会零星超时（实测 11 并发时有 4 个挂掉、总耗时涨到 11s）。
 *
 * 所以两条保护：
 * 1. **整体截止时间**：最多等 COUNT_DEADLINE_MS，没回来的留 null。分类条是
 *    页面加载路径上的东西，绝不能被上游拖住（单个探测的 30s 超时在这里没用，
 *    因为 race 已经把它截断了）。
 * 2. **缓存 10 分钟**：不能每次进页面都打这 11 个请求。
 *
 * 拿不到计数的分类前端就不渲染数字，属于可接受的降级。
 */
const COUNT_TTL_MS = 10 * 60 * 1000;
/** 前台等计数的时间上限 —— 直接决定分类条多久出现，所以压得比较短。 */
const COUNT_DEADLINE_MS = 2500;
/** 后台补漏的时间上限 —— 没人在等，可以宽一点。 */
const COUNT_BACKGROUND_MS = 12000;
let countCache = { at: 0, data: null };
let refreshing = false;

async function probeCount(category) {
	try {
		const data = await upstream('/api/skills', { params: { q: category.query, limit: 1 } });
		return asNum(data?.total);
	} catch {
		return null; // 单个分类探测失败不该拖垮整个清单
	}
}

/**
 * 分类清单。count 是**代理关键词在上游的真实匹配总数**；
 * `approximate: true` 表示"分类本身是关键词代理，不是原生分类"。
 */
/** 并发探测全部计数，deadline 到点就带着部分结果返回（没回来的留 null）。 */
async function probeAllCounts(deadlineMs) {
	const counts = new Array(CATEGORIES.length).fill(null);
	await Promise.race([
		Promise.all(CATEGORIES.map(async (c, i) => { counts[i] = await probeCount(c); })),
		new Promise((resolve) => setTimeout(resolve, deadlineMs)),
	]);
	return counts;
}

function buildCategoryViews(counts) {
	return CATEGORIES.map((c, i) => ({ id: c.id, count: counts[i], approximate: true }));
}

/**
 * 后台补漏：前台没赶上截止时间的那些分类，在这里用更宽的预算重试一次。
 * 只写缓存、不返回给谁 —— 下次请求就能看到更完整的计数。
 */
async function refreshCountsInBackground() {
	if (refreshing) return;
	refreshing = true;
	try {
		const counts = await probeAllCounts(COUNT_BACKGROUND_MS);
		if (counts.some((n) => n !== null)) {
			countCache = { at: Date.now(), data: buildCategoryViews(counts) };
		}
	} finally {
		refreshing = false;
	}
}

export async function listCategories() {
	if (countCache.data && Date.now() - countCache.at < COUNT_TTL_MS) {
		return countCache.data;
	}
	const counts = await probeAllCounts(COUNT_DEADLINE_MS);
	const data = buildCategoryViews(counts);
	// 全部失败（多半是上游挂了）就不写缓存，下次再试
	if (counts.some((n) => n !== null)) {
		countCache = { at: Date.now(), data };
	}
	// 还有缺口 → 后台补齐。不 await，不阻塞这次响应。
	if (counts.some((n) => n === null)) {
		setTimeout(() => { void refreshCountsInBackground(); }, 0);
	}
	return data;
}

/** 默认 hub 注册。 */
export const DEFAULT_HUB = {
	hub_id: 'skillmd.ai',
	display_name: 'SkillMD.ai（海外）',
	description: 'SKILL.md 标准技能库 — 47k+ 开源技能，可拉取原始 SKILL.md 正文',
	icon_url: null,
	supports_resolve: false,
};
