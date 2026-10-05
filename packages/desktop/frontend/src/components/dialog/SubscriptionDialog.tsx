import {ArrowLeft} from 'lucide-react';

import {SubscriptionSection} from './SubscriptionSection';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import {useTranslation} from '@/i18n/useI18n';
export function SubscriptionDialog({open,onClose}:{open:boolean;onClose:()=>void}){
 const {t}=useTranslation();return <Dialog open={open} onOpenChange={value=>{if(!value)onClose();}}><DialogContent className="h-[90dvh] w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border-border bg-background p-5 sm:max-w-7xl sm:p-8"><Button variant="ghost" className="mb-2 w-fit" onClick={onClose}><ArrowLeft className="size-4"/>{t('subscription.back')}</Button><DialogHeader className="mb-6 text-center sm:text-center"><DialogTitle className="text-3xl font-semibold tracking-tight">{t('subscription.upgradeTitle')}</DialogTitle><DialogDescription className="sr-only">{t('subscription.shared')}</DialogDescription></DialogHeader><SubscriptionSection/></DialogContent></Dialog>;
}
