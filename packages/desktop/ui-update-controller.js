import {randomUUID} from 'node:crypto';

// Renderer must checkpoint first; core then atomically pauses new runs before activation.
export function createUIUpdateController({updater,getWindow,acquireLock,setTimer=setTimeout,clearTimer=clearTimeout,bootTimeout=30000}){
 let preparing=null,boot=null,release=null;
 const unlock=()=>{release?.();release=null;};
 const reset=()=>{if(boot)clearTimer(boot.timer);boot=null;unlock();};
 const recover=async()=>{reset();await updater.rollback();const win=getWindow();if(win&&!win.isDestroyed())win.webContents.reload();};
 return {
  state(){return {...updater.info(),nonce:boot?.nonce||null};},
  async bootstrap(){
   if(getWindow()||boot||updater.info().status!=='ready')return false;
   release=acquireLock();if(!release)return false;
   try{const version=await updater.activate();if(!version){unlock();return false;}boot={nonce:randomUUID(),version,timer:setTimer(()=>void recover().catch(()=>unlock()),bootTimeout)};return true;}
   catch{unlock();return false;}
  },
  request(){
   const win=getWindow();if(!win||win.isDestroyed()||preparing||boot||updater.info().status!=='ready')return false;
   const nonce=randomUUID(),timer=setTimer(()=>{preparing=null;win.webContents.send('ui-updates:resume',nonce);},5000);
   preparing={nonce,timer,window:win};win.webContents.send('ui-updates:prepare',nonce);return true;
  },
  async prepared(nonce,ready){
   const p=preparing;if(!p||p.nonce!==nonce||p.window!==getWindow())return false;
   clearTimer(p.timer);preparing=null;
   if(!ready){p.window.webContents.send('ui-updates:resume',nonce);return false;}
   release=acquireLock();if(!release){p.window.webContents.send('ui-updates:resume',nonce);return false;}
   try{const version=await updater.activate();if(!version){unlock();p.window.webContents.send('ui-updates:resume',nonce);return false;}
    boot={nonce:randomUUID(),version,timer:setTimer(()=>{void recover().catch(()=>unlock());},bootTimeout)};
    p.window.webContents.reload();return true;
   }catch{unlock();p.window.webContents.send('ui-updates:resume',nonce);return false;}
  },
  async ready(version,nonce){if(!boot||boot.version!==version||boot.nonce!==nonce)return false;await updater.confirm(version);reset();return true;},
  async failed(version){if(version!==updater.info().active||version==='bundled')return false;await recover();return true;},
  close(){if(preparing){clearTimer(preparing.timer);preparing=null;}if(boot)void recover().catch(()=>unlock());},
 };
}
