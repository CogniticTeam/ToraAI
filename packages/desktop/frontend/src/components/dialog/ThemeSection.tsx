import { Check, ImageOff, ImagePlus, LaptopMinimal, Moon, Sun } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';

import { Button } from '@/components/ui/button';
import { BACKGROUND_OPTIONS, normalizeBackgroundFile, useBackground, type BackgroundPreference } from '@/hooks/useBackground';
import { useTheme, type ThemePreference } from '@/hooks/useTheme';
import { useTranslation } from '@/i18n/useI18n';

const MODES = [
	{ value: 'light', icon: Sun },
	{ value: 'dark', icon: Moon },
	{ value: 'system', icon: LaptopMinimal },
] as const;

export function ThemeSection() {
	const { t } = useTranslation();
	const { preference: mode, setPreference: setMode } = useTheme();
	const background = useBackground();
	const fileInput = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const choose = (value: BackgroundPreference) => {
		setError(null);
		if (value === 'custom' && !background.customImage) {
			fileInput.current?.click();
			return;
		}
		try { background.setPreference(value); }
		catch { setError(t('settings.theme.storageFailed')); }
	};

	const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		event.target.value = '';
		if (!file) return;
		setBusy(true);
		setError(null);
		try {
			background.saveCustom(await normalizeBackgroundFile(file));
		} catch (cause) {
			const code = cause instanceof Error ? cause.message : '';
			const key = code === 'background-invalid-type' ? 'invalidType'
				: code === 'background-too-large' ? 'tooLarge'
				: code === 'background-process-failed' ? 'processFailed' : 'storageFailed';
			setError(t(`settings.theme.${key}`));
		} finally {
			setBusy(false);
		}
	};

	const options: Array<{ id: BackgroundPreference; src: string | null }> = [
		...BACKGROUND_OPTIONS.map(option => ({ id: option.id, src: option.src })),
		{ id: 'none', src: null },
		{ id: 'custom', src: background.customImage },
	];

	return (
		<>
			<h3 className="text-lg font-semibold">{t('settings.theme.title')}</h3>
			<p className="mt-2 text-xs text-muted-foreground">{t('settings.theme.subtitle')}</p>
			<div className="mt-5 space-y-5">
				<section className="rounded-xl border border-border bg-card px-5 py-4">
					<div className="text-sm font-medium">{t('settings.theme.modeTitle')}</div>
					<p className="mt-0.5 text-xs text-muted-foreground">{t('settings.theme.modeDesc')}</p>
					<div className="mt-4 inline-flex flex-wrap items-center gap-1 rounded-lg border border-border bg-muted p-1">
						{MODES.map(({ value, icon: Icon }) => {
							const active = mode === value;
							return <button key={value} type="button" aria-pressed={active}
								onClick={() => setMode(value as ThemePreference)}
								className={'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors ' +
									(active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
								<Icon className="size-3.5" />{t(`settings.theme.${value}`)}
							</button>;
						})}
					</div>
				</section>

				<section className="rounded-xl border border-border bg-card px-5 py-4">
					<div className="text-sm font-medium">{t('settings.theme.backgroundTitle')}</div>
					<p className="mt-0.5 text-xs text-muted-foreground">{t('settings.theme.backgroundDesc')}</p>
					<div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
						{options.map(({ id, src }) => {
							const active = background.preference === id;
							return <button key={id} type="button" aria-pressed={active} onClick={() => choose(id)}
								className={'group min-w-0 rounded-rect border p-1.5 text-left transition-[border-color,box-shadow] ' +
									(active ? 'border-foreground ring-2 ring-foreground/15' : 'border-border hover:border-foreground/45')}>
								<span className="relative flex aspect-[1.7] items-center justify-center overflow-hidden rounded-rect-sm bg-background">
									{src ? <img src={src} alt="" loading="lazy" className="size-full object-cover" />
										: id === 'none' ? <ImageOff className="size-6 text-muted-foreground" />
											: <ImagePlus className="size-6 text-muted-foreground" />}
									{active && <span className="absolute right-2 top-2 flex size-5 items-center justify-center rounded-full bg-foreground text-background"><Check className="size-3" /></span>}
								</span>
								<span className="block px-1.5 pb-1 pt-2 text-xs font-medium">{t(`settings.theme.${id}`)}</span>
							</button>;
						})}
					</div>
					<div className="mt-4 flex flex-wrap items-center gap-2">
						<Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>
							<ImagePlus className="size-4" />{t(background.customImage ? 'settings.theme.replace' : 'settings.theme.import')}
						</Button>
						{background.customImage && <Button type="button" size="sm" variant="ghost" onClick={() => { try { background.clearCustom(); setError(null); } catch { setError(t('settings.theme.storageFailed')); } }}>
							{t('settings.theme.remove')}
						</Button>}
					</div>
					<input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={event => void importFile(event)} aria-label={t('settings.theme.import')} />
					<p className="mt-3 text-xs text-muted-foreground">{t('settings.theme.localOnly')}</p>
					{error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
				</section>
			</div>
		</>
	);
}
