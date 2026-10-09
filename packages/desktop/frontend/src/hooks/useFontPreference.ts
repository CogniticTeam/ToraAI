import {useSyncExternalStore} from 'react';
export const FONT_KEY = 'tora.theme.font';
const EVENT = 'tora:font-changed';
const valid = (value: string) => value.length <= 160 && Array.from(value).every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
function read(){try{const family=localStorage.getItem(FONT_KEY)||'';return valid(family)?family:'';}catch{return '';}}
function subscribe(changed:()=>void){const storage=(event:StorageEvent)=>{if(event.key===FONT_KEY)changed();};window.addEventListener(EVENT,changed);window.addEventListener('storage',storage);return()=>{window.removeEventListener(EVENT,changed);window.removeEventListener('storage',storage);};}
export function useFontPreference(){
 const family=useSyncExternalStore(subscribe,read,()=> '');
 return {family,setFamily:(value:string)=>{
  if(!valid(value))return;
  if(value)localStorage.setItem(FONT_KEY,value);else localStorage.removeItem(FONT_KEY);
  window.dispatchEvent(new Event(EVENT));
 }};
}
