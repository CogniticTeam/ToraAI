import {RefreshCw,Type} from 'lucide-react';
import {useCallback,useEffect,useMemo,useState} from 'react';

import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {useFontPreference} from '@/hooks/useFontPreference';
import {useTranslation} from '@/i18n/useI18n';

type FontBridge={list:(refresh?:boolean)=>Promise<{status:string;families:string[]}>};
const bridge=()=> (window as unknown as {toraFonts?:FontBridge}).toraFonts;
export function FontSection(){
 const {t}=useTranslation(),{family,setFamily}=useFontPreference();
 const [fonts,setFonts]=useState<string[]>([]),[query,setQuery]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState(false);
 const supported=!!bridge();
 const load=useCallback(async(refresh=false)=>{
  setLoading(true);setError(false);
  try{const result=await bridge()?.list(refresh);if(result?.status!=='ready')throw Error('font-list');setFonts(result.families);}catch{setError(true);}finally{setLoading(false);}
 },[]);
 useEffect(()=>{if(supported)void load();},[supported,load]);
 const options=useMemo(()=>fonts.filter(name=>name.toLocaleLowerCase().includes(query.toLocaleLowerCase())),[fonts,query]);
 const missing=!!family&&!loading&&!error&&fonts.length>0&&!fonts.includes(family);
 return <section className="rounded-xl border border-border bg-card px-5 py-4" data-testid="theme-font-section">
  <div className="flex items-center gap-2 text-sm font-medium"><Type className="size-4"/>{t('settings.theme.fontTitle')}</div>
  <p className="mt-0.5 text-xs text-muted-foreground">{t('settings.theme.fontDesc')}</p>
  {supported?<><div className="mt-4 flex flex-wrap gap-2">
   <Input className="h-10 min-w-40 flex-1" aria-label={t('settings.theme.fontSearch')} placeholder={t('settings.theme.fontSearch')} value={query} onChange={event=>setQuery(event.target.value)}/>
   <Button type="button" className="h-10" variant="outline" disabled={loading} onClick={()=>void load(true)}><RefreshCw className={loading?'size-3.5 animate-spin':'size-3.5'}/>{t('settings.theme.fontRefresh')}</Button>
  </div>
  <select data-testid="theme-font-select" aria-label={t('settings.theme.fontTitle')} className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" value={family} onChange={event=>{try{setFamily(event.target.value);}catch{setError(true);}}}>
   <option value="">{t('settings.theme.fontDefault')}</option>
   {family&&!options.includes(family)&&<option value={family}>{family}</option>}
   {options.map(name=><option key={name} value={name}>{name}</option>)}
  </select>
  {loading&&<p role="status" className="mt-2 text-xs text-muted-foreground">{t('settings.theme.fontLoading')}</p>}
  {error&&<p role="alert" className="mt-2 text-xs text-destructive">{t('settings.theme.fontError')}</p>}
  {!loading&&!error&&query&&!options.length&&<p role="status" className="mt-2 text-xs text-muted-foreground">{t('settings.theme.fontEmpty')}</p>}
  {missing&&<p role="status" className="mt-2 text-xs text-muted-foreground">{t('settings.theme.fontMissing')}</p>}
  </>:<p className="mt-3 text-xs text-muted-foreground">{t('settings.theme.fontDesktopOnly')}</p>}
  <p data-testid="theme-font-preview" className="mt-4 rounded-lg bg-muted px-4 py-3 text-base leading-7">{t('settings.theme.fontPreview')}</p>
 </section>;
}
