// 提示音引擎。
//
// - 内置音效用 Web Audio API 实时合成：多层泛音、立体声展开、短混响、
//   动态压缩与平滑包络组成完整音色，保持零音频资源和零版权顾虑。
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
const reverbCache = new WeakMap<AudioContext, AudioBuffer>();

function getAudioContext(): AudioContext {
	if (!audioCtx) {
		const Ctor =
			window.AudioContext ??
			(window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
		audioCtx = new Ctor();
	}
	return audioCtx;
}
function getReverbImpulse(ctx: AudioContext): AudioBuffer {
	const cached = reverbCache.get(ctx);
	if (cached) return cached;

	// 很短的双声道 room impulse：只负责给尾音增加空间，不制造明显回声。
	const length = Math.floor(ctx.sampleRate * 0.72);
	const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
	for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
		const data = impulse.getChannelData(channel);
		for (let i = 0; i < length; i += 1) {
			const progress = i / length;
			const decay = Math.pow(1 - progress, 3.4);
			data[i] = (Math.random() * 2 - 1) * decay * (channel === 0 ? 0.92 : 1);
		}
	}
	reverbCache.set(ctx, impulse);
	return impulse;
}

/** 每次播放独立的输出总线，避免快速连续试听时音量包络互相覆盖。 */
function createOutputBus(ctx: AudioContext, volume: number): {
	input: GainNode;
	disposeAfter: (seconds: number) => void;
} {
	const input = ctx.createGain();
	const dry = ctx.createGain();
	const wet = ctx.createGain();
	const reverb = ctx.createConvolver();
	const colour = ctx.createBiquadFilter();
	const compressor = ctx.createDynamicsCompressor();
	const output = ctx.createGain();

	dry.gain.value = 0.9;
	wet.gain.value = 0.14;
	reverb.buffer = getReverbImpulse(ctx);
	colour.type = 'lowpass';
	colour.frequency.value = 12_500;
	colour.Q.value = 0.22;
	compressor.threshold.value = -24;
	compressor.knee.value = 18;
	compressor.ratio.value = 3.2;
	compressor.attack.value = 0.004;
	compressor.release.value = 0.18;
	output.gain.value = Math.min(1, Math.max(0, volume)) * 0.72;

	input.connect(dry);
	dry.connect(colour);
	input.connect(reverb);
	reverb.connect(wet);
	wet.connect(colour);
	colour.connect(compressor);
	compressor.connect(output);
	output.connect(ctx.destination);

	const nodes: AudioNode[] = [input, dry, wet, reverb, colour, compressor, output];
	return {
		input,
		disposeAfter(seconds) {
			window.setTimeout(() => {
				for (const node of nodes) node.disconnect();
			}, Math.ceil(seconds * 1000));
		},
	};
}

interface VoiceOptions {
	frequency: number;
	startAt: number;
	duration: number;
	level: number;
	type?: OscillatorType;
	attack?: number;
	pan?: number;
	detune?: number;
	glide?: number;
}

/** 平滑起音、自然衰减的单层泛音；每层都做轻微频率漂移，避免机械感。 */
function voice(ctx: AudioContext, destination: AudioNode, options: VoiceOptions): void {
	const {
		frequency,
		startAt,
		duration,
		level,
		type = 'sine',
		attack = 0.008,
		pan = 0,
		detune = 0,
		glide = 0.996,
	} = options;
	const osc = ctx.createOscillator();
	const filter = ctx.createBiquadFilter();
	const envelope = ctx.createGain();
	const stereo = ctx.createStereoPanner();
	const endAt = startAt + duration;

	osc.type = type;
	osc.detune.value = detune;
	osc.frequency.setValueAtTime(frequency, startAt);
	osc.frequency.exponentialRampToValueAtTime(frequency * glide, endAt);
	filter.type = 'lowpass';
	filter.frequency.value = Math.min(15_000, Math.max(3_800, frequency * 7));
	filter.Q.value = 0.35;
	stereo.pan.value = Math.min(1, Math.max(-1, pan));
	envelope.gain.setValueAtTime(0.0001, startAt);
	envelope.gain.linearRampToValueAtTime(Math.max(0.0001, level), startAt + attack);
	envelope.gain.exponentialRampToValueAtTime(0.0001, endAt);

	osc.connect(filter);
	filter.connect(envelope);
	envelope.connect(stereo);
	stereo.connect(destination);
	osc.start(startAt);
	osc.stop(endAt + 0.04);
}

/** 一颗带自然泛音的玻璃质感音符。 */
function bell(
	ctx: AudioContext,
	destination: AudioNode,
	frequency: number,
	startAt: number,
	duration: number,
	level: number,
	pan: number,
): void {
	voice(ctx, destination, { frequency, startAt, duration, level, pan });
	voice(ctx, destination, {
		frequency: frequency * 2.01,
		startAt: startAt + 0.002,
		duration: duration * 0.68,
		level: level * 0.22,
		pan: -pan * 0.65,
		detune: 2,
	});
	voice(ctx, destination, {
		frequency: frequency * 3.98,
		startAt: startAt + 0.004,
		duration: duration * 0.4,
		level: level * 0.065,
		pan: pan * 0.4,
		detune: -3,
	});
}

/** 清脆音色的极短空气瞬态，让声音清楚但不尖锐。 */
function airTransient(ctx: AudioContext, destination: AudioNode, startAt: number): void {
	const duration = 0.045;
	const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
	const samples = buffer.getChannelData(0);
	for (let i = 0; i < samples.length; i += 1) {
		const decay = Math.pow(1 - i / samples.length, 3);
		samples[i] = (Math.random() * 2 - 1) * decay;
	}
	const source = ctx.createBufferSource();
	const highpass = ctx.createBiquadFilter();
	const gain = ctx.createGain();
	source.buffer = buffer;
	highpass.type = 'highpass';
	highpass.frequency.value = 4_200;
	highpass.Q.value = 0.5;
	gain.gain.value = 0.035;
	source.connect(highpass);
	highpass.connect(gain);
	gain.connect(destination);
	source.start(startAt);
}

async function playSynth(kind: Exclude<SoundKind, 'custom'>, volume: number): Promise<void> {
	const ctx = getAudioContext();
	if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
	const t = ctx.currentTime + 0.025;
	const bus = createOutputBus(ctx, volume);
	if (kind === 'ding') {
		bell(ctx, bus.input, 659.25, t, 0.62, 0.34, -0.12);
		bell(ctx, bus.input, 987.77, t + 0.075, 0.76, 0.27, 0.14);
	} else if (kind === 'crisp') {
		airTransient(ctx, bus.input, t);
		bell(ctx, bus.input, 783.99, t, 0.24, 0.3, -0.18);
		bell(ctx, bus.input, 1174.66, t + 0.07, 0.42, 0.3, 0.18);
	} else {
		voice(ctx, bus.input, { frequency: 392, startAt: t, duration: 0.7, level: 0.2, type: 'triangle', pan: -0.16, attack: 0.028 });
		voice(ctx, bus.input, { frequency: 493.88, startAt: t + 0.085, duration: 0.76, level: 0.17, type: 'triangle', pan: 0.08, attack: 0.032 });
		voice(ctx, bus.input, { frequency: 587.33, startAt: t + 0.17, duration: 0.82, level: 0.14, type: 'sine', pan: 0.18, attack: 0.035 });
	}
	bus.disposeAfter(1.9);
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
