// Desktop-only import service: on-demand reads, opaque selections, additive writes.
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, isAbsolute, basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { parseSessionTranscript, SessionImportError, MAX_IMPORT_FILE_BYTES, MAX_IMPORT_BATCH_BYTES } from '../session-import.js';
import { createSessionRecord, saveSessionRecord, listSessionRecords, deleteSession, getAgent } from './store.js';
const TTL=20*60*1000,MAX_FILES=100;
const selections=new Map(),previews=new Map();
let writes=Promise.resolve();
const error=(code,message,status=400)=>{throw new SessionImportError(code,message,status);};
const inside=(path,root)=>{const value=relative(root,path);return value===''||(!value.startsWith('..')&&!isAbsolute(value));};
function prune(map){for(const [key,value]of map)if(value.expires<Date.now())map.delete(key);}
function roots(source){
 if(source==='codex'){const root=process.env.CODEX_HOME||join(homedir(),'.codex');return [join(root,'sessions'),join(root,'archived_sessions')];}
 if(source==='claude')return [join(process.env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude'),'projects')];
 error('invalid_source','来源只能是 Codex 或 Claude Code');
}
async function boundedRead(path,limit=MAX_IMPORT_FILE_BYTES){
 const handle=await open(path,'r');
 try{const info=await handle.stat();if(!info.isFile()||info.size>limit)error('file_too_large','单个记录文件不能超过 32 MB',413);const chunks=[];let total=0;while(true){const buffer=Buffer.alloc(Math.min(512*1024,limit-total+1));const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>limit)error('file_too_large','记录文件在读取期间超过了大小限制',413);chunks.push(buffer.subarray(0,bytesRead));}return Buffer.concat(chunks,total).toString('utf8');}finally{await handle.close();}
}
async function peek(path){
 const handle=await open(path,'r');try{const buffer=Buffer.alloc(128*1024);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);return buffer.subarray(0,bytesRead).toString('utf8');}finally{await handle.close();}
}
export async function discoverSessionImports(source,{sourceRoots=roots(source),limit=300}={}){
 prune(selections);const files=[];let inspected=0;const titles=new Map();
 if(source==='codex'&&sourceRoots[0])try{const index=await boundedRead(join(dirname(sourceRoots[0]),'session_index.jsonl'),8*1024*1024);for(const line of index.split('\n')){try{const item=JSON.parse(line);if(item.id&&typeof item.thread_name==='string')titles.set(item.id,item.thread_name.replace(/\s+/g,' ').slice(0,80));}catch{/* Ignore an unfinished index row. */}}}catch{/* An index is optional. */}
 for(const candidateRoot of sourceRoots){
  let root;try{root=await realpath(candidateRoot);}catch{continue;}
  const walk=async(path,depth)=>{
   if(depth>7||inspected>10000)return;
   let entries;try{entries=await readdir(path,{withFileTypes:true});}catch{return;}
   for(const entry of entries){if(++inspected>10000)break;if(entry.isSymbolicLink())continue;const file=join(path,entry.name);
    if(entry.isDirectory()){if(entry.name==='subagents')continue;await walk(file,depth+1);}
    else if(entry.isFile()&&entry.name.endsWith('.jsonl')){const info=await stat(file).catch(()=>null);if(info)files.push({path:file,root,size:info.size,modified:info.mtime.toISOString()});}
   }
  };await walk(root,0);
 }
 files.sort((a,b)=>b.modified.localeCompare(a.modified));const chosen=files.slice(0,Math.max(1,Math.min(limit,300))),rows=[];
 for(const file of chosen){
  const id=randomUUID();let title=basename(file.path),cwd='',indexTitle='';
  try{const metadata=parseSessionTranscript({content:await peek(file.path),name:basename(file.path),source});indexTitle=titles.get(metadata.external_id)||'';title=indexTitle||metadata.title;cwd=metadata.cwd;}catch{/* The selected file is fully parsed only in preview. */}
  selections.set(id,{...file,source,indexTitle,expires:Date.now()+TTL});
  rows.push({selection_id:id,source,name:basename(file.path),title,cwd,size_bytes:file.size,modified_at:file.modified});
 }
 // Discovery doesn't retain transcript content and never writes session data.
 while(selections.size>1200)selections.delete(selections.keys().next().value);
 return {sessions:rows,total:files.length,limited:files.length>chosen.length,unavailable:!files.length};
}
export async function previewSessionImports(body){
 prune(selections);prune(previews);
 const inputs=[];let bytes=0;
 const addInput=input=>{if(typeof input.content!=='string')error('invalid_file','文件内容必须是文本');bytes+=Buffer.byteLength(input.content);if(bytes>MAX_IMPORT_BATCH_BYTES)error('batch_too_large','本批文件总大小不能超过 64 MB',413);inputs.push(input);};
 if(Array.isArray(body.selection_ids)){
  if(body.selection_ids.length>MAX_FILES)error('too_many_files','一次最多导入 100 个文件');
  for(const id of new Set(body.selection_ids)){
   const item=selections.get(id);if(!item)error('expired_selection','记录选择已过期，请重新扫描');
   const actual=await realpath(item.path).catch(()=>null);if(!actual||actual!==item.path||!inside(actual,item.root))error('invalid_path','记录路径已变化，请重新扫描');
   if(bytes+item.size>MAX_IMPORT_BATCH_BYTES)error('batch_too_large','本批文件总大小不能超过 64 MB',413);
   addInput({name:basename(item.path),source:item.source,title:item.indexTitle,content:await boundedRead(actual)});
  }
 }
 if(Array.isArray(body.files)){
  if(body.files.length+inputs.length>MAX_FILES)error('too_many_files','一次最多导入 100 个文件');
  for(const file of body.files)addInput({name:String(file.name||'session.jsonl').slice(0,200),source:file.source||'auto',content:file.content});
 }
 if(!inputs.length)error('no_files','请先选择聊天记录文件');
 const entries=[],errors=[];const existing=new Set(listSessionRecords().map(record=>record.import_info?.fingerprint).filter(Boolean));
 for(const input of inputs){try{const parsed=parseSessionTranscript(input);if(input.title)parsed.title=input.title;entries.push({id:randomUUID(),name:input.name,...parsed,duplicate:existing.has(parsed.fingerprint)});}catch(err){errors.push({name:input.name,code:err.code||'invalid_file',detail:err.message});}}
 const token=randomUUID();previews.set(token,{entries,expires:Date.now()+TTL});while(previews.size>4)previews.delete(previews.keys().next().value);
 return {preview_id:token,errors,entries:entries.map(({messages,...entry})=>({...entry,message_count:messages.length,sample:(messages.length<=6?messages:[...messages.slice(0,3),...messages.slice(-3)]).map(message=>({...message,text:message.text.slice(0,1800)}))}))};
}
function displayMessage(message){
 const id=randomUUID(),at=message.created_at||new Date().toISOString();
 return {id,name:message.role==='user'?'user':'assistant',role:message.role,content:[{id:randomUUID(),type:'text',text:message.text,created_at:at,finished_at:at}],metadata:{imported:true,source_message_id:message.external_id},created_at:at,finished_at:at,finished_reason:'completed'};
}
export function commitSessionImports(body){
 const perform=async()=>{
  prune(previews);const preview=previews.get(body.preview_id);if(!preview)error('expired_preview','导入预览已过期，请重新选择记录');
  if(!getAgent(body.agent_id))error('invalid_agent','请选择有效的智能体');
  if(!Array.isArray(body.entry_ids)||!body.entry_ids.length)error('no_selection','请至少选择一段会话');
  const ids=new Set(body.entry_ids),chosen=preview.entries.filter(entry=>ids.has(entry.id));if(chosen.length!==ids.size)error('invalid_selection','选择的记录不属于本次预览');
  const fingerprints=new Set(listSessionRecords().map(record=>record.import_info?.fingerprint).filter(Boolean));
  const created=[],skipped=[];
  try{
   for(const entry of chosen){
    if(fingerprints.has(entry.fingerprint)){skipped.push({entry_id:entry.id,reason:'duplicate'});continue;}
    const record=createSessionRecord({agent_id:body.agent_id,toraCfg:loadConfig(),cwd:null});created.push(record.id);
    record.config.name=entry.title;record.config.naming={auto:false};record.config.application_mode=body.application_mode==='tochat'?'tochat':'tocode';record.config.task_mode=record.config.application_mode==='tochat'?'chat':'work';record.config.model_source='custom';
    record.created_at=entry.created_at||record.created_at;record.updated_at=entry.updated_at||record.updated_at;
    record.display=entry.messages.map(displayMessage);
    record.internal=entry.messages.map(message=>({role:message.role,content:message.text}));
    record.import_info={source:entry.source,external_id:entry.external_id,fingerprint:entry.fingerprint,source_cwd:entry.cwd,source_model:entry.model,imported_at:new Date().toISOString(),warnings:entry.warnings};
    // Never restore foreign permission rules, tool state, credentials or cwd grants.
    saveSessionRecord(record);fingerprints.add(entry.fingerprint);
   }
  }catch(err){for(const id of created)deleteSession(id);throw err;}
  return {session_ids:created,imported:created.length,skipped:skipped.length,skipped_entries:skipped};
 };
 const task=writes.then(perform);writes=task.catch(()=>{});return task;
}
export async function readSessionImportBody(req,limit=128*1024*1024){
 let bytes=0;const chunks=[];
 for await(const chunk of req){bytes+=chunk.length;if(bytes>limit)error('batch_too_large','导入请求不能超过 128 MB',413);chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{error('invalid_json','请求体不是合法 JSON');}
}
