import { Check, Languages, Monitor, X } from 'lucide-react';
import { useState } from 'react';

import {
	Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { getSystemLocale, normalizeLanguage, setAppLanguage, type AppLanguage } from '@/i18n';
import { useTranslation } from '@/i18n/useI18n';

const options: { value: AppLanguage; english: string; chineseHans: string; chineseHant: string }[] = [
	{ value: 'en', english: 'English', chineseHans: '英语', chineseHant: '英語' },
	{ value: 'zh', english: 'Simplified Chinese', chineseHans: '简体中文', chineseHant: '簡體中文' },
	{ value: 'zh-Hant', english: 'Traditional Chinese', chineseHans: '繁体中文', chineseHant: '繁體中文' },
];

const systemPrompt: Record<AppLanguage, { message: string; switch: string; later: string; lang: string }> = {
	en: {
		message: 'Your system language is English. Switch to English?',
		switch: 'Switch to English', later: 'Not now', lang: 'en',
	},
	zh: {
		message: '当前您的系统语言为简体中文，是否切换至简体中文？',
		switch: '切换至简体中文', later: '暂不切换', lang: 'zh-CN',
	},
	'zh-Hant': {
		message: '目前您的系統語言為繁體中文，是否切換至繁體中文？',
		switch: '切換至繁體中文', later: '暫不切換', lang: 'zh-Hant',
	},
};

export function LanguageDialog({ onClose }: { onClose: () => void }) {
	const { i18n } = useTranslation();
	const [suggestionDismissed, setSuggestionDismissed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	const current = normalizeLanguage(i18n.language) ?? 'en';
	const system = normalizeLanguage(getSystemLocale());
	const suggestion = system && system !== current && !suggestionDismissed ? systemPrompt[system] : null;

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
								<Languages className="size-5" aria-hidden="true" /> Language
							</DialogTitle>
							<DialogDescription>Choose your language · {current === 'zh-Hant' ? '選擇介面語言' : '选择界面语言'}</DialogDescription>
						</DialogHeader>
						<button type="button" onClick={onClose} aria-label={current === 'zh-Hant' ? 'Close / 關閉' : 'Close / 关闭'}
							className="-mr-1 -mt-1 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
							<X className="size-4" aria-hidden="true" />
						</button>
					</div>

					{suggestion && system && (
						<div className="mt-5 rounded-xl border border-border bg-muted/50 p-4" lang={suggestion.lang}>
							<div className="flex items-start gap-2.5">
								<Monitor className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
								<p className="text-sm leading-6">{suggestion.message}</p>
							</div>
							<div className="mt-3 flex flex-wrap justify-end gap-2">
								<button type="button" onClick={() => setSuggestionDismissed(true)}
									className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-background hover:text-foreground">
									{suggestion.later}
								</button>
								<button type="button" disabled={busy} onClick={() => void selectLanguage(system)}
									className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-85 disabled:opacity-50">
									{suggestion.switch}
								</button>
							</div>
						</div>
					)}

					<div className="mt-5 space-y-2" role="group" aria-label={current === 'zh-Hant' ? 'Language / 語言' : 'Language / 语言'}>
						{options.map((option) => {
							const chinese = current === 'zh-Hant' ? option.chineseHant : option.chineseHans;
							return (
								<button key={option.value} type="button" disabled={busy}
									aria-label={`${option.english} / ${chinese}`}
									aria-pressed={current === option.value}
									onClick={() => void selectLanguage(option.value)}
									className="flex w-full items-center gap-3 rounded-xl border border-border px-4 py-3 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 data-[selected=true]:border-foreground/40 data-[selected=true]:bg-muted/60"
									data-selected={current === option.value}>
									<span className="flex min-w-0 flex-1 flex-col gap-0.5">
										<span className="text-sm font-medium">{option.english}</span>
										<span className="text-xs text-muted-foreground" lang={current === 'zh-Hant' ? 'zh-Hant' : 'zh-CN'}>{chinese}</span>
									</span>
									{current === option.value && <Check className="size-4 shrink-0" aria-hidden="true" />}
								</button>
							);
						})}
					</div>
					{error && <p role="alert" className="mt-3 text-xs text-destructive">Unable to switch language · {current === 'zh-Hant' ? '切換語言失敗' : '切换语言失败'}</p>}
				</div>
			</DialogContent>
		</Dialog>
	);
}
