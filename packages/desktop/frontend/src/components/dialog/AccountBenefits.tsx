import {lazy,Suspense,useState} from 'react';

import {Button} from '@/components/ui/button';
import {useTranslation} from '@/i18n/useI18n';
const SponsorsDialog=lazy(async()=>({default:(await import('./SponsorsDialog')).SponsorsDialog}));
export function AccountBenefits(){
 const {t}=useTranslation();const [sponsors,setSponsors]=useState<'list'|'donate'|null>(null);
 return <><section className="space-y-3 rounded-2xl border border-border p-5"><div className="flex flex-wrap gap-2"><Button variant="ghost" onClick={()=>setSponsors('list')}>{t('sponsors.title')}</Button><Button variant="ghost" onClick={()=>setSponsors('donate')}>{t('sponsors.donate')}</Button></div></section>
 {sponsors&&<Suspense fallback={null}><SponsorsDialog mode={sponsors} onClose={()=>setSponsors(null)}/></Suspense>}</>;
}
