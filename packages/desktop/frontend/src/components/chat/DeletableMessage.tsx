import {Trash2} from 'lucide-react';
import {ContextMenu} from 'radix-ui';
import {useEffect, useRef, useState, type ReactNode} from 'react';
import {toast} from 'sonner';

import {Button} from '@/components/ui/button';
import {useTranslation} from '@/i18n/useI18n';
import {dissolveMessage, messageMotionEnabled} from '@/lib/messageSand';

export type DeleteMessage = (id: string, beforeRemove: () => Promise<void>) => Promise<void>;

export function DeletableMessage({id, enabled, onDelete, children, hasNext}: {id:string; enabled:boolean; onDelete?:DeleteMessage; children:ReactNode | ((deleteAction:ReactNode)=>ReactNode); hasNext:boolean}) {
 const {t} = useTranslation();
 const row = useRef<HTMLDivElement>(null), controller = useRef<AbortController | null>(null);
 const press = useRef<{timer:ReturnType<typeof setTimeout>; x:number; y:number} | null>(null);
 const busy = useRef(false);
 const [menu, setMenu] = useState(false), [deleting, setDeleting] = useState(false);
 const clearPress = () => {if (press.current) clearTimeout(press.current.timer); press.current = null;};
 useEffect(() => () => {clearPress(); controller.current?.abort();}, []);
 const available = enabled && !!onDelete && !deleting;
 async function remove() {
  if (!available || busy.current || !onDelete || !row.current) return;
  busy.current = true; setMenu(false); setDeleting(true); clearPress();
  const abort = new AbortController(); controller.current = abort;
  const element = row.current;
  try {
   await onDelete(id, async () => {
    if (abort.signal.aborted) return;
    const source = element.querySelector<HTMLElement>('[data-slot="message-content"]') ?? element;
    try {await dissolveMessage(source, abort.signal);} catch { /* Visual fallback: the deletion is already saved. */ }
    if (abort.signal.aborted) return;
    // Collapse the actual occupied row (including its adjacent flex gap),
    // so all following messages move together rather than jumping at removal.
    const layout = element.closest<HTMLElement>('[data-slot="message-scroller-item"]') ?? element;
    const height = layout.getBoundingClientRect().height;
    if (typeof layout.animate !== 'function') {layout.style.display='none'; return;}
    const animation = layout.animate([{height:`${height}px`, opacity:0, marginBottom:'0px'}, {height:'0px', opacity:0, marginBottom:hasNext?'-24px':'0px'}],
     {duration:messageMotionEnabled()?300:0, easing:'cubic-bezier(.22,1,.36,1)', fill:'forwards'});
    const cancel = () => animation.cancel(); abort.signal.addEventListener('abort', cancel, {once:true});
    try {await animation.finished;} catch { /* Unmount/route change. */ }
    finally {abort.signal.removeEventListener('abort', cancel);}
   });
  } catch (error) {
   if (!abort.signal.aborted) {setDeleting(false); toast.error(t('messageBubble.deleteFailed'), {description:error instanceof Error?error.message:undefined});}
  } finally {busy.current = false;}
 }
 const deleteAction = onDelete && !deleting ? <Button variant="ghost" size="icon-xs" disabled={!available} className="text-muted-foreground hover:text-destructive" tooltip={t('common.delete')} aria-label={t('common.delete')} onClick={()=>void remove()}><Trash2/></Button> : null;
 return <ContextMenu.Root open={menu} onOpenChange={setMenu}>
 <ContextMenu.Trigger asChild disabled={!available}><div ref={row} className="relative min-w-0" data-message-delete={id} data-deleting={deleting || undefined}
  onPointerDown={event => {
   if (!available || event.pointerType !== 'mouse' || event.button !== 0 || (event.target as Element).closest('button,a,input,textarea,[role="button"]')) return;
   const {clientX,clientY}=event;
   clearPress(); press.current = {x:clientX,y:clientY,timer:setTimeout(() => {press.current=null;row.current?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX,clientY}));},550)};
  }}
  onPointerMove={event => {if (press.current && Math.hypot(event.clientX-press.current.x,event.clientY-press.current.y)>8) clearPress();}}
  onPointerUp={clearPress} onPointerCancel={clearPress} onPointerLeave={clearPress} onWheel={clearPress} onTouchMove={clearPress}>
  {typeof children==='function'?children(deleteAction):children}
 </div></ContextMenu.Trigger>
  {onDelete && !deleting && <ContextMenu.Portal><ContextMenu.Content aria-label={t('messageBubble.actions')} className="z-50 min-w-32 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-border">
   <ContextMenu.Item disabled={!available} className="flex cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-sm text-destructive outline-none focus:bg-accent data-[disabled]:opacity-50" onSelect={() => {void remove();}}>
    <Trash2 className="size-4"/>{t('common.delete')}
   </ContextMenu.Item>
  </ContextMenu.Content></ContextMenu.Portal>}
 </ContextMenu.Root>;
}
