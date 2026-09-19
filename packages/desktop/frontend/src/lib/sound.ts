// 提示音引擎。
//
// - 内置音效用 Web Audio API 实时合成（振荡器 + 指数衰减包络）：零音频
//   资源文件、零版权顾虑，也不往 dist 里塞东西。
// - 自定义音效存 IndexedDB（Blob）。音频文件对 localStorage 的 5MB 配额
//   太大，IndexedDB 配额宽裕，且不需要动主进程。
// - 开关/音量/音效种类等配置存 localStorage 的 ``cocode_sound``（应用内
//   轻量配置的同款惯例），读取失败一律回默认值。
// - ``playNotificationSound`` 是触发点用的入口，内置同事件 1.5s 防抖 ——
//   SSE 重连回放可能重投同一事件，别响成连击。

export type SoundEvent = 'reply_done' | 'need_confirm';

export type SoundKind = 'ding' | 'crisp' | 'soft' | 'custom';

export const SOUND_KINDS: SoundKind[] = ['ding', 'crisp', 'soft', 'custom'];

export interface SoundSettings {
	enabled: boolean;
	replyDone: boolean;
	needConfirm: boolean;
	kind: SoundKind;
	volume: number;
}

const STORAGE_KEY = 'cocode_sound';

const DEFAULTS: SoundSettings = {
	enabled: true,
	replyDone: true,
	needConfirm: true,
	kind: 'ding',
	volume: 0.6,
};

export function loadSoundSettings(): SoundSettings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULTS };
		const p = JSON.parse(raw) as Partial<SoundSettings>;
		return {
			enabled: p.enabled !== false,
			replyDone: p.replyDone !== false,
			needConfirm: p.needConfirm !== false,
			kind: SOUND_KINDS.includes(p.kind as SoundKind) ? (p.kind as SoundKind) : DEFAULTS.kind,
			volume: typeof p.volume === 'number' ? Math.min(1, Math.max(0, p.volume)) : DEFAULTS.volume,
		};
	} catch {
		return { ...DEFAULTS };
	}
}

export function saveSoundSettings(next: SoundSettings): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		// 配额/隐私模式等异常：提示音属于体验项，静默失败即可。
	}
}

// ---- 自定义音效（IndexedDB）----

export interface CustomSoundRecord {
	name: string;
	type: string;
	blob: Blob;
}

const DB_NAME = 'cocode-sounds';
const DB_STORE = 'files';
const DB_KEY = 'custom';

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			req.result.createObjectStore(DB_STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
	});
}

export async function saveCustomSound(file: File): Promise<void> {
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(DB_STORE, 'readwrite');
		tx.objectStore(DB_STORE).put({ name: file.name, type: file.type, blob: file }, DB_KEY);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error('indexedDB write failed'));
	});
	db.close();
}

export async function clearCustomSound(): Promise<void> {
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(DB_STORE, 'readwrite');
		tx.objectStore(DB_STORE).delete(DB_KEY);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error('indexedDB delete failed'));
	});
	db.close();
}

export async function getCustomSound(): Promise<CustomSoundRecord | null> {
	try {
		const db = await openDb();
		const rec = await new Promise<CustomSoundRecord | undefined>((resolve, reject) => {
			const tx = db.transaction(DB_STORE, 'readonly');
			const req = tx.objectStore(DB_STORE).get(DB_KEY);
			req.onsuccess = () => resolve(req.result as CustomSoundRecord | undefined);
			req.onerror = () => reject(req.error ?? new Error('indexedDB read failed'));
		});
		db.close();
		return rec ?? null;
	} catch {
		return null;
	}
}

// ---- 播放 ----

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
	if (!audioCtx) {
		const Ctor =
			window.AudioContext ??
			(window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
		audioCtx = new Ctor();
	}
	return audioCtx;
}

/** 单个音符：startAt 起播，快速起音后指数衰减到静音。 */
function tone(
	ctx: AudioContext,
	freq: number,
	startAt: number,
	dur: number,
	vol: number,
	type: OscillatorType,
): void {
	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.type = type;
	osc.frequency.value = freq;
	gain.gain.setValueAtTime(0.0001, startAt);
	gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), startAt + 0.015);
	gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
	osc.connect(gain);
	gain.connect(ctx.destination);
	osc.start(startAt);
	osc.stop(startAt + dur + 0.05);
}

async function playSynth(kind: Exclude<SoundKind, 'custom'>, volume: number): Promise<void> {
	const ctx = getAudioContext();
	if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
	const t = ctx.currentTime + 0.01;
	if (kind === 'ding') {
		tone(ctx, 880, t, 0.35, volume * 0.5, 'sine');
	} else if (kind === 'crisp') {
		tone(ctx, 880, t, 0.12, volume * 0.45, 'sine');
		tone(ctx, 1318.5, t + 0.1, 0.28, volume * 0.45, 'sine');
	} else {
		tone(ctx, 523.25, t, 0.4, volume * 0.4, 'triangle');
		tone(ctx, 659.25, t + 0.12, 0.42, volume * 0.35, 'triangle');
	}
}

async function play(s: SoundSettings): Promise<void> {
	if (s.kind === 'custom') {
		const rec = await getCustomSound();
		if (rec) {
			const url = URL.createObjectURL(rec.blob);
			const el = new Audio(url);
			el.volume = s.volume;
			el.addEventListener('ended', () => URL.revokeObjectURL(url));
			await el.play();
			return;
		}
		// 自定义文件不存在（没选成功/已被清）——回退内置「叮」。
	}
	await playSynth(s.kind === 'custom' ? 'ding' : s.kind, s.volume);
}

const DEBOUNCE_MS = 1500;
const lastPlayedAt: Partial<Record<SoundEvent, number>> = {};

/** 触发点入口：读配置、过事件开关与防抖后播放。所有失败静默。 */
export function playNotificationSound(event: SoundEvent): void {
	const s = loadSoundSettings();
	if (!s.enabled) return;
	if (event === 'reply_done' && !s.replyDone) return;
	if (event === 'need_confirm' && !s.needConfirm) return;
	const now = Date.now();
	const last = lastPlayedAt[event];
	if (last !== undefined && now - last < DEBOUNCE_MS) return;
	lastPlayedAt[event] = now;
	void play(s).catch(() => undefined);
}

/** 设置里的试听：绕过开关与防抖，按当前设置直接播。 */
export function previewSound(): void {
	void play(loadSoundSettings()).catch(() => undefined);
}
