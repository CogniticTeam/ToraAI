import {Component,useEffect,type ReactNode} from 'react';

import {useTranslation} from '@/i18n/useI18n';
import {captureUICheckpoint,restoreUIScroll,reportUIFailure} from '@/lib/uiCheckpoint';

type Bridge={getUIUpdateState?:()=>{nonce:string|null}|null;onPrepareUIUpdate?:(cb:(nonce:string)=>boolean)=>()=>void;onResumeUIUpdate?:(cb:()=>void)=>()=>void;uiUpdateReady?:(version:string,nonce:string)=>Promise<unknown>;uiUpdateFailed?:(version:string)=>Promise<unknown>};
const bridge=()=>((window as unknown as {toraWindow?:Bridge}).toraWindow);
const version=()=>document.querySelector('meta[name="tora-ui-version"]')?.getAttribute('content')||'bundled';
export function HotUIBridge(){
 useEffect(()=>{
  const api=bridge();if(!api?.onPrepareUIUpdate)return;
  let frozen=false,lastInput=Date.now();
  const activity=()=>{lastInput=Date.now();},prevent=(event:Event)=>{if(frozen){event.preventDefault();event.stopImmediatePropagation();}};
  const resume=()=>{frozen=false;document.documentElement.removeAttribute('data-ui-updating');};
  document.addEventListener('keydown',activity,true);document.addEventListener('pointerdown',activity,true);document.addEventListener('keydown',prevent,true);document.addEventListener('pointerdown',prevent,true);document.addEventListener('beforeinput',prevent,true);document.addEventListener('click',prevent,true);
  const offPrepare=api.onPrepareUIUpdate(()=>{if(Date.now()-lastInput<10000||!captureUICheckpoint())return false;frozen=true;document.documentElement.setAttribute('data-ui-updating','true');return true;});
  const offResume=api.onResumeUIUpdate?.(resume),offScroll=restoreUIScroll();
  const state=api.getUIUpdateState?.();if(state?.nonce)void api.uiUpdateReady?.(version(),state.nonce);
  return()=>{offPrepare();offResume?.();offScroll();resume();document.removeEventListener('keydown',activity,true);document.removeEventListener('pointerdown',activity,true);document.removeEventListener('keydown',prevent,true);document.removeEventListener('pointerdown',prevent,true);document.removeEventListener('beforeinput',prevent,true);document.removeEventListener('click',prevent,true);};
 },[]);
 return null;
}
function Failure(){const{t}=useTranslation();return <div role="alert" className="grid h-screen place-content-center gap-4 text-center"><p>{t('common.error')}</p><button onClick={()=>window.location.reload()}>{t('error.retry')}</button></div>;}
export class HotUIErrorBoundary extends Component<{children:ReactNode},{failed:boolean}>{
 state={failed:false};static getDerivedStateFromError(){return {failed:true};}
 componentDidCatch(){reportUIFailure();}
 render(){return this.state.failed?<Failure/>:this.props.children;}
}
