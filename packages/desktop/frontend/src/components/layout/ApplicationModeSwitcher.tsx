import { Check, ChevronDown, MessagesSquare, SquareTerminal } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useTranslation } from '@/i18n/useI18n';
import { modeCopy, type ApplicationMode } from '@/lib/applicationModes';

/** A compact addition to the existing sidebar, not a new navigation system. */
export function ApplicationModeSwitcher() {
	const location = useLocation();
	const navigate = useNavigate();
	const { i18n } = useTranslation();
	const copy = modeCopy(i18n.language);
	const mode: ApplicationMode = location.pathname.startsWith('/tochat') ? 'tochat' : 'tocode';
	const choose = (next: ApplicationMode) => navigate(next === 'tochat' ? '/tochat' : '/chat');
	return (
		<DropdownMenu>
			<DropdownMenuTrigger aria-label={copy('mode')} data-testid="application-mode-switcher" className="app-no-drag mx-2 mb-1 mt-1 flex h-10 w-fit items-center gap-2 rounded-lg px-3 text-base font-medium hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
				{mode === 'tochat' ? 'ToChat' : 'ToCode'}<ChevronDown className="size-4 text-muted-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-56">
				<DropdownMenuItem className="gap-2 px-2 py-1.5 text-sm" onSelect={() => choose('tochat')}>
					<MessagesSquare className="size-4" /><span>ToChat<small className="block text-[11px] text-muted-foreground">{copy('chatDescription')}</small></span>{mode === 'tochat' && <Check className="ms-auto" />}
				</DropdownMenuItem>
				<DropdownMenuItem className="gap-2 px-2 py-1.5 text-sm" onSelect={() => choose('tocode')}>
					<SquareTerminal className="size-4" /><span>ToCode<small className="block text-[11px] text-muted-foreground">{copy('codeDescription')}</small></span>{mode === 'tocode' && <Check className="ms-auto" />}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
