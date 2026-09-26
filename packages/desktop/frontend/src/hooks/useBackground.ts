import { useCallback, useEffect, useState } from 'react';

export type BackgroundPreference = 'lavender' | 'mist' | 'stone' | 'midnight' | 'none' | 'custom';

export const BACKGROUND_OPTIONS = [
	{ id: 'lavender', src: '/images/cocode-soft-backdrop.jpg' },
	{ id: 'mist', src: '/images/cocode-mist.jpg' },
	{ id: 'stone', src: '/images/cocode-stone.jpg' },
	{ id: 'midnight', src: '/images/cocode-midnight.jpg' },
] as const;

export const BACKGROUND_STORAGE_KEY = 'cocode.background';
export const CUSTOM_BACKGROUND_STORAGE_KEY = 'cocode.background.custom';
export const BACKGROUND_CHANGED_EVENT = 'cocode:background-changed';

const VALID_OPTIONS: ReadonlySet<string> = new Set<BackgroundPreference>([
	'lavender', 'mist', 'stone', 'midnight', 'none', 'custom',
]);
const CUSTOM_IMAGE_PATTERN = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
const MAX_STORED_IMAGE_LENGTH = 2_500_000;
const MAX_IMPORT_BYTES = 16 * 1024 * 1024;

/** Decode locally, flatten transparency, and bound startup storage cost. */
export async function normalizeBackgroundFile(file: File): Promise<string> {
	if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('background-invalid-type');
	if (file.size > MAX_IMPORT_BYTES) throw new Error('background-too-large');
	let bitmap: ImageBitmap;
	try { bitmap = await createImageBitmap(file); }
	catch { throw new Error('background-process-failed'); }
	try {
		if (bitmap.width * bitmap.height > 80_000_000) throw new Error('background-too-large');
		const scale = Math.min(1, 1920 / bitmap.width, 1200 / bitmap.height);
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const context = canvas.getContext('2d', { alpha: false });
		if (!context) throw new Error('background-process-failed');
		context.fillStyle = '#f5f5f4';
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
		if (dataUrl.length > MAX_STORED_IMAGE_LENGTH) throw new Error('background-storage-full');
		return dataUrl;
	} finally {
		bitmap.close();
	}
}

function readStorage(key: string): string | null {
	try { return localStorage.getItem(key); } catch { return null; }
}

export function getCustomBackground(): string | null {
	const value = readStorage(CUSTOM_BACKGROUND_STORAGE_KEY);
	return value && value.length <= MAX_STORED_IMAGE_LENGTH && CUSTOM_IMAGE_PATTERN.test(value) ? value : null;
}

export function getBackgroundPreference(): BackgroundPreference {
	const value = readStorage(BACKGROUND_STORAGE_KEY);
	if (!value || !VALID_OPTIONS.has(value)) return 'lavender';
	return value === 'custom' && !getCustomBackground() ? 'none' : value as BackgroundPreference;
}

type Snapshot = { preference: BackgroundPreference; customImage: string | null };
const snapshot = (): Snapshot => ({ preference: getBackgroundPreference(), customImage: getCustomBackground() });

/** Presets and a normalized JPEG stay on this device. No background is uploaded. */
export function useBackground() {
	const [current, setCurrent] = useState<Snapshot>(snapshot);

	useEffect(() => {
		const refresh = () => setCurrent(snapshot());
		const onStorage = (event: StorageEvent) => {
			if (event.key === BACKGROUND_STORAGE_KEY || event.key === CUSTOM_BACKGROUND_STORAGE_KEY) refresh();
		};
		window.addEventListener(BACKGROUND_CHANGED_EVENT, refresh);
		window.addEventListener('storage', onStorage);
		return () => {
			window.removeEventListener(BACKGROUND_CHANGED_EVENT, refresh);
			window.removeEventListener('storage', onStorage);
		};
	}, []);

	const setPreference = useCallback((next: BackgroundPreference) => {
		if (!VALID_OPTIONS.has(next) || next === 'custom' && !getCustomBackground()) return;
		localStorage.setItem(BACKGROUND_STORAGE_KEY, next);
		window.dispatchEvent(new Event(BACKGROUND_CHANGED_EVENT));
	}, []);

	const saveCustom = useCallback((dataUrl: string) => {
		if (dataUrl.length > MAX_STORED_IMAGE_LENGTH || !CUSTOM_IMAGE_PATTERN.test(dataUrl)) {
			throw new Error('custom-background-invalid');
		}
		localStorage.setItem(CUSTOM_BACKGROUND_STORAGE_KEY, dataUrl);
		localStorage.setItem(BACKGROUND_STORAGE_KEY, 'custom');
		window.dispatchEvent(new Event(BACKGROUND_CHANGED_EVENT));
	}, []);

	const clearCustom = useCallback(() => {
		const wasSelected = readStorage(BACKGROUND_STORAGE_KEY) === 'custom';
		localStorage.removeItem(CUSTOM_BACKGROUND_STORAGE_KEY);
		if (wasSelected) localStorage.setItem(BACKGROUND_STORAGE_KEY, 'none');
		window.dispatchEvent(new Event(BACKGROUND_CHANGED_EVENT));
	}, []);

	return { ...current, setPreference, saveCustom, clearCustom } as const;
}
