// SkillHub 客户端（api.skillhub.cn）
// 公开 API：
//   GET /api/skills?keyword=&page=&limit=&sortBy=     列表 + 搜索（page 才是真分页）
//   GET /api/v1/skills/{slug}                            详情（含 overviewMd）
// 后端单代理：避免 CORS / token 泄漏 / 可缓存。
//
// 关键约束：
// - 上游 rate limit 120 req/min (匿名)。fetch 包 timeout（5s）；失败抛 SkillHubError。
// - 上游字段 ≠ 我们的 SkillCard 字段，normalize 阶段必须把缺失字段填 null。
// - **分页只认 `page`（1-based）**。逐参数实测（2026-09-13，同一时刻发请求比对
//   返回的 slug 集合）：offset / cursor / pageToken / page_token / skip / start /
//   startIndex / after / from / begin / position / index / pageNum / pageNo 全部被
//   忽略 —— 换任何值都返回同一批 20 条，看上去"翻页成功"但内容原样重复。只有
//   `page=2` 返回的是另一批。cursor 因此用 String(page) 包装。
//   曾经写成 offset-based（cursor = 已加载条数），等于把上游的"忽略"当成了
//   "接受"，前端于是无限追加同一页 —— 这是"技能市场一直在重复技能"的根源。
//   `page` 与 keyword / category 可叠加，三者都是真实的服务端行为。
// - `limit` 被忽略，上游固定每页 20 条；游标推进必须按这个固定宽度算。
// - `total` 是**过滤后**的真实总量（keyword=pdf → 3455），可用来判定末页。
// - 越界页返回 200 + 空数组（不是 404），据此判定"没有下一页"。
// - 上游 /api/v1/search 路径也可用，但只返 results 数组无 total，不如下面这个。

import { HubError } from './hub-error.js';

const BASE = 'https://api.skillhub.cn';
const TIMEOUT_MS = 5000;
const PAGE_SIZE = 20; // 上游固定每页 20，无法突破

// 错误类型与 OpenAgentSkill 适配器共用（server.js 只判 instanceof HubError）。
export { HubError, SkillHubError } from './hub-error.js';

/** fetch wrapper with AbortSignal.timeout — 5s 内不返回就当成不可达。 */
async function upstream(path, { method = 'GET', params = null } = {}) {
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
			method,
			headers: { Accept: 'application/json' },
			signal: ac.signal,
		});
	} catch (e) {
		clearTimeout(timer);
		const timedOut = e instanceof Error && e.name === 'AbortError';
		throw new HubError(
			timedOut ? 'skillhub upstream timeout (5s)' : 'skillhub unreachable',
			{ status: timedOut ? 504 : 0 },
		);
	}
	clearTimeout(timer);

	if (!res.ok) {
		let body = '';
		try { body = await res.text(); } catch {}
		throw new HubError(`skillhub returned ${res.status}: ${body || res.statusText}`, {
			status: res.status,
			upstream: body.slice(0, 500),
		});
	}

	const ct = res.headers.get('content-type') || '';
	if (!ct.includes('application/json')) {
		throw new HubError(`skillhub returned non-JSON content-type: ${ct}`, { status: 502 });
	}
	return res.json();
}

/** 整数安全解析 + 钳位。解析不出来返回默认值（游标里的页码一律从 1 起算）。 */
function asInt(v, def) {
	const n = parseInt(v, 10);
	return Number.isFinite(n) ? n : def;
}

/**
 * 上游同一个语义字段在不同端点会换类型：
 *   list   → installs: 75956,    downloads: 949690   (number)
 *   detail → stats: { installs: '0', downloads: '1101' } (string)
 * 统一成 number；解析不出来返 null（"没统计" ≠ 0）。
 */
function asNum(v) {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v === 'string' && v.trim() !== '') {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

/**
 * epoch → 秒。上游既可能给毫秒数字 (1789227234980)、毫秒字符串
 * ('1789227210438')，也可能给 ISO 串。>1e11 视为毫秒
 * （1e11 秒 ≈ 公元 5138 年，真实 epoch 秒不可能到这个量级）。
 */
function asEpochSec(v) {
	const n = asNum(v);
	if (n !== null && n > 0) return Math.floor(n > 1e11 ? n / 1000 : n);
	if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) {
		return Math.floor(Date.parse(v) / 1000);
	}
	return null;
}

/** 取第一个非空字符串 —— 上游大量字段是 '' 而不是缺失。 */
function firstStr(...vals) {
	for (const v of vals) {
		if (typeof v === 'string' && v.trim() !== '') return v;
	}
	return '';
}
function clamp(n, lo, hi) { return Math.min(Math.max(n, lo), hi); }

/**
 * SkillHub 上游字段 → CoCode SkillCard 字段 normalize。
 *
 * - slug 缺失 → 整个丢弃（必有 id，否则前端去重策略炸）
 * - tags[] 缺失从 subCategories[].name 提取 + category 也当 tag 用
 * - updated_at 取 updatedAt / updated_at，已知是 epoch ms
 * - description / summary 任一存在即用，summary 优先（更短）
 * - markdown 不一定在 list 上有 —— 留着 null，等 detail 兜底
 */
function normalizeListItem(raw) {
	const id = String(raw.slug ?? raw.id ?? raw.skill_id ?? '');
	if (!id) return null;

	const tags = [];
	if (Array.isArray(raw.tags)) {
		for (const t of raw.tags) if (typeof t === 'string') tags.push(t);
	}
	if (Array.isArray(raw.subCategories)) {
		for (const sc of raw.subCategories) {
			if (sc && typeof sc.name === 'string' && !tags.includes(sc.name)) {
				tags.push(sc.name);
			}
		}
	}
	if (typeof raw.category === 'string' && !tags.includes(raw.category)) {
		tags.push(raw.category);
	}

	// 只认显式的 `markdown`。上游 list 上的 `overviewMd` 动辄几 KB，20 条一页
	// 会让列表响应白白膨胀；详情走 normalizeDetail，由它把 overviewMd 显式
	// 映射成 markdown 传进来。
	// 注意：这里之前写死 `markdown: null`，把 detail 传进来的值也吞了 ——
	// 详情页因此永远读不到 SKILL.md。
	const mdRaw = raw.markdown;
	const markdown = typeof mdRaw === 'string' && mdRaw.length > 0 ? mdRaw : null;

	// 描述：list 给 description/description_zh，detail 给 summary/summary_zh。
	const description = firstStr(raw.description, raw.summary);
	const descriptionZh = firstStr(raw.description_zh, raw.summary_zh);

	return {
		hub_id: 'skillhub.cn',
		id,
		// `name` 是装进库后当 handle 用的，必须稳定且 ASCII 友好 —— detail 端点
		// 只给 displayName（可能是 "PDF 阅读器"），这里宁可回退 slug。
		name: String(raw.name ?? id),
		display_name: String(raw.displayName ?? raw.display_name ?? raw.name ?? id),
		description,
		description_zh: descriptionZh || null,
		tags: tags.slice(0, 8),
		version: raw.latestVersion?.version ?? raw.version ?? null,
		updated_at: asEpochSec(raw.updatedAt ?? raw.updated_at),
		// list 用扁平 ownerName；detail 用 owner.displayName；publisher 是兜底。
		author:
			raw.ownerName ??
			raw.owner?.displayName ??
			raw.owner_name ??
			raw.publisher?.displayName ??
			raw.publisher ??
			null,
		icon_url: raw.iconUrl ?? raw.icon_url ?? raw.icon ?? null,
		installs: asNum(raw.installs) ?? asNum(raw.stats?.installs),
		downloads: asNum(raw.downloads) ?? asNum(raw.stats?.downloads),
		url: raw.homepage ?? raw.url ?? `https://api.skillhub.cn/${encodeURIComponent(id)}`,
		markdown, // list 通常为 null；详情（overviewMd）才有
		metadata: {
			score: asNum(raw.score),
			source: raw.source ?? null,
			stars: asNum(raw.stars),
			// 单独暴露分类：tags 只保留 8 个，subCategories 一多就会把追加在尾部的
			// category 挤掉，前端按分类过滤时不能依赖 tags。
			category: raw.category ?? null,
		},
	};
}

/** 详情包了一层 `{skill, latestVersion, owner, ...}`，normalize 时合并字段。 */
function normalizeDetail(d) {
	if (!d || typeof d !== 'object') return null;
	const s = d.skill ?? d;
	if (!s) return null;
	const id = String(s.slug ?? d.slug ?? '');
	if (!id) return null;
	const card = normalizeListItem({
		...s,
		...d, // 顶层 latestVersion / owner 优先覆盖
		owner_name: d.owner?.displayName ?? s.owner?.displayName,
		latestVersion: d.latestVersion ?? s.latestVersion,
		stats: s.stats ?? d.stats,
		subCategories: s.subCategories ?? d.subCategories,
		// detail 的字段名和 list 不同：summary/summary_zh 才是描述。
		description: s.description ?? d.description,
		description_zh: s.description_zh ?? d.description_zh,
		stats: s.stats ?? d.stats,
		// markdown：上游字段名是 overviewMd，给个 markdown 别名
		markdown: s.overviewMd ?? s.markdown ?? d.markdown ?? null,
	});
	if (!card) return null;
	return card;
}

/**
 * 列表 / 搜索（page-based，cursor 用 String(page) 伪装给上层）。
 *
 * - `cursor === null`：page=1；非 null 解析为页码（1-based）
 * - 上游 `limit` 被忽略（永远 20 条/页），`page` 才是真分页 —— 见文件头实测记录
 * - 同一页可能出现重复 slug（上游数据里确有两个同名条目），按 id 去重
 * - `total`：上游给的过滤后总量，用来判定末页
 * - 返回 SkillHubPage 永远有 `cards`, `next_cursor`, `total`；卡片通过 normalize
 *
 * 抛 SkillHubError 让上层决定 502/504/...
 */
export async function listSkillCards(_hubId, { q = null, category = null, cursor = null, limit = PAGE_SIZE } = {}) {
	const page = Math.max(1, asInt(cursor, 1));
	const safeLimit = clamp(asInt(limit, PAGE_SIZE), 1, 100);

	const data = await upstream('/api/skills', {
		params: {
			keyword: q || undefined,
			// 上游的 category 是**服务端过滤**（实测 20/20 命中），所以分类浏览
			// 覆盖全部 14 万条，而不是只筛已加载的那一页。
			category: category || undefined,
			page,
			// 透传只为上游哪天认了这个参数时不必再改代码；当前它被忽略。
			limit: safeLimit,
		},
	});

	// 响应包：{ code: 0, data: { skills: [...], total: 149817 }, message: 'success' }
	let items = [];
	let total = null;
	if (data && typeof data === 'object') {
		const inner = data.data ?? data;
		if (Array.isArray(inner?.skills)) items = inner.skills;
		else if (Array.isArray(inner?.results)) items = inner.results;
		else if (Array.isArray(data?.results)) items = data.results;
		if (typeof inner?.total === 'number') total = inner.total;
	}

	// 上游一页里出现过同 slug 的两个条目，保留首个 —— 否则前端按 id 做 key 会
	// 撞，而且"这一页没有新内容"的判定会把它误认为重复页、提前掐断翻页。
	const cards = [];
	const seenIds = new Set();
	for (const raw of items) {
		const card = normalizeListItem(raw);
		if (!card || seenIds.has(card.id)) continue;
		seenIds.add(card.id);
		cards.push(card);
	}

	// page 是 1-based，"下一页"就是 page+1。末页只由两件事决定：上游给了空页，
	// 或者已越过 total 覆盖的范围。**不能**拿 items.length 反推 offset —— 那是
	// 另一种参数（offset）的算法，在 page 语义下会算出永不终止的游标。
	const lastPage = items.length === 0 || (total !== null && page * PAGE_SIZE >= total);
	return { cards, next_cursor: lastPage ? null : String(page + 1), total };
}

/**
 * 详情 — 含 markdown。
 * 失败抛 SkillHubError，server.js 转 404 / 502。
 */
export async function getSkillCard(_hubId, cardId) {
	const data = await upstream(`/api/v1/skills/${encodeURIComponent(cardId)}`);
	return normalizeDetail(data);
}

/** 默认 hub 注册。集中点方便日后从 env / 配置读取。 */
export const DEFAULT_HUB = {
	hub_id: 'skillhub.cn',
	display_name: 'SkillHub.cn（中国）',
	description: '公共技能市场 — 浏览/安装/调用 SKILL.md 技能',
	icon_url: null,
	supports_resolve: false,
};

/**
 * 顶级分类清单。
 *
 * 上游没有分类枚举端点，这份列表是抽样 300 条（sortBy=score / downloads
 * 各若干页）实测出来的：全部样本恰好落在 9 个 category 上、且分布接近均匀，
 * 说明这就是完整的顶层分类集合。`category=<id>` 在上游是**服务端过滤**，
 * 所以分类浏览能覆盖全部 14 万条，而不是只过滤已加载的那一页。
 */
export const CATEGORY_IDS = [
	'office-efficiency',
	'knowledge-management',
	'content-creation',
	'ai-agent',
	'dev-programming',
	'design-media',
	'data-analysis',
	'life-service',
	'professional',
];

export async function listCategories(_hubId) {
	return CATEGORY_IDS.map((id) => ({ id, count: null, approximate: false }));
}
