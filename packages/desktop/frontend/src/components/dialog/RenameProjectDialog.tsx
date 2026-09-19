import { CheckCircle, CircleAlert, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n/useI18n';

interface RenameProjectDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	currentName: string;
	onConfirm: (name: string) => void;
}

/** 仅重命名导航中的项目展示名，不会改动目录或会话标题。 */
export function RenameProjectDialog({
	open,
	onOpenChange,
	currentName,
	onConfirm,
}: RenameProjectDialogProps) {
	const { t } = useTranslation();
	const [name, setName] = useState(currentName);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (open) setName(currentName);
	}, [currentName, open]);

	const save = () => {
		if (!name.trim()) return;
		setSaving(true);
		onConfirm(name.trim());
		setSaving(false);
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t('dialog-project-rename.title')}</DialogTitle>
					<DialogDescription>{t('dialog-project-rename.description')}</DialogDescription>
				</DialogHeader>
				<FieldGroup>
					<Field>
						<FieldLabel>{t('dialog-project-rename.label')}</FieldLabel>
						<Input
							autoFocus
							maxLength={40}
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder={t('dialog-project-rename.placeholder')}
							onKeyDown={(event) => {
								if (event.key === 'Enter') save();
							}}
						/>
					</Field>
				</FieldGroup>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
						<CircleAlert className="size-3.5" />
						{t('common.cancel')}
					</Button>
					<Button onClick={save} disabled={saving || !name.trim()}>
						{saving ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle className="size-3.5" />}
						{t('common.confirm')}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
