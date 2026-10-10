import {ArrowUpRight,Globe,LoaderCircle} from 'lucide-react';
import {useState} from 'react';
import {useNavigate,useParams} from 'react-router-dom';

import {sessionApi} from '@/api';
import {Button} from '@/components/ui/button';
import {useTranslation} from '@/i18n/useI18n';

export function WebPreviewCard({replyId,entry}:{replyId:string;entry?:string}) {
 const {t}=useTranslation(),{agentId,sessionId}=useParams(),navigate=useNavigate();
 const [pending,setPending]=useState(false),[error,setError]=useState('');
 if(!sessionId||!agentId||!/Electron/i.test(navigator.userAgent))return null;
 const open=async()=>{
  setPending(true);setError('');
  try {
   const preview=await sessionApi.preview(sessionId,agentId,replyId);
   const url=new URL(preview.url);
   if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password)throw Error('Invalid preview URL');
   const {openBuiltinBrowserTab}=await import('@/components/panel/BrowserPanel');
   await openBuiltinBrowserTab(url.href);navigate('/browser');
  }catch {setError(t('webPreview.error'));}finally{setPending(false);}
 };
 return <div data-web-preview-card className="mt-2 flex flex-wrap items-center gap-3 rounded-rect border border-border bg-muted/40 p-3 text-sm">
  <Globe className="size-5 shrink-0 text-muted-foreground" />
  <div className="min-w-0 flex-1"><p className="font-medium">{t('webPreview.title')}</p>{entry&&<p className="truncate text-xs text-muted-foreground">{entry.split(/[\\/]/).pop()}</p>}{error&&<p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}</div>
  <Button variant="secondary" size="sm" onClick={()=>void open()} disabled={pending}>{pending?<LoaderCircle className="size-4 animate-spin" />:<ArrowUpRight className="size-4" />}{t(pending?'webPreview.loading':'webPreview.open')}</Button>
 </div>;
}
