import { Cat, Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { installCatgirlLanguagePack } from '@/i18n';
import { catgirlCopy } from '@/lib/catgirl';

export function CatgirlPackDialog({ language, onClose, onAdded }: {
	language: 'zh' | 'ja'; onClose: () => void; onAdded: () => void;
}) {
	const copy = catgirlCopy(language);
	const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	async function add() {
		if (busy) return;
		setBusy(true);
		setError(false);
		try {
			await installCatgirlLanguagePack(language);
			onAdded();
		} catch { setError(true); setBusy(false); }
	}
	return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
		<DialogContent className="sm:max-w-md" showCloseButton={!busy}
			onCloseAutoFocus={event => { if (returnFocus.current?.isConnected) { event.preventDefault(); returnFocus.current.focus(); } }}
			onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}
			onInteractOutside={event => { if (busy) event.preventDefault(); }}>
			<div className="grid size-12 place-items-center rounded-2xl bg-rose-500/10 text-rose-500"><Cat className="size-7" aria-hidden /></div>
			<DialogHeader>
				<DialogTitle>{copy.title}</DialogTitle>
				<DialogDescription className="leading-relaxed">{copy.description}</DialogDescription>
			</DialogHeader>
			{error && <p role="alert" className="text-sm text-destructive">{copy.error}</p>}
			<DialogFooter>
				<Button variant="outline" disabled={busy} onClick={onClose}>{copy.cancel}</Button>
				<Button disabled={busy} onClick={() => void add()}>{busy && <Loader2 className="size-4 animate-spin" />}{busy ? copy.busy : copy.add}</Button>
			</DialogFooter>
		</DialogContent>
	</Dialog>;
}
