/**
 * 语音输入（Electron 桌面端专属）：
 *   · 麦克风按钮 — 点击开始录音，再次点击结束并转写，结果注入输入框；
 *   · 录音中输入框显示实时波纹 — AnalyserNode 取 RMS 电平驱动柱条起伏；
 *   · 转写走 GLM-ASR-2512 云端 API（主进程编码 WAV 后 POST，无本地模型）。
 *
 * 纯浏览器环境（无 window.cocodeVoice 桥）整个组件不渲染——语音依赖
 * 主进程转发，浏览器里没有这条链路。
 */
import { Loader2, Mic, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { emitCreditsChanged } from '@/hooks/useCreditsBalance';
import { useTranslation } from '@/i18n/useI18n.ts';
import { cn } from '@/lib/utils';

/** preload.cjs 经 contextBridge 暴露的语音桥（仅桌面端存在）。 */
interface VoiceBridge {
	status: () => Promise<{ installed: boolean }>;
	transcribe: (samples: Float32Array) => Promise<string>;
}

function getVoiceBridge(): VoiceBridge | null {
	return (window as unknown as { cocodeVoice?: VoiceBridge }).cocodeVoice ?? null;
}

/** 录音会话：持有媒体流 / 音频上下文 / 采样块，stop() 时统一回收。 */
interface RecordingSession {
	stream: MediaStream;
	ctx: AudioContext;
	analyser: AnalyserNode;
	chunks: Float32Array[];
	stop: () => void;
}

type Phase = 'idle' | 'recording' | 'transcribing';

interface VoiceRecorderProps {
	disabled?: boolean;
	/** 转写完成、有文本时回调（把文本注入输入框）。 */
	onTranscript: (text: string) => void;
	/** 录音/转写期间置 true（父级用来禁用文字输入）。 */
	onBusyChange?: (busy: boolean) => void;
	/** 仅在实际采集声音时触发，用来显示输入框级别的波纹。 */
	onRecordingChange?: (recording: boolean) => void;
	/** 每帧回传归一化音量；由父组件直接驱动整条输入框的波纹。 */
	onAudioLevelChange?: (level: number) => void;
	className?: string;
}

/** 连续静音多久自动停止录音。 */
const SILENCE_STOP_MS = 2000;
/** 16kHz RMS 高于此值视为「在说话」。 */
const VOICE_RMS_THRESHOLD = 0.045;

export function VoiceRecorder({
	disabled,
	onTranscript,
	onBusyChange,
	onRecordingChange,
	onAudioLevelChange,
	className,
}: VoiceRecorderProps) {
	const { t } = useTranslation();
	const bridge = useRef<VoiceBridge | null>(null);
	// 桥是否存在只在挂载时判定一次：桌面端壳层预置桥，浏览器里永远没有
	const [supported] = useState(() => getVoiceBridge() !== null);
	// 转写失败信息（非阻塞，挂在麦克风按钮 tooltip 下方的 toast 语义）
	const [error, setError] = useState<string | null>(null);

	const [phase, setPhase] = useState<Phase>('idle');

	const sessionRef = useRef<RecordingSession | null>(null);
	const rafRef = useRef(0);
	// 静音自动停止：连续 SILENCE_STOP_MS 没有声压 → 自动结束录音
	const lastVoiceAtRef = useRef(0);
	const spokeRef = useRef(false);
	// animateBars 循环里触发 finishRecording 用（避免 useCallback 循环依赖）
	const finishRef = useRef<() => void>(() => {});

	useEffect(() => {
		onBusyChange?.(phase !== 'idle');
		onRecordingChange?.(phase === 'recording');
		if (phase !== 'recording') onAudioLevelChange?.(0);
	}, [phase, onBusyChange, onRecordingChange, onAudioLevelChange]);

	useEffect(() => {
		if (!supported) return;
		bridge.current = getVoiceBridge();
		return () => {
			// 卸载时丢弃录音会话（组件随输入框销毁的场景）
			sessionRef.current?.stop();
			sessionRef.current = null;
			cancelAnimationFrame(rafRef.current);
		};
	}, [supported]);

	/** 用 AnalyserNode 的 RMS 电平驱动父级输入框的整条波纹（不触发 React 重渲染）。 */
	const animateBars = useCallback(function animateBarsLoop() {
		const session = sessionRef.current;
		if (!session) return;
		const data = new Uint8Array(session.analyser.frequencyBinCount);
		session.analyser.getByteTimeDomainData(data);
		let sum = 0;
		for (let i = 0; i < data.length; i++) {
			const v = (data[i] - 128) / 128;
			sum += v * v;
		}
		// RMS → 0..1，放大并限幅；安静时保留最小起伏
		const rms = Math.sqrt(sum / data.length);
		const level = Math.min(1, Math.max(0.08, rms * 6));
		// ---- 静音自动停止：连续 2s 没声 → 结束录音（说过话才转写）----
		{
			const now = performance.now();
			if (rms > VOICE_RMS_THRESHOLD) {
				lastVoiceAtRef.current = now;
				spokeRef.current = true;
			} else if (now - lastVoiceAtRef.current >= SILENCE_STOP_MS) {
				if (spokeRef.current) {
					finishRef.current(); // 有过人声 → finishRecording 负责 stop/清理/转写
				} else {
					// 从头到尾都没出声 → 静默丢弃，不浪费一次 API 调用
					sessionRef.current = null;
					cancelAnimationFrame(rafRef.current);
					session.stop();
					setPhase('idle');
				}
				return;
			}
		}
		onAudioLevelChange?.(level);
		rafRef.current = requestAnimationFrame(animateBarsLoop);
	}, [onAudioLevelChange]);

	/** 结束录音 → 合并采样 → IPC 转写（主进程走 GLM-ASR）→ 注入输入框。 */
	const finishRecording = useCallback(async () => {
		const session = sessionRef.current;
		sessionRef.current = null;
		cancelAnimationFrame(rafRef.current);
		if (!session) return;
		session.stop();
		setPhase('transcribing');
		try {
			const total = session.chunks.reduce((n, c) => n + c.length, 0);
			let text = '';
			// 短于 0.3s 视为误触，不打扰后端
			if (total > 16000 * 0.3) {
				const merged = new Float32Array(total);
				let off = 0;
				for (const c of session.chunks) {
					merged.set(c, off);
					off += c.length;
				}
				text = (await bridge.current?.transcribe(merged)) ?? '';
			}
			if (text) onTranscript(text);
			// 官方 ASR 通道按录音时长扣积分，转写成功后即时刷新侧栏余额
			// （BYOK 通道不扣费，多刷一次 /auth/me 无副作用）
			emitCreditsChanged();
			setError(null);
		} catch (e) {
			console.error('[voice] transcribe failed', e);
			setError(e instanceof Error ? e.message : t('voice.transcribeFailed'));
		} finally {
			setPhase('idle');
		}
	}, [onTranscript, t]);

	useEffect(() => {
		finishRef.current = () => void finishRecording();
	}, [finishRecording]);

	const startRecording = useCallback(async () => {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
			});
			const ctx = new AudioContext({ sampleRate: 16000 });
			const source = ctx.createMediaStreamSource(stream);
			const analyser = ctx.createAnalyser();
			analyser.fftSize = 256;
			source.connect(analyser);
			// ScriptProcessor 虽已标记废弃，但 Chromium 里零依赖采集最省事；
			// connect(destination) 是它运转的必要条件（空增益节点代收）。
			const proc = ctx.createScriptProcessor(4096, 1, 1);
			const chunks: Float32Array[] = [];
			proc.onaudioprocess = (e) => {
				chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
			};
			const sink = ctx.createGain();
			sink.gain.value = 0;
			source.connect(proc);
			proc.connect(sink);
			sink.connect(ctx.destination);

			sessionRef.current = {
				stream,
				ctx,
				analyser,
				chunks,
				stop: () => {
					stream.getTracks().forEach((tr) => tr.stop());
					proc.disconnect();
					source.disconnect();
					void ctx.close();
				},
			};
			const now = performance.now();
			lastVoiceAtRef.current = now;
			spokeRef.current = false;
			setPhase('recording');
			rafRef.current = requestAnimationFrame(animateBars);
		} catch {
			// NotAllowedError 等都归为「麦克风不可用」
			console.error('[voice] getUserMedia failed');
			alert(t('voice.micDenied'));
		}
	}, [animateBars, t]);

	/** 点麦克风：开始/结束录音。Key 未配置时主进程 status 会返回 installed=false。 */
	const handleMicClick = useCallback(async () => {
		if (disabled || !bridge.current) return;
		if (phase === 'recording') {
			void finishRecording();
			return;
		}
		if (phase !== 'idle') return;
		try {
			const st = await bridge.current.status();
			if (!st.installed) {
				setError(t('voice.keyMissing'));
				return;
			}
			void startRecording();
		} catch (e) {
			console.error('[voice] status failed', e);
		}
	}, [disabled, phase, finishRecording, startRecording, t]);

	if (!supported) return null;

	const isRecording = phase === 'recording';

	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon-lg"
						onClick={handleMicClick}
						disabled={disabled || phase === 'transcribing'}
						className={cn(
							'shrink-0 rounded-rect',
							isRecording && 'bg-destructive-soft text-destructive hover:bg-destructive-soft hover:text-destructive',
							className,
						)}
					>
						{phase === 'transcribing' ? (
							<Loader2 className="size-4 animate-spin" />
						) : isRecording ? (
							<Square className="size-3 fill-current" aria-label={t('voice.listening')} />
						) : (
							<Mic className="size-4" />
						)}
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					{isRecording ? t('voice.listening') : phase === 'transcribing' ? t('voice.transcribing') : t('voice.micTooltip')}
				</TooltipContent>
			</Tooltip>

			{/* 转写失败提示（点一下消失） */}
			{error && (
				<button
					type="button"
					onClick={() => setError(null)}
					className="max-w-56 truncate rounded-rect-sm bg-destructive-soft px-3 py-1 text-xs text-destructive"
					title={error}
				>
					{error}
				</button>
			)}
		</>
	);
}
