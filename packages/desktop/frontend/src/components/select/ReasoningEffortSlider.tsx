import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';

import { useMotionSettings } from '@/hooks/useMotionSettings';
import { cn } from '@/lib/utils';

import './reasoning-effort-slider.css';

export interface ReasoningEffortOption {
	value: string;
	label: string;
}

const ADJUSTMENT_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const INTENSITY: Record<string, number> = { off: 0, none: 0, minimal: 0, low: 0, medium: 0.25, high: 0.5, xhigh: 0.75, max: 1, on: 0.5 };
const STARS = Array.from({ length: 22 }, (_, index) => ({
	'--star-y': `${12 + (index * 37) % 76}%`,
	'--star-delay': `${-(index * 0.37)}s`,
	'--star-speed': 0.92 + (index * 7) % 9 / 50,
	'--star-size': `${index % 4 === 0 ? 2.5 : 1.5}px`,
}) as CSSProperties);

function isOff(value: string) {
	return value === 'off' || value === 'none';
}

function visualStyle(index: number, count: number): CSSProperties {
	const position = count > 1 ? index / (count - 1) : 0;
	const colors = [[77, 147, 248], [147, 51, 234], [76, 29, 149]];
	const segment = position < 0.5 ? 0 : 1;
	const blend = (position - segment * 0.5) * 2;
	const color = colors[segment].map((channel, i) => Math.round(channel + (colors[segment + 1][i] - channel) * blend));
	return {
		'--effort-position': position,
		'--effort-percent': `${position * 100}%`,
		'--effort-color': `rgb(${color.join(' ')})`,
		'--effort-energy': Math.max(0, (position - 1 / 3) * 1.5),
	} as CSSProperties;
}

export function ReasoningEffortLabel({ value, options, className }: {
	value: string;
	options: ReasoningEffortOption[];
	className?: string;
}) {
	const index = Math.max(0, options.findIndex(option => option.value === value));
	return <span
		className={cn('reasoning-effort-value', className)}
		data-off={isOff(value)}
		style={visualStyle(index, options.length)}
	>{options[index]?.label}</span>;
}

export function ReasoningEffortSlider({ label, value, options, scope = value, disabled = false, onCommit }: {
	label: string;
	value: string;
	options: ReasoningEffortOption[];
	scope?: string;
	disabled?: boolean;
	onCommit: (value: string) => void | Promise<void>;
}) {
	const labelId = useId();
	const { effective, clickEnabled } = useMotionSettings();
	const motion = clickEnabled ? effective : 'off';
	const [draft, setDraft] = useState<number | null>(null);
	const [pending, setPending] = useState(false);
	const draftRef = useRef<number | null>(null);
	const pendingRef = useRef(false);
	const cancelled = useRef(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const gestureScope = useRef(scope);
	const interaction = useRef<'pointer' | 'keyboard' | null>(null);
	useEffect(() => {
		if (interaction.current && gestureScope.current !== scope) {
			cancelled.current = true;
			draftRef.current = null;
			setDraft(null);
		}
	}, [scope]);
	const index = Math.max(0, options.findIndex(option => option.value === value));
	const shown = draft ?? index;
	const option = options[shown] ?? options[index];
	const locked = disabled || pending || options.length < 2;
	const energy = options.length > 1 ? INTENSITY[option.value] ?? 0 : 0;
	const style = { ...visualStyle(shown, options.length), '--effort-energy': energy } as CSSProperties;

	const preview = (next: number) => {
		draftRef.current = next;
		setDraft(next);
	};
	const cancel = () => {
		interaction.current = null;
		draftRef.current = null;
		setDraft(null);
	};
	const commit = async (next = draftRef.current) => {
		const stale = interaction.current !== null && gestureScope.current !== scope;
		interaction.current = null;
		if (stale || next === null || disabled || pendingRef.current || !options[next] || options[next].value === value) {
			if (!pendingRef.current) cancel();
			return;
		}
		const restoreFocus = document.activeElement === inputRef.current;
		preview(next);
		pendingRef.current = true;
		setPending(true);
		try {
			await onCommit(options[next].value);
		} finally {
			pendingRef.current = false;
			setPending(false);
			cancel();
			if (restoreFocus) requestAnimationFrame(() => {
				const input = inputRef.current;
				if (input && !input.disabled && (document.activeElement === document.body || document.activeElement === input)) input.focus({ preventScroll: true });
			});
		}
	};

	return <section
		className="reasoning-effort"
		data-testid="reasoning-effort"
		data-motion={motion}
		data-off={isOff(option.value)}
		data-energy={energy > 0}
		data-pending={pending}
		aria-busy={pending}
		style={style}
	>
		<div className="reasoning-effort-heading">
			<span id={labelId}>{label}</span>
			<ReasoningEffortLabel value={option.value} options={options} />
		</div>
		<div className="reasoning-effort-control">
			<div className="reasoning-effort-track" aria-hidden="true">
				<div className="reasoning-effort-fill">
					<div className="reasoning-effort-nebula" />
					<div className="reasoning-effort-stars">
						{motion !== 'off' && STARS.slice(0, Math.round(22 * energy)).map((star, i) => <span key={i} style={star} />)}
					</div>
					<div className="reasoning-effort-sweep" />
				</div>
				<div className="reasoning-effort-detents">
					{options.map((stop, i) => <span key={stop.value} data-reached={i <= shown} style={{ left: `${options.length > 1 ? i / (options.length - 1) * 100 : 0}%` }} />)}
				</div>
				<span className="reasoning-effort-thumb" />
			</div>
			<input
				ref={inputRef}
				type="range"
				dir="ltr"
				data-testid="reasoning-effort-slider"
				className="reasoning-effort-input"
				aria-labelledby={labelId}
				aria-valuetext={option.label}
				min={0}
				max={Math.max(0, options.length - 1)}
				step={1}
				value={shown}
				disabled={locked}
				onChange={event => {
					if (cancelled.current) return;
					const next = Number(event.target.value);
					preview(next);
					if (!interaction.current) void commit(next);
				}}
				onPointerDown={event => {
					cancelled.current = false;
					gestureScope.current = scope;
					interaction.current = 'pointer';
					preview(shown);
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onPointerUp={() => {
					if (interaction.current !== 'pointer') return;
					if (cancelled.current) cancel();
					else void commit();
					cancelled.current = false;
				}}
				onPointerCancel={cancel}
				onLostPointerCapture={() => { if (interaction.current === 'pointer') cancel(); }}
				onKeyDown={event => {
					if (event.key === 'Escape' && interaction.current) {
						event.preventDefault();
						event.stopPropagation();
						cancelled.current = true;
						draftRef.current = null;
						setDraft(null);
					} else if (ADJUSTMENT_KEYS.has(event.key)) {
						if (!interaction.current) {
							cancelled.current = false;
							gestureScope.current = scope;
							preview(shown);
						}
						interaction.current = 'keyboard';
						event.stopPropagation();
					}
				}}
				onKeyUp={event => {
					if (ADJUSTMENT_KEYS.has(event.key) && interaction.current === 'keyboard') {
						event.stopPropagation();
						if (cancelled.current) cancel();
						else void commit();
						cancelled.current = false;
					}
				}}
				onBlur={() => {
					if (interaction.current !== 'keyboard') return;
					if (cancelled.current) cancel();
					else void commit();
				}}
			/>
		</div>
		<div className="reasoning-effort-labels" dir="ltr" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
			{options.map((stop, i) => <button
				key={stop.value}
				type="button"
				data-testid="reasoning-effort-tick"
				data-effort={stop.value}
				aria-pressed={i === shown}
				disabled={locked}
				onClick={() => { void commit(i); }}
			>{stop.label}</button>)}
		</div>
	</section>;
}
