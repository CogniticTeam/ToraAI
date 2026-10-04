import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/i18n/useI18n';
import { catgirlCopy, refreshCatgirlSettings, updateCatgirlSettings, useCatgirlSettings } from '@/lib/catgirl';

export function CatgirlPersonaSection() {
	const { i18n } = useTranslation();
	const copy = catgirlCopy(i18n.language);
	const { installed, enabled } = useCatgirlSettings();
	const [ready, setReady] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<'load' | 'save' | null>(null);
	async function load() {
		setBusy(true);
		setError(null);
		try { await refreshCatgirlSettings(); setReady(true); }
		catch { setError('load'); }
		finally { setBusy(false); }
	}
	useEffect(() => { void load(); }, []);
	async function toggle(next: boolean) {
		setBusy(true);
		setError(null);
		try { await updateCatgirlSettings({ enabled: next }); }
		catch { setError('save'); }
		finally { setBusy(false); }
	}
	if (!installed) return null;
	return <div className="mt-5 rounded-xl border border-border p-4">
		<div className="flex items-center justify-between gap-6">
			<div><label htmlFor="catgirl-persona" className="text-sm font-medium">{copy.persona}</label>
				<p className="mt-1 text-xs leading-relaxed text-muted-foreground">{copy.personaDesc}</p></div>
			<Switch id="catgirl-persona" checked={enabled} disabled={!ready || busy} onCheckedChange={next => void toggle(next)} />
		</div>
		{error && <div role="alert" className="mt-2 flex items-center gap-2 text-xs text-destructive">
			{error === 'load' ? copy.loadError : copy.saveError}
			<Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>{copy.retry}</Button>
		</div>}
	</div>;
}
