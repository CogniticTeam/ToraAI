import { useCallback, useEffect, useState } from 'react';

/**
 * Theme preference for the whole app.
 *
 * - `light` / `dark` — user picked one and we apply it unconditionally.
 * - `system` — follow the OS preference; defaults to ``system`` so a
 *   user who never opens settings still gets dark mode at night.
 *
 * Stored in localStorage so the choice survives reloads; the actual
 * `.dark` class on `<html>` is written here AND in ``index.html``'s
 * inline pre-paint script (so a hard reload never flashes white).
 */
export type ThemePreference = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'cocode.theme';

// 窗口原生背景同步桥（Electron 主进程 setBackgroundColor）——「加载页」那块
// 底色跟主题走。浏览器 dev 模式无此桥，跳过即可，那里的首帧由浏览器自己管。
type WindowBridge = { reportTheme: (isDark: boolean) => void };
const windowBridge =
	(window as unknown as { cocodeWindow?: WindowBridge }).cocodeWindow ?? null;

const isValidPreference = (v: unknown): v is ThemePreference =>
	v === 'light' || v === 'dark' || v === 'system';

/**
 * Apply ``preference`` to the document by toggling the ``dark`` class on
 * ``<html>``. When ``system``, the class mirrors the OS-level matchMedia
 * query — so an OS theme change while the app is open updates the UI
 * live, without writing anything.
 *
 * Also reports the effective dark/light to the Electron main process so
 * the window's native background (visible before first paint) matches.
 */
function applyPreference(preference: ThemePreference): void {
	if (typeof document === 'undefined') return;
	const root = document.documentElement;
	const isDark = preference === 'system'
		? window.matchMedia('(prefers-color-scheme: dark)').matches
		: preference === 'dark';
	root.classList.toggle('dark', isDark);
	windowBridge?.reportTheme?.(isDark);
}

/**
 * Reads the saved preference from localStorage without crashing on
 * prerender / SSR / private-mode failures. Defaults to ``system`` so the
 * UI ships matching whatever the user's OS picks.
 */
function readSavedPreference(): ThemePreference {
	if (typeof localStorage === 'undefined') return 'system';
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return isValidPreference(raw) ? raw : 'system';
	} catch {
		return 'system';
	}
}

/**
 * React hook that exposes the current theme preference and lets the
 * settings panel mutate it. Applying the choice to ``<html>`` is a side
 * effect — call ``setPreference`` and the document picks it up.
 *
 * The hook also subscribes to OS preference changes while the user is
 * on ``system``, so flipping the OS dark mode at 9pm still switches the
 * UI without reloading.
 */
export function useTheme() {
	const [preference, setPreferenceState] = useState<ThemePreference>(readSavedPreference);

	// Apply on mount AND every preference change. Mount-time apply covers
	// the case where another tab/window wrote a different preference
	// while this one was closed — the inline index.html script set the
	// DOM on first paint, but our React tree may not have been around.
	useEffect(() => {
		applyPreference(preference);
	}, [preference]);

	// While the user is on `system`, follow the OS in real time. The
	// listener is registered strictly for that mode — otherwise an OS
	// flip would lag behind the user's pinned choice.
	useEffect(() => {
		if (preference !== 'system' || typeof window === 'undefined') return;
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		const onChange = () => applyPreference('system');
		mq.addEventListener('change', onChange);
		return () => mq.removeEventListener('change', onChange);
	}, [preference]);

	// Cross-tab sync — if the settings page writes the preference in one
	// tab, every other tab should pick it up immediately rather than
	// showing stale colors until next reload.
	useEffect(() => {
		if (typeof window === 'undefined') return;
		const onStorage = (e: StorageEvent) => {
			if (e.key !== STORAGE_KEY) return;
			if (!isValidPreference(e.newValue)) return;
			setPreferenceState(e.newValue);
		};
		window.addEventListener('storage', onStorage);
		return () => window.removeEventListener('storage', onStorage);
	}, []);

	const setPreference = useCallback((next: ThemePreference) => {
		setPreferenceState(next);
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// private mode / quota — the in-memory state still works for
			// the current session.
		}
	}, []);

	return { preference, setPreference } as const;
}

/**
 * Standalone helper for non-component code paths (e.g. the
 * ``index.html`` inline pre-paint script) that need to read what the
 * user picked last. The inline script re-applies the choice before first
 * paint, so a reload never flashes the wrong theme.
 */
export const THEME_STORAGE_KEY = STORAGE_KEY;
