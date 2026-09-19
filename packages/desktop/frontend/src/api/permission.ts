import { client } from './client';

/**
 * One persisted permission rule. These live in `~/.vega/config.json`
 * (`permissionRules`) and are what `decidePermission` consults — they
 * outlive sessions, unlike the per-session permission context.
 */
export interface PermissionRuleRecord {
	tool_name: string;
	/** Pattern the rule matches; empty/null = "any invocation of the tool". */
	rule_content: string | null;
	behavior: 'allow' | 'deny' | 'ask';
	source: string;
}

export const permissionApi = {
	list: () => client.get<{ rules: PermissionRuleRecord[]; total: number }>('/permission/rules'),
	add: (rule: PermissionRuleRecord) =>
		client.post<{ status: string; rule: PermissionRuleRecord; rules: PermissionRuleRecord[] }>(
			'/permission/rules',
			{ rule },
		),
	/** Delete by index in the current list (refresh right after to stay in sync). */
	remove: (index: number) =>
		client.delete<{ status: string; rules: PermissionRuleRecord[] }>('/permission/rules', {
			index: String(index),
		}),
};
