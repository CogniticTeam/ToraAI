// 公共资源 hub 的客户端错误类型。
//
// 两个上游（SkillHub / OpenAgentSkill）的客户端共用同一个错误形状，
// server.js 只认 `instanceof HubError`，不必按源分支。
export class HubError extends Error {
	constructor(message, { status = 0, upstream = null } = {}) {
		super(message);
		this.name = 'HubError';
		/** 建议回给前端的 HTTP 状态码；0 表示"连不上"。 */
		this.status = status;
		/** 上游原始响应片段，便于排错。 */
		this.upstream = upstream;
	}
}

/** 历史别名：skillhub.js 早先导出的是这个名字。 */
export const SkillHubError = HubError;
