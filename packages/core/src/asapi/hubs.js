// Skill 来源（hub）注册表。
//
// 把它单独拆出来，是为了让 server.js 的路由**按 hubId 分发**而不是硬编码
// 某一个上游。加新源只需要：写一个导出 { DEFAULT_HUB, listSkillCards,
// getSkillCard, listCategories } 的模块，然后注册进 PROVIDERS。
//
// 各源能力不一致，用 hub 元信息里的开关让前端决定要不要渲染对应入口：
//   supports_resolve  —— 有"按任务推荐"端点（OpenAgentSkill 独有）
import * as openagentskill from './openagentskill.js';
import * as skillhub from './skillhub.js';
import * as skillmd from './skillmd.js';

const PROVIDERS = {
	[skillhub.DEFAULT_HUB.hub_id]: skillhub,
	[openagentskill.DEFAULT_HUB.hub_id]: openagentskill,
	[skillmd.DEFAULT_HUB.hub_id]: skillmd,
};

/** 按顺序展示的 hub 列表。第一个是前端默认选中的来源。 */
export const HUBS = Object.values(PROVIDERS).map((p) => p.DEFAULT_HUB);

/** 取某个 hub 的适配器；未知 hubId 返回 null，由路由层转 404。 */
export function providerFor(hubId) {
	return Object.prototype.hasOwnProperty.call(PROVIDERS, hubId) ? PROVIDERS[hubId] : null;
}

/** 该 hub 是否实现了某个可选能力。 */
export function supports(hubId, capability) {
	const p = providerFor(hubId);
	return typeof p?.[capability] === 'function';
}
