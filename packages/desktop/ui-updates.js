// Signed renderer assets only. Never writes into the installed application or loads Node code.
import {createHash,verify} from 'node:crypto';
import {readFile,writeFile,mkdir,rename,rm,lstat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';

export const UI_PROTOCOL=1;
const MAX_PACKAGE=80*1024*1024,MAX_UNPACKED=140*1024*1024,MAX_FILES=3000;
export const digest=data=>createHash('sha256').update(data).digest('hex');
export function assetPath(path){
 if(typeof path!=='string'||!path||path.length>220||path.startsWith('/')||/[\\:\x00-\x1f?#%]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))throw Error('Invalid UI asset path');
 return path;
}
const semver=value=>{const m=/^(\d+)\.(\d+)\.(\d+)$/.exec(value);if(!m)throw Error('Invalid shell version');return m.slice(1).map(Number);};
const compatible=(current,min)=>{const a=semver(current),b=semver(min);for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}return true;};
export function readManifest(envelope,publicKey,shellVersion,feed){
 if(!envelope||typeof envelope.payload!=='string'||envelope.payload.length>2*1024*1024||typeof envelope.signature!=='string'||envelope.signature.length>200)throw Error('Invalid UI manifest');
 const payload=Buffer.from(envelope.payload,'base64');
 if(!verify(null,payload,publicKey,Buffer.from(envelope.signature,'base64')))throw Error('UI signature rejected');
 const manifest=JSON.parse(payload.toString('utf8'));
 if(manifest.protocol!==UI_PROTOCOL||!compatible(shellVersion,manifest.minimumShell))throw Error('UI requires a newer application');
 if(!Number.isSafeInteger(manifest.build)||manifest.build<1||manifest.version!==`ui-${manifest.build}`)throw Error('Invalid UI release version');
 if(!Number.isSafeInteger(manifest.bytes)||manifest.bytes<1||manifest.bytes>MAX_PACKAGE||!/^([a-f0-9]{64})$/.test(manifest.sha256))throw Error('Invalid UI package metadata');
 const url=new URL(manifest.url,feed),origin=new URL(feed);
 if(url.origin!==origin.origin||url.protocol!=='https:'||url.username||url.password)throw Error('UI package must use the trusted HTTPS feed origin');
 if(!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>MAX_FILES)throw Error('Invalid UI files');
 let size=0;const seen=new Set();
 for(const file of manifest.files){assetPath(file.path);const key=file.path.normalize('NFC').toLowerCase();if(seen.has(key)||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>32*1024*1024||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Invalid UI file metadata');seen.add(key);size+=file.bytes;}
 if(size>MAX_UNPACKED||!seen.has('index.html'))throw Error('Invalid UI unpacked size or entry');
 return {...manifest,url:url.href};
}
async function limitedBody(response,limit){
 if(!response.ok)throw Error(`UI update HTTP ${response.status}`);
 if(Number(response.headers.get('content-length'))>limit)throw Error('UI update too large');
 const chunks=[];let size=0;const reader=response.body.getReader();
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>limit)throw Error('UI update too large');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});}
 return Buffer.concat(chunks);
}
export async function atomicJson(path,value){const temporary=path+'.tmp';await writeFile(temporary,JSON.stringify(value),{mode:0o600});await rename(temporary,path);}
export function createUIUpdater({directory,publicKey,shellVersion,bundledDirectory,bundledBuild=0,feed,fetcher=fetch}){
 let state={active:null,previous:null,staged:null,trial:false,highest:bundledBuild,bad:[]},status='idle',checking=null;
 const releases=new Map(),stateFile=join(directory,'state.json');
 const load=async version=>{
  if(!/^ui-\d+$/.test(version))throw Error('Invalid cached UI version');
  const dir=join(directory,'versions',version),envelope=JSON.parse(await readFile(join(dir,'release.json'),'utf8'));
  const manifest=readManifest(envelope,publicKey,shellVersion,feed);if(manifest.version!==version)throw Error('Wrong cached release');
  for(const file of manifest.files){const path=join(dir,file.path),info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size!==file.bytes||digest(await readFile(path))!==file.sha256)throw Error('Cached UI integrity check failed');}
  releases.set(version,{manifest,directory:dir});return manifest;
 };
 const persist=()=>atomicJson(stateFile,state);
 const rollback=async()=>{
  if(state.active)state.bad=[...new Set([...state.bad,state.active])].slice(-20);
  state.active=state.previous;state.previous=null;state.trial=false;
  if(state.active&&!releases.has(state.active))try{await load(state.active);}catch{state.active=null;}
  await persist();status='rolled-back';return state.active;
 };
 return {
  async initialize(){
   await mkdir(join(directory,'versions'),{recursive:true});
   try{const stored=JSON.parse(await readFile(stateFile,'utf8'));state={...state,active:stored.active??null,previous:stored.previous??null,staged:stored.staged??null,trial:stored.trial===true,highest:Math.max(bundledBuild,Number.isSafeInteger(stored.highest)?stored.highest:0),bad:Array.isArray(stored.bad)?stored.bad.filter(v=>typeof v==='string').slice(-20):[]};}catch{/* First launch or damaged pointer uses the bundled UI. */}
   for(const version of [state.active,state.previous,state.staged].filter(Boolean))try{await load(version);}catch{if(version===state.active)state.active=null;if(version===state.previous)state.previous=null;if(version===state.staged)state.staged=null;}
   if(state.trial)await rollback();
   // A newer packaged UI must not be replaced by an older downloaded UI.
   if(state.active&&releases.get(state.active)?.manifest.build<=bundledBuild){state.active=null;state.previous=null;state.trial=false;}
   const retained=new Set([state.active,state.previous,state.staged].filter(Boolean));
   for(const name of await readdir(join(directory,'versions')))if(/^ui-\d+$/.test(name)&&!retained.has(name)){releases.delete(name);await rm(join(directory,'versions',name),{recursive:true,force:true});}
   await persist();status=state.staged?'ready':'idle';
  },
  resources(){return {activeDirectory:state.active?releases.get(state.active)?.directory||bundledDirectory:bundledDirectory,versions:new Map([...releases].map(([id,r])=>[id,r.directory]))};},
  info(){return {status,active:state.active||'bundled',staged:state.staged,trial:state.trial};},
  check(){
   if(status==='applying')return Promise.resolve(this.info());
   if(checking)return checking;
   checking=(async()=>{
    status='checking';
    const envelope=JSON.parse((await limitedBody(await fetcher(feed,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(20000)}),2*1024*1024)).toString('utf8'));
    const manifest=readManifest(envelope,publicKey,shellVersion,feed);
    if(state.trial||manifest.version===state.active||manifest.version===state.staged||state.bad.includes(manifest.version)||manifest.build<=state.highest){status=state.staged?'ready':'idle';return this.info();}
    status='downloading';
    const data=await limitedBody(await fetcher(manifest.url,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(120000)}),MAX_PACKAGE);
    if(data.length!==manifest.bytes||digest(data)!==manifest.sha256)throw Error('UI package integrity check failed');
    const packageData=JSON.parse(gunzipSync(data,{maxOutputLength:MAX_UNPACKED*2}).toString('utf8'));
    if(!Array.isArray(packageData.files)||packageData.files.length!==manifest.files.length)throw Error('Invalid UI archive');
    const temporary=join(directory,`staging-${manifest.version}`),dest=join(directory,'versions',manifest.version);
    await rm(temporary,{recursive:true,force:true});await mkdir(temporary,{recursive:true});
    try{
     const expected=new Map(manifest.files.map(file=>[file.path,file]));
     for(const entry of packageData.files){const metadata=expected.get(assetPath(entry.path));if(!metadata||typeof entry.data!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.data))throw Error('Invalid archive entry');const bytes=Buffer.from(entry.data,'base64');if(bytes.length!==metadata.bytes||digest(bytes)!==metadata.sha256)throw Error('Invalid archive file');expected.delete(entry.path);const file=join(temporary,entry.path);await mkdir(join(file,'..'),{recursive:true});await writeFile(file,bytes,{flag:'wx'});}
     const html=await readFile(join(temporary,'index.html'),'utf8');
     if(!html.includes(`content="${manifest.version}"`)||!html.includes(`/ui/${manifest.version}/`))throw Error('UI entry does not use versioned assets');
     await writeFile(join(temporary,'release.json'),JSON.stringify(envelope),{flag:'wx'});
     await rm(dest,{recursive:true,force:true});await rename(temporary,dest);
    }catch(error){await rm(temporary,{recursive:true,force:true});throw error;}
    releases.set(manifest.version,{manifest,directory:dest});state.staged=manifest.version;await persist();status='ready';return this.info();
   })().catch(error=>{status=state.staged?'ready':'error';throw error;}).finally(()=>{checking=null;});
   return checking;
  },
  async activate(){
   if(!state.staged||state.trial||checking||status==='applying')return null;
   const before={...state},version=state.staged;status='applying';
   try{await load(version);state.previous=state.active;state.active=version;state.staged=null;state.trial=true;await persist();return version;}
   catch(error){state=before;status='error';throw error;}
  },
  async confirm(version){if(!state.trial||version!==state.active)return false;state.trial=false;state.highest=Math.max(state.highest,releases.get(version).manifest.build);await persist();status='idle';return true;},
  rollback,
 };
}
