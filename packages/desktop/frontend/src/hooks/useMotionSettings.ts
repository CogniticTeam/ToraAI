import { useSyncExternalStore } from 'react';

export type MotionMode = 'system' | 'off' | 'gentle' | 'standard' | 'fast';

const MODE_KEY = 'tora.motion.mode';
const CLICK_KEY = 'tora.motion.click';
const PAGE_KEY = 'tora.motion.page';
const CHANGE_EVENT = 'tora:motion-changed';
const MODES = new Set<MotionMode>(['system', 'off', 'gentle', 'standard', 'fast']);

function read(key: string): string | null {
	try { return localStorage.getItem(key); } catch { return null; }
}

function motionMode(): MotionMode {
	const value = read(MODE_KEY) as MotionMode;
	return MODES.has(value) ? value : 'system';
}

function reduced(): boolean {
	return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function snapshot(): string {
	return `${motionMode()}|${read(CLICK_KEY) === '0' ? '0' : '1'}|${read(PAGE_KEY) === '0' ? '0' : '1'}|${reduced() ? '1' : '0'}`;
}

function subscribe(onChange: () => void) {
	const onStorage = (event: StorageEvent) => {
		if ([MODE_KEY, CLICK_KEY, PAGE_KEY].includes(event.key || '')) onChange();
	};
	const media = window.matchMedia('(prefers-reduced-motion: reduce)');
	window.addEventListener('storage', onStorage);
	window.addEventListener(CHANGE_EVENT, onChange);
	media.addEventListener('change', onChange);
	return () => {
		window.removeEventListener('storage', onStorage);
		window.removeEventListener(CHANGE_EVENT, onChange);
		media.removeEventListener('change', onChange);
	};
}

function save(key: string, value: string) {
	try { localStorage.setItem(key, value); } catch { /* 私密模式下保持默认值。 */ }
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useMotionSettings() {
	const [savedMode, click, page, reduce] = useSyncExternalStore(subscribe, snapshot, () => 'system|1|1|0').split('|');
	const mode = savedMode as MotionMode;
	const effective: Exclude<MotionMode, 'system'> = reduce === '1' || mode === 'off'
		? 'off' : mode === 'system' ? 'standard' : mode;
	return {
		mode,
		effective,
		systemReduced: reduce === '1',
		clickEnabled: click === '1',
		pageEnabled: page === '1',
		setMode: (next: MotionMode) => { if (MODES.has(next)) save(MODE_KEY, next); },
		setClickEnabled: (enabled: boolean) => save(CLICK_KEY, enabled ? '1' : '0'),
		setPageEnabled: (enabled: boolean) => save(PAGE_KEY, enabled ? '1' : '0'),
	};
}
