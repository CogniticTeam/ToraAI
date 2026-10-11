import {useEffect} from 'react';

export const UI_CHECKPOINT_EVENT='tora-ui:checkpoint';
const KEY='tora-ui-checkpoint-v1';
type Snapshot={route:string;account:string;time:number;values:Record<string,unknown>;scroll:number[]};
type CheckpointEvent=CustomEvent<{save:(key:string,value:unknown)=>void;deny:()=>void}>;
const account=()=>((window as unknown as {toraAuth?:{getEmail:()=>string}}).toraAuth?.getEmail()||'');
const route=()=>window.location.pathname+window.location.search;
export function restoreUIState<T>(key:string,fallback:T):T{
 try{const snapshot=JSON.parse(sessionStorage.getItem(KEY)||'null') as Snapshot|null;
  if(snapshot&&snapshot.route===route()&&snapshot.account===account()&&Date.now()-snapshot.time<10*60*1000&&Object.hasOwn(snapshot.values,key))return snapshot.values[key] as T;
 }catch{/* A damaged snapshot must never prevent startup. */}
 return fallback;
}
export function useUICheckpoint(key:string,value:unknown,blocked:boolean|(()=>boolean)=false){
 useEffect(()=>{
  // After restoration, keep the checkpoint current so sent/cleared drafts cannot reappear.
  try{const snapshot=JSON.parse(sessionStorage.getItem(KEY)||'null') as Snapshot|null;
   if(snapshot&&snapshot.route===route()&&snapshot.account===account()&&Date.now()-snapshot.time<10*60*1000&&Object.hasOwn(snapshot.values,key)){
    snapshot.values[key]=value;const data=JSON.stringify(snapshot);if(data.length<=1024*1024)sessionStorage.setItem(KEY,data);
   }
  }catch{/* Storage failure only postpones the next update. */}
  const save=(event:Event)=>{const detail=(event as CheckpointEvent).detail;if(typeof blocked==='function'?blocked():blocked){detail.deny();return;}detail.save(key,value);};
  window.addEventListener(UI_CHECKPOINT_EVENT,save);return()=>window.removeEventListener(UI_CHECKPOINT_EVENT,save);
 },[key,value,blocked]);
}
export function captureUICheckpoint():boolean{
 if(document.querySelector('[role="dialog"],[role="menu"],[data-slot="popover-content"][data-state="open"],webview,.xterm'))return false;
 // Other forms can contain unsaved credentials or edits; wait until they are closed/cleared.
 if([...document.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('input,textarea')].some(input=>input.id!=='tour-chat-textarea'&&input.type!=='hidden'&&!!input.value))return false;
 let blocked=false;const values:Record<string,unknown>={};
 window.dispatchEvent(new CustomEvent(UI_CHECKPOINT_EVENT,{detail:{save:(key:string,value:unknown)=>{values[key]=value;},deny:()=>{blocked=true;}}}));
 if(blocked)return false;
 try{const snapshot:Snapshot={route:route(),account:account(),time:Date.now(),values,scroll:[...document.querySelectorAll('[data-slot="scroll-area-viewport"]')].map(node=>node.scrollTop)};
  const serialized=JSON.stringify(snapshot);if(serialized.length>1024*1024)return false;sessionStorage.setItem(KEY,serialized);return true;
 }catch{return false;}
}
export function restoreUIScroll(){
 let stopped=false,attempts=0;
 const tick=()=>{if(stopped||attempts++>100)return;try{const snapshot=JSON.parse(sessionStorage.getItem(KEY)||'null') as Snapshot|null;
  if(!snapshot||snapshot.route!==route()||snapshot.account!==account()||Date.now()-snapshot.time>=10*60*1000)return;
  const nodes=document.querySelectorAll('[data-slot="scroll-area-viewport"]');let ready=nodes.length>=snapshot.scroll.length;
  nodes.forEach((node,index)=>{const target=snapshot.scroll[index];if(target===undefined)return;node.scrollTop=target;if(Math.abs(node.scrollTop-target)>2)ready=false;});
  if(!ready||nodes.length===0)setTimeout(tick,100);
 }catch{/* No checkpoint. */}};
 tick();return()=>{stopped=true;};
}

export function reportUIFailure(){const version=document.querySelector('meta[name="tora-ui-version"]')?.getAttribute('content')||'bundled';const api=(window as unknown as {toraWindow?:{uiUpdateFailed?:(version:string)=>Promise<unknown>}}).toraWindow;if(version!=='bundled')void api?.uiUpdateFailed?.(version);}
