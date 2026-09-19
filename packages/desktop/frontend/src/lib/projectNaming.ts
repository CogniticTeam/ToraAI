/**
 * 项目名称是客户端导航偏好，而非 agent 的运行配置：同一目录下的所有
 * 会话共用一个名称，并保存在当前设备，避免为了改显示名改写每条会话。
 */
const STORAGE_KEY = 'cocode-project-names-v1';
export const PROJECT_NAMES_CHANGED_EVENT = 'cocode-project-names-changed';

type ProjectNames = Record<string, string>;

function readNames(): ProjectNames {
	if (typeof window === 'undefined') return {};
	try {
		const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed).filter((entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[1].trim().length > 0,
			),
		);
	} catch {
		return {};
	}
}

export function projectKey(cwd: string | null): string | null {
	if (!cwd?.trim()) return null;
	return cwd.trim().replace(/\/+$/, '');
}

export function projectBasename(cwd: string): string {
	const normalized = cwd.replace(/\/+$/, '');
	const separator = normalized.lastIndexOf('/');
	return separator === -1 ? normalized : normalized.slice(separator + 1);
}

export function getProjectDisplayName(cwd: string | null): string | null {
	const key = projectKey(cwd);
	if (!key) return null;
	return readNames()[key] ?? projectBasename(key);
}

/** 保存名称；传入空值会恢复为文件夹原名。 */
export function setProjectDisplayName(cwd: string, name: string | null): void {
	const key = projectKey(cwd);
	if (!key || typeof window === 'undefined') return;
	const names = readNames();
	const normalizedName = name?.trim() ?? '';
	if (!normalizedName || normalizedName === projectBasename(key)) {
		delete names[key];
	} else {
		names[key] = normalizedName.slice(0, 40);
	}
	window.localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
	window.dispatchEvent(new Event(PROJECT_NAMES_CHANGED_EVENT));
}
