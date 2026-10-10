import {createServer} from 'node:http';
import {readFile,realpath,stat} from 'node:fs/promises';
import {basename,dirname,extname,join,relative,resolve,sep} from 'node:path';
import {cachedRoots,resolveInRoots} from './security.js';

const servers=new Map();
const starting=new Map();
const MIME={'.html':'text/html','.htm':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.wasm':'application/wasm'};
const within=(path,root)=>path===root||path.startsWith(root.endsWith(sep)?root:root+sep);
const safeParts=path=>!path.split(/[\\/]/).some(part=>part.startsWith('.')||/^(?:package(?:-lock)?\.json|.*\.(?:pem|key))$/i.test(part));

export function localPreviewUrl(value) {
 const url=new URL(value);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!url.port||url.username||url.password)throw Error('预览地址必须是本机 HTTP 开发服务器');
 return url.href;
}

export async function checkPreviewUrl(value) {
 const url=localPreviewUrl(value),response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(3000)});
 try {if(!response.ok||!response.headers.get('content-type')?.includes('text/html'))throw Error('本地网页服务器尚未就绪，请先启动项目开发服务器');}
 finally {await response.body?.cancel();}
 return url;
}

/** Serve only web assets inside the selected site folder, on loopback. Never run project scripts. */
export async function startHtmlPreview(entry,{cwd,allowedRoots=[]}={}) {
 const roots=cachedRoots(cwd,allowedRoots),checked=resolveInRoots(entry,roots);
 if(!checked.ok)throw Error(checked.reason);
 entry=await realpath(checked.path);
 const scope=roots.find(root=>within(entry,root));
 if(!scope||!/\.html?$/i.test(entry)||!safeParts(relative(scope,entry))||!(await stat(entry)).isFile())throw Error('请选择工作目录内的 HTML 页面');
 const root=dirname(entry);
 // A source entry importing JSX/TSX needs its framework dev server, not raw static hosting.
 const html=await readFile(entry,'utf8');
 if(/<script\b[^>]*src\s*=\s*["'][^"']*(?:\.(?:tsx?|jsx)(?:[?"'])|@vite\/client)/i.test(html))throw Error('此项目需要构建，请启动项目开发服务器后使用 WebPreview 登记本地地址');
 if(starting.has(root))await starting.get(root);
 let record=servers.get(root);
 if(!record){
  if(servers.size>=8){const oldest=servers.keys().next().value;servers.get(oldest).server.close();clearTimeout(servers.get(oldest).timer);servers.delete(oldest);}
  record={server:null,timer:null};
  const server=createServer(async(req,res)=>{
   const send=(status,text)=>{res.writeHead(status,{'content-type':'text/plain; charset=utf-8','x-content-type-options':'nosniff'});res.end(text);};
   if(req.headers.host!==`127.0.0.1:${server.address()?.port}`)return send(403,'Forbidden');
   if(!['GET','HEAD'].includes(req.method))return send(405,'Method not allowed');
   try {
    const path=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname).replace(/^\/+/,''),requested=path||'index.html';
    if(!safeParts(requested))return send(403,'Forbidden');
    let file=resolve(root,requested);if(!within(file,root))return send(403,'Forbidden');
    if((await stat(file)).isDirectory())file=join(file,'index.html');
    file=await realpath(file);if(!within(file,root))return send(403,'Forbidden');
    const mime=MIME[extname(file).toLowerCase()];if(!mime)return send(403,'Forbidden');
    const body=await readFile(file);res.writeHead(200,{'content-type':mime+(/^(text\/|application\/json)/.test(mime)?'; charset=utf-8':''),'x-content-type-options':'nosniff','cache-control':'no-store'});res.end(req.method==='HEAD'?undefined:body);
    renew();
   }catch {send(404,'Not found');}
  });
  record.server=server;
  const ready=new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});starting.set(root,ready);
  try{await ready;server.unref();servers.set(root,record);}finally{starting.delete(root);}
 }
 function renew(){if(servers.get(root)!==record)return;clearTimeout(record.timer);record.timer=setTimeout(()=>{record.server.close();if(servers.get(root)===record)servers.delete(root);},30*60*1000);record.timer.unref();}
 renew();
 return {kind:'html',entry,url:`http://127.0.0.1:${record.server.address().port}/${encodeURIComponent(basename(entry))}`};
}

export function htmlEntryFromBlocks(blocks=[]) {
 const successful=new Set(blocks.filter(b=>b.type==='tool_result'&&b.state==='success').map(b=>b.id));
 const paths=blocks.filter(b=>b.type==='tool_call'&&successful.has(b.id)&&['Write','Edit'].includes(b.name)).flatMap(b=>{
  try{const args=typeof b.input==='string'?JSON.parse(b.input):b.input,path=args?.path||args?.file_path;return typeof path==='string'&&/\.html?$/i.test(path)?[path]:[];}catch{return [];}
 });
 return [...paths].reverse().find(path=>/(?:^|[/\\])index\.html?$/i.test(path))??paths.at(-1)??null;
}

export async function prepareReplyPreview(blocks,context) {
 const explicit=[...blocks].reverse().find(b=>b.type==='tool_result'&&b.state==='success'&&b.name==='WebPreview'&&b.metadata?.web_preview)?.metadata.web_preview;
 if(explicit)return explicit;
 const entry=htmlEntryFromBlocks(blocks);
 return entry?await startHtmlPreview(entry,context):null;
}

export async function openReplyPreview(message,context) {
 const preview=message?.metadata?.web_preview??message?.content?.find(b=>b.type==='tool_result'&&b.state==='success'&&b.name==='WebPreview'&&b.metadata?.web_preview)?.metadata.web_preview;
 if(preview?.kind==='server')return {...preview,url:await checkPreviewUrl(preview.url)};
 const entry=preview?.entry??htmlEntryFromBlocks(message?.content);
 if(!entry)throw Error('此回复没有可预览的网页');
 return startHtmlPreview(entry,context);
}

export async function closePreviewServers(){for(const {server,timer} of servers.values()){clearTimeout(timer);server.closeAllConnections?.();await new Promise(done=>server.close(done));}servers.clear();}
