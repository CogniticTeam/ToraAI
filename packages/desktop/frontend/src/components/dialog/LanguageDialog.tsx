import { Check, Languages, Monitor, Search, X } from 'lucide-react';
import { useState } from 'react';

import {
	Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { getSystemLocale, LANGUAGE_OPTIONS, normalizeLanguage, setAppLanguage, type AppLanguage } from '@/i18n';
import { useTranslation } from '@/i18n/useI18n';

export function LanguageDialog({ onClose }: { onClose: () => void }) {
	const { i18n, t } = useTranslation();
	const [suggestionDismissed, setSuggestionDismissed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	const [search, setSearch] = useState('');
	const current = normalizeLanguage(i18n.language) ?? 'en';
	const system = normalizeLanguage(getSystemLocale());
	const systemOption = system && system !== current && !suggestionDismissed
		? LANGUAGE_OPTIONS.find((option) => option.value === system) : null;
	const languageName = (key: string, fallback: string) => t(`settings.general.language.${key}`, { defaultValue: fallback });
	const query = search.trim().normalize('NFKC').toLocaleLowerCase();
	const filteredOptions = LANGUAGE_OPTIONS.filter((option) =>
		`${option.value} ${option.nativeName} ${option.englishName} ${option.chineseName} ${option.aliases} ${languageName(option.key, option.nativeName)}`
			.normalize('NFKC').toLocaleLowerCase().includes(query),
	);
	const searchLabel = t('languageDialog.search');
	const emptyLabel = t('languageDialog.noResults');

	const selectLanguage = async (language: AppLanguage) => {
		if (busy) return;
		setBusy(true);
		setError(false);
		try {
			await setAppLanguage(language);
			onClose();
		} catch {
			setError(true);
			setBusy(false);
		}
	};

	return (
		<Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
			<DialogContent showCloseButton={false} overlayClassName="z-[110]" className="z-[111] gap-0 overflow-hidden p-0 sm:max-w-[26rem]">
				<div className="px-5 pb-5 pt-5 sm:px-6 sm:pt-6">
					<div className="flex items-start justify-between gap-4">
						<DialogHeader className="gap-1.5">
							<DialogTitle className="flex items-center gap-2 text-lg">
									<Languages className="size-5" aria-hidden="true" /> {t('settings.general.language.title')}
								</DialogTitle>
								<DialogDescription>{t('languageDialog.subtitle')}</DialogDescription>
						</DialogHeader>
							<button type="button" onClick={onClose} aria-label={t('languageDialog.close')}
							className="-mr-1 -mt-1 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
							<X className="size-4" aria-hidden="true" />
						</button>
						</div>

						<div className="relative mt-5">
							<label htmlFor="language-search" className="sr-only">{searchLabel}</label>
								<Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground rtl:left-auto rtl:right-3.5" aria-hidden="true" />
							<input
								id="language-search"
								type="search"
								autoComplete="off"
									spellCheck={false}
									dir="auto"
								value={search}
								onChange={(event) => setSearch(event.target.value)}
								placeholder={searchLabel}
									className="h-10 w-full rounded-xl border border-border bg-background/70 pl-10 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25 rtl:pl-3 rtl:pr-10"
							/>
						</div>

						{systemOption && system && (
							<div className="mt-4 rounded-xl border border-border bg-muted/50 p-4" lang={current}>
								<div className="flex items-start gap-2.5">
									<Monitor className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
									<p className="text-sm leading-6">{t('languageDialog.systemSuggestion', { language: languageName(systemOption.key, systemOption.nativeName) })}</p>
							</div>
							<div className="mt-3 flex flex-wrap justify-end gap-2">
								<button type="button" onClick={() => setSuggestionDismissed(true)}
									className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-background hover:text-foreground">
										{t('languageDialog.later')}
								</button>
								<button type="button" disabled={busy} onClick={() => void selectLanguage(system)}
									className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-85 disabled:opacity-50">
										{t('languageDialog.switch', { language: languageName(systemOption.key, systemOption.nativeName) })}
								</button>
							</div>
						</div>
					)}

						<div className="mt-4 h-[13.5rem] max-h-[35vh] space-y-2 overflow-y-auto" role="group" aria-label={t('settings.general.language.title')}>
							{filteredOptions.map((option) => {
							const localized = languageName(option.key, option.nativeName);
							const secondary = localized !== option.nativeName ? localized
								: option.englishName !== option.nativeName ? option.englishName : option.chineseName;
							return (
								<button key={option.value} type="button" disabled={busy}
									aria-label={`${option.nativeName} / ${secondary}`}
									aria-pressed={current === option.value}
									onClick={() => void selectLanguage(option.value)}
									className="flex w-full items-center gap-3 rounded-xl border border-border px-4 py-3 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 data-[selected=true]:border-foreground/40 data-[selected=true]:bg-muted/60"
									data-selected={current === option.value}>
									<span className="flex min-w-0 flex-1 flex-col gap-0.5">
											<span className="text-sm font-medium" lang={option.value}>{option.nativeName}</span>
											<span className="text-xs text-muted-foreground" lang={current}>{secondary}</span>
									</span>
									{current === option.value && <Check className="size-4 shrink-0" aria-hidden="true" />}
								</button>
							);
							})}
							{filteredOptions.length === 0 && (
								<p role="status" className="flex h-full items-center justify-center text-sm text-muted-foreground">{emptyLabel}</p>
							)}
					</div>
							{error && <p role="alert" className="mt-3 text-xs text-destructive">{t('languageDialog.switchError')}</p>}
				</div>
			</DialogContent>
		</Dialog>
	);
}
