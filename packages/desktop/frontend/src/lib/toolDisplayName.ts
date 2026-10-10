/** Translate UI labels only; protocol names, arguments and results stay unchanged. */
const builtinToolNames = [
	'Bash',
	'Read',
	'Write',
	'Edit',
	'Glob',
	'Grep',
	'TaskCreate',
	'TaskUpdate',
	'TaskGet',
	'TaskList',
	'WebFetch',
	'WebSearch',
	'Browser',
	'WebPreview',
	'Git',
	'RepoMap',
	'Checkpoint',
	'Lsp',
	'Search',
	'AskUserQuestion',
	'Computer',
	'Subagent',
	'MemorySave',
	'MemorySearch',
	'MemoryList',
	'MemoryForget',
	'TeamCreate',
	'AgentCreate',
	'AgentRun',
	'AgentMessage',
	'AgentHandoff',
	'AgentList',
	'TeamDocWrite',
	'TeamDocRead',
	'TeamDelete',
	'TodoWrite',
] as const;

export function getToolDisplayName(name: string, t: (key: string) => string): string {
	const builtin = builtinToolNames.find(tool => tool.toLowerCase() === name.toLowerCase());
	return builtin ? t(`tool.names.${builtin}`) : name;
}
