// OpenAgentSkill 客户端（www.openagentskill.com）
//
// 公开 API，无需 Token。实测可用端点：
//   GET /api/agent/skills?limit=&q=&category=     目录 / 过滤
//   GET /api/skills/search?q=&limit=              相关性排序搜索（带 rank/match_score）
//   GET /api/agent/skills/{slug}                  详情（含 long_description / install / trust / safety）
//   GET /api/skills/{slug}/install?format=text    安装交接单（纯文本）
//   GET /api/agent/resolve?task=&agent=           按任务推荐技能（该源的"核心"端点）
//
// 关键约束：
// - **没有分页**。offset / page / cursor 全部被忽略，`limit` 上限 50，
//   响应里的 `total` 只是"本次返回条数"而不是全量。所以这个源一律单页返回
//   （`next_cursor: null`），靠 `category` 过滤而不是翻页来收窄。
// - 没有 `overviewMd` 这类正文。真正能喂给模型的是 long_description +
//   安装命令 + 仓库地址，这里合成为 `markdown`（语义 = "交给 LLM 的正文"）。
// - 分类无清单接口，只能从目录页聚合（见 listCategories）。
// - 字段几乎全是英文，没有中文描述。

import { HubError } from './hub-error.js';

const BASE = 'https://www.openagentskill.com';
// 这个上游每条目约 16KB（嵌套 quality / trust / safety / audit 元数据），
// 响应体随 limit 线性膨胀：limit=10 → 160KB/1.9s，limit=20 → 330KB/2~7s，
// limit=50 → 750KB/40s 且**会被截断成非法 JSON**。所以封 20，宁可少给也不超时。
const TIMEOUT_MS = 25000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 20;

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
		throw new HubError(timedOut ? 'openagentskill upstream timeout' : 'openagentskill unreachable', {
			status: timedOut ? 504 : 0,
		});
	}
	clearTimeout(timer);

	if (!res.ok) {
		let body = '';
		try { body = await res.text(); } catch { /* ignore */ }
		throw new HubError(`openagentskill returned ${res.status}: ${body || res.statusText}`, {
			status: res.status,
			upstream: body.slice(0, 500),
		});
	}
	return res.json();
}

/** 纯文本端点（安装交接单）。 */
async function upstreamText(path) {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(new URL(path, BASE).toString(), { signal: ac.signal });
		if (!res.ok) throw new HubError(`openagentskill returned ${res.status}`, { status: res.status });
		return await res.text();
	} catch (e) {
		if (e instanceof HubError) throw e;
		throw new HubError('openagentskill unreachable', { status: 0 });
	} finally {
		clearTimeout(timer);
	}
}

/** 整数安全解析。非数字回 0，交给上层钳位。 */
function asInt(v, def) {
	const n = parseInt(v, 10);
	return Number.isFinite(n) ? n : def;
}

function asNum(v) {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v === 'string' && v.trim() !== '') {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

function firstStr(...vals) {
	for (const v of vals) {
		if (typeof v === 'string' && v.trim() !== '') return v;
	}
	return '';
}

/**
 * 合成"交给 LLM 的正文"。
 *
 * 这个源没有 SKILL.md 正文可拿（正文在上游仓库里，按 `source_evidence.path`
 * 定位，需要 clone 才能读）。能给的可用信息就这些：长描述、安装命令、仓库、
 * 支持平台。合成一段结构化文本比拿 description 硬凑对模型有用得多。
 */
function synthesizeMarkdown(raw) {
	const parts = [];
	const name = firstStr(raw.name, raw.slug);
	const long = firstStr(raw.long_description, raw.description);
	const tagline = firstStr(raw.tagline);
	if (name) parts.push(`# ${name}`);
	if (tagline) parts.push(tagline);
	if (long && long !== tagline) parts.push(long);

	const facts = [];
	if (raw.category) facts.push(`- Category: ${raw.category}`);
	if (Array.isArray(raw.platforms) && raw.platforms.length > 0) {
		facts.push(`- Platforms: ${raw.platforms.join(', ')}`);
	}
	if (raw.repository) facts.push(`- Repository: ${raw.repository}`);
	if (raw.license) facts.push(`- License: ${raw.license}`);
	if (raw.install) facts.push(`- Install: \`${raw.install}\``);
	if (facts.length > 0) parts.push(facts.join('\n'));

	return parts.join('\n\n');
}

/** 上游目录项 → CoCode SkillCard（与 skillhub.js 同一形状）。 */
function normalize(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const id = String(raw.slug ?? raw.id ?? '');
	if (!id) return null;

	const tags = [];
	if (Array.isArray(raw.tags)) {
		for (const t of raw.tags) if (typeof t === 'string' && t) tags.push(t);
	}

	const detailUrl = raw.urls && typeof raw.urls === 'object' ? raw.urls.detail : null;

	return {
		hub_id: 'openagentskill.com',
		id,
		// 这个源只有一个名字字段；`name` 当 handle 用（slug 已是 ASCII 安全），
		// 展示名放 display_name。
		name: id,
		display_name: firstStr(raw.name, id),
		description: firstStr(raw.description, raw.long_description, raw.tagline),
		// 上游无中文描述 → null，前端 skillDescription() 会回退到英文。
		description_zh: null,
		// category 也当标签用，让分类能参与前端关键字过滤。
		tags: (raw.category ? [...tags, raw.category] : tags).slice(0, 8),
		// 上游的 version 是**仓库自身的版本**（几乎全是 '1.0.0'，偶尔 'Unknown'），
		// 不是技能版本，逐卡展示只会是一排无信息量的徽章 —— 一律不展示。
		version: null,
		updated_at: null, // 上游不给时间戳
		author: firstStr(raw.author, raw.attribution?.creatorName) || null,
		icon_url: null,
		installs: asNum(raw.stats?.verified_installs),
		downloads: asNum(raw.stats?.downloads),
		url: detailUrl || `${BASE}/skills/${encodeURIComponent(id)}`,
		markdown: synthesizeMarkdown(raw),
		metadata: {
			score: asNum(raw.quality?.score),
			source: 'openagentskill',
			stars: asNum(raw.stats?.stars),
			category: raw.category ?? null,
			trust: raw.trust?.label ?? null,
			safety: raw.safety?.label ?? null,
			verified: raw.verified === true,
			install_command: firstStr(raw.install) || null,
			repository: firstStr(raw.repository) || null,
			platforms: Array.isArray(raw.platforms) ? raw.platforms : [],
		},
	};
}

/**
 * 目录 / 过滤 / 关键字。
 *
 * 只用一个端点：`/api/agent/skills`。另一个搜索端点 `/api/skills/search`
 * （带 rank / match_score）实测会挂到 60s+ 不返回，不适合放在交互路径上；
 * 而目录端点自己就支持 `q=`，实测 2s 内返回且过滤正确。
 *
 * **没有分页**：offset / page / cursor 全被上游忽略，`total` 只是"本次返回
 * 条数"。所以 `next_cursor` 恒为 null —— 前端因此不渲染"加载更多"，用户靠
 * 分类和关键字收窄。这是上游能力上限，不是我们的省略。
 */
export async function listSkillCards(_hubId, { q = null, category = null, limit = DEFAULT_LIMIT } = {}) {
	const safeLimit = Math.min(Math.max(asInt(limit, DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
	const data = await upstream('/api/agent/skills', {
		params: { q: q || undefined, category: category || undefined, limit: safeLimit },
	});

	let items = [];
	if (Array.isArray(data?.skills)) items = data.skills;
	else if (Array.isArray(data?.results)) items = data.results;

	const cards = items.map(normalize).filter(Boolean);

	return { cards, next_cursor: null, total: asNum(data?.total) ?? cards.length };
}

/** 详情。上游没有比目录项更多的可用字段，但保留这个调用以便将来扩展。 */
export async function getSkillCard(_hubId, cardId) {
	const data = await upstream(`/api/agent/skills/${encodeURIComponent(cardId)}`);
	return normalize(data);
}

/**
 * 分类清单。
 *
 * 上游没有分类枚举端点，只能从目录页聚合。目录默认按质量排序、每页 50，
 * 所以这里拿到的是"最主流的一批分类"，不是全量 —— 因为上游对 category
 * 过滤是服务端生效的，用户点进去依然能拿到该分类下的全部结果，只是
 * 分类清单本身可能不全。
 */
export async function listCategories(_hubId) {
	const data = await upstream('/api/agent/skills', { params: { limit: MAX_LIMIT } });
	// 注意：分类只能从"一页目录"里聚合，所以清单可能不含冷门分类。上游对
	// category= 是服务端过滤，点进去仍能拿到该分类下的完整结果 —— 只是这个
	// 清单本身不保证齐全（每条都标了 approximate）。
	const counts = new Map();
	for (const s of data?.skills ?? []) {
		const c = s?.category;
		if (typeof c === 'string' && c) counts.set(c, (counts.get(c) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([id, count]) => ({ id, count, approximate: true }));
}

/** 按任务推荐技能 —— 这个源的核心端点。 */
export async function resolveTask(_hubId, task, agent = 'codex') {
	if (!task) throw new HubError('task 不能为空', { status: 422 });
	const data = await upstream('/api/agent/resolve', { params: { task, agent } });
	// resolve 的条目把技能字段嵌在 `skill` 里，外层的 rank/match_score 才是
	// 排序信息 —— 直接读 x.slug 会拿到空串。
	const pick = (x) => {
		if (!x || typeof x !== 'object') return null;
		const s = x.skill && typeof x.skill === 'object' ? x.skill : x;
		const id = String(s.slug ?? '');
		if (!id) return null;
		return {
			id,
			display_name: firstStr(s.name, id),
			description: firstStr(s.description),
			category: firstStr(s.category) || null,
			repository: firstStr(s.repository) || null,
			match_score: asNum(x.match_score),
			url: `${BASE}/skills/${encodeURIComponent(id)}`,
		};
	};

	return {
		task: firstStr(data?.task, task),
		agent: firstStr(data?.agent, agent),
		install_command: firstStr(data?.recommendation?.install?.command) || null,
		selected: pick(data?.selected),
		alternatives: (Array.isArray(data?.alternatives) ? data.alternatives : [])
			.map(pick)
			.filter(Boolean)
			.slice(0, 6),
		total_searched: asNum(data?.meta?.total_skills_searched),
		policy: firstStr(data?.policy_decision?.status) || null,
		policy_summary: firstStr(data?.policy_decision?.summary) || null,
	};
}

/**
 * 安装交接单（纯文本）。安装进库时把它并进 markdown，让模型知道这个技能
 * 到底怎么装、装完长什么样。
 */
export async function getInstallNotes(_hubId, cardId) {
	try {
		return await upstreamText(`/api/skills/${encodeURIComponent(cardId)}/install?format=text`);
	} catch {
		return ''; // 拿不到不阻塞安装
	}
}

/** 默认 hub 注册。`categories_from` 说明分类清单是精确枚举还是聚合出来的。 */
export const DEFAULT_HUB = {
	hub_id: 'openagentskill.com',
	display_name: 'OpenAgentSkill.com（海外）',
	description: '公共技能注册表 — 按任务推荐、含信任评分与安全审计',
	icon_url: null,
	// 前端据此显示"任务匹配"入口（该源独有）。
	supports_resolve: true,
};
