import { client } from './client';
import type {
	HubBrowseParams,
	HubCategory,
	HubInfo,
	InstallMCPRequest,
	MCPCard,
	MCPHubPage,
	MCPView,
	SkillCard,
	SkillHubPage,
	SkillResolveResult,
	SkillView,
} from './types';

/**
 * Card ids are opaque and may contain characters that are not path-safe —
 * ClawHub's search endpoint, for one, returns ids containing `:`.
 */
const segment = (value: string) => encodeURIComponent(value);

/** Drop empty filters so the backend applies its own defaults. */
function browseQuery(params?: HubBrowseParams): Record<string, string> {
	const query: Record<string, string> = {};
	if (params?.q) query.q = params.q;
	if (params?.category) query.category = params.category;
	if (params?.cursor) query.cursor = params.cursor;
	if (params?.limit !== undefined) query.limit = String(params.limit);
	return query;
}

/**
 * Resource hubs. Browsing is three levels deep — pick a hub, browse its
 * cards, install one. Cards are never merged across hubs, so each hub
 * paginates on its own.
 */
export const hubApi = {
	mcp: {
		listHubs: () => client.get<HubInfo[]>('/hub/mcp'),

		listCards: (hubId: string, params?: HubBrowseParams) =>
			client.get<MCPHubPage>(`/hub/mcp/${segment(hubId)}/cards`, browseQuery(params)),

		getCard: (hubId: string, cardId: string) =>
			client.get<MCPCard>(`/hub/mcp/${segment(hubId)}/cards/${segment(cardId)}`),

		/**
		 * Renders the card's template with `body.values` into the user's
		 * library. No workspace is involved — putting the MCP into a session
		 * is a separate act. The config is not connection-tested, so a wrong
		 * API key surfaces on first use, not here. A 409 means the name is
		 * taken — retry with `body.name` set.
		 */
		install: (
			hubId: string,
			cardId: string,
			body: InstallMCPRequest,
			options?: { silent?: boolean },
		) =>
			client.post<MCPView>(
				`/hub/mcp/${segment(hubId)}/cards/${segment(cardId)}/install`,
				body,
				undefined,
				options,
			),
	},

	skill: {
		listHubs: () => client.get<HubInfo[]>('/hub/skill'),

		listCards: (hubId: string, params?: HubBrowseParams) =>
			client.get<SkillHubPage>(`/hub/skill/${segment(hubId)}/cards`, browseQuery(params)),

		/**
		 * The hub's category taxonomy. A hub may derive it from a catalog page
		 * rather than exposing an enum — `approximate` on each entry says which.
		 * Empty array when the hub has no categories at all.
		 */
		listCategories: (hubId: string) =>
			client.get<HubCategory[]>(`/hub/skill/${segment(hubId)}/categories`),

		/**
		 * Ask the hub which skill fits a task. Returns a ranking (one winner
		 * plus runners-up), not a browsable list — pair it with the browse
		 * view rather than replacing it. Only hubs with `supports_resolve`.
		 */
		resolve: (hubId: string, task: string, agent?: string) =>
			client.get<SkillResolveResult>(`/hub/skill/${segment(hubId)}/resolve`, {
				task,
				...(agent ? { agent } : {}),
			}),

		/** Unlike the list endpoint, this also fetches the `SKILL.md` body. */
		getCard: (hubId: string, cardId: string) =>
			client.get<SkillCard>(`/hub/skill/${segment(hubId)}/cards/${segment(cardId)}`),

		/**
		 * Records the card in the user's library. Like the MCP install this
		 * touches no workspace, and it does not download the archive — that
		 * happens when the skill is put into a workspace. A 409 means the
		 * name is taken; retry with `name` set.
		 */
		install: (hubId: string, cardId: string, name?: string, options?: { silent?: boolean }) =>
			client.post<SkillView>(
				`/hub/skill/${segment(hubId)}/cards/${segment(cardId)}/install`,
				undefined,
				name ? { name } : undefined,
				options,
			),
	},
};
