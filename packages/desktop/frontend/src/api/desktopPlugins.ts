import { useQuery } from '@tanstack/react-query';

import type { McpServerDef } from './mcp-workshop';
import type { SkillView } from './types';
import type { UserCommand } from './workspace';

type NamedEntry = { name: string; description: string };
export type PluginServer = { name: string; command: string; args: string[] };
type PluginManifest = {
	id: string;
	name: string;
	version: string;
	author: string | null;
	description: string;
	skills: (NamedEntry & { markdown: string })[];
	commands: (NamedEntry & { body: string; argumentHint?: string })[];
	mcpServers: PluginServer[];
};

export type NpmRegistry = 'npm' | 'mirror';
type NpmSource = { type: 'npm'; spec: string; registry: NpmRegistry };
export type PluginSource = { type: 'file'; label: string } | { type: 'github'; url: string } | { type: 'catalog' } | (NpmSource & { version: string });
export type PluginInput = (Exclude<PluginSource, { type: 'file' | 'npm' }> | NpmSource | { type: 'file'; label: string; content: string }) & { expectedId?: string };

export type PluginIndex = { name: string; url: string };
export type PluginIndexEntry = { id: string; name: string; description: string; category: string; version: string; source: NpmSource | { type: 'github'; url: string } };
export type InstalledPlugin = Omit<PluginManifest, 'skills' | 'commands'> & {
	revision: string;
	enabled: boolean;
	source: PluginSource;
	skills: NamedEntry[];
	commands: NamedEntry[];
};
export type PluginReview = {
	reviewId: string | null;
	manifest: PluginManifest;
	source: PluginSource;
	previous: InstalledPlugin | null;
};

type Contributions = { skills: SkillView[]; commands: UserCommand[] };
type PluginReply<T> = Promise<{ ok: true; value: T } | { ok: false; code: string }>;
type PluginBridge = {
	list: () => PluginReply<InstalledPlugin[]>;
	contributions: () => PluginReply<Contributions>;
	preview: (input: PluginInput) => PluginReply<PluginReview>;
	previewDirectory: (expectedId?: string) => PluginReply<PluginReview>;
	indexes: () => PluginReply<PluginIndex[]>;
	addIndex: (url: string) => PluginReply<PluginIndex>;
	catalog: (url: string) => PluginReply<{ name: string; plugins: PluginIndexEntry[] }>;
	removeIndex: (url: string) => PluginReply<void>;
	connectGithub: (token: string) => PluginReply<McpServerDef>;
	disconnectGithub: () => PluginReply<void>;
	install: (reviewId: string) => PluginReply<InstalledPlugin>;
	setEnabled: (id: string, revision: string, enabled: boolean) => PluginReply<InstalledPlugin>;
	remove: (id: string, revision: string) => PluginReply<void>;
};

export const DESKTOP_PLUGINS_QUERY = ['desktop-plugins'] as const;
export const isDesktopPluginSkillId = (id: string) => id.startsWith('desktop-plugin:');

export function getDesktopPluginBridge() {
	return (window as Window & { toraPlugins?: PluginBridge }).toraPlugins;
}

export class DesktopPluginError extends Error {}

export async function pluginResult<T>(response: PluginReply<T> | undefined): Promise<T> {
	if (!response) throw new DesktopPluginError('unavailable');
	const result = await response;
	if (!result.ok) throw new DesktopPluginError(result.code);
	return result.value;
}

export function useDesktopPluginContributions() {
	const bridge = getDesktopPluginBridge();
	const { data } = useQuery({
		queryKey: [...DESKTOP_PLUGINS_QUERY, 'contributions'],
		queryFn: () => pluginResult(bridge?.contributions()),
		enabled: Boolean(bridge),
	});
	return data;
}
