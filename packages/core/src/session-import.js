// Parse local Codex/Claude transcripts as data. No file access or tool execution.
import { createHash } from 'node:crypto';
export const MAX_IMPORT_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_IMPORT_BATCH_BYTES = 64 * 1024 * 1024;
export class SessionImportError extends Error {
  constructor(code, detail, status=400) { super(detail); this.code=code; this.status=status; }
}
const fail=(code,detail,status)=>{throw new SessionImportError(code,detail,status);};
const hash=value=>createHash('sha256').update(value).digest('hex');
const date=(value,fallback)=>{const n=Date.parse(value);return Number.isFinite(n)?new Date(n).toISOString():fallback;};
function textBlocks(content,warnings) {
  if(typeof content==='string')return content;
  if(!Array.isArray(content))return '';
  const text=[];
  for(const block of content){
    if(!block||typeof block!=='object')continue;
    if(typeof block.text==='string'&&['text','Text','input_text','output_text',undefined].includes(block.type))text.push(block.text);
    else if(['image','input_image','image_url','document','file'].includes(block.type))warnings.omitted_attachments++;
    else if(['tool_use','tool_result','function_call','function_call_output','thinking','reasoning'].includes(block.type))warnings.omitted_process_blocks++;
  }
  return text.join('\n\n');
}
function sourceRows(content) {
  if(typeof content!=='string'||!content.trim())fail('empty','记录文件为空');
  if(Buffer.byteLength(content,'utf8')>MAX_IMPORT_FILE_BYTES)fail('file_too_large','单个记录文件不能超过 32 MB',413);
  let root;
  try{root=JSON.parse(content);}catch{/* JSONL is parsed line by line. */}
  if(root===null)fail('invalid_format','记录不是有效的对象或数组');
  if(root!==undefined){
    const rows=Array.isArray(root)?root:Array.isArray(root.messages)?root.messages:Array.isArray(root.entries)?root.entries:[root];
    return {rows,invalidLines:0};
  }
  const rows=[];let invalidLines=0;
  for(const line of content.replace(/^\uFEFF/,'').split(/\r?\n/)){
    if(!line.trim())continue;
    try{rows.push(JSON.parse(line));}catch{invalidLines++;}
    if(rows.length>200000)fail('too_many_entries','记录条目过多，请分批导入');
  }
  if(!rows.length)fail('invalid_format','无法识别 JSON / JSONL 记录');
  return {rows,invalidLines};
}
function mergeFragment(previous,text){
  if(!text)return previous;
  if(!previous)return text;
  if(text===previous||previous.startsWith(text))return previous;
  if(text.startsWith(previous))return text;
  const pieces=previous.split('\n\n');return pieces.includes(text)?previous:previous+'\n\n'+text;
}
function cleanUserText(text){
  // Ambient client state is not authored chat or a permission to act.
  return text.replace(/<external_codex_apps_open_page>[\s\S]*?<\/external_codex_apps_open_page>/g,'')
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g,'').trim();
}
export function parseSessionTranscript({content,name='session.jsonl',source='auto'}) {
  const {rows,invalidLines}=sourceRows(content);
  const warnings={invalid_lines:invalidLines,omitted_attachments:0,omitted_process_blocks:0,skipped_entries:0,unknown_timestamps:0};
  const objects=rows.filter(row=>row&&typeof row==='object'&&!Array.isArray(row));
  const codex=objects.some(row=>['session_meta','response_item','turn_context','event_msg'].includes(row.type));
  const claude=objects.some(row=>['user','assistant'].includes(row.type)&&row.message)||objects.some(row=>['user','assistant'].includes(row.role)&&row.content!==undefined);
  const detected=codex?'codex':claude?'claude':null;
  if(!detected)fail('unsupported_format','该文件不是可识别的 Codex 或 Claude Code 聊天记录');
  if(source!=='auto'&&source!==detected)fail('source_mismatch','所选来源与文件格式不一致');
  source=detected;
  let externalId='',cwd='',model='',explicitTitle='',metaTime='';
  const messages=[],seen=new Map();
  const add=(role,text,at,id,phase)=>{
    if(!['user','assistant'].includes(role)||typeof text!=='string')return;
    text=role==='user'?cleanUserText(text):text.trim();if(!text)return;
    const createdAt=date(at,date(metaTime,null));
    const key=id?role+':'+id:role+':'+createdAt+':'+hash(text);
    if(seen.has(key)){const previous=messages[seen.get(key)];previous.text=mergeFragment(previous.text,text);return;}
    if(!createdAt)warnings.unknown_timestamps++;
    seen.set(key,messages.length);messages.push({role,text,created_at:createdAt,external_id:String(id||''),...(phase?{phase}:{})});
    if(messages.length>20000)fail('too_many_messages','消息过多，请拆分后导入');
  };
  if(source==='codex') {
    for(const row of objects){if(row.type==='session_meta'){const p=row.payload||{};externalId=String(p.id||p.session_id||'');cwd=String(p.cwd||'');metaTime=p.timestamp||row.timestamp||'';}if(row.type==='turn_context')model ||=String(row.payload?.model||'');}
    const groupFor=new Map(),groups=new Map();let groupKey='initial';
    for(const row of objects){const p=row.payload||{};if((row.type==='turn_context'||(row.type==='event_msg'&&p.type==='task_started'))&&p.turn_id)groupKey=p.turn_id;groupFor.set(row,groupKey);const group=groups.get(groupKey)||{nativeUsers:false,nativeAssistants:false,legacyUsers:false,responseAssistants:false,legacyAssistants:false};const item=p.item;if(row.type==='event_msg'&&p.type==='item_completed'){group.nativeUsers ||=item?.type==='UserMessage';group.nativeAssistants ||=item?.type==='AgentMessage';}group.legacyUsers ||=row.type==='event_msg'&&p.type==='user_message';group.responseAssistants ||=row.type==='response_item'&&p.type==='message'&&p.role==='assistant';group.legacyAssistants ||=row.type==='event_msg'&&p.type==='agent_message';groups.set(groupKey,group);}
    for(const row of objects){
      const p=row.payload||{};const group=groups.get(groupFor.get(row));
      const nativeUsers=group.nativeUsers,nativeAssistants=group.nativeAssistants,legacyUsers=!nativeUsers&&group.legacyUsers;
      if(row.type==='event_msg'&&p.type==='item_completed'){
        const item=p.item||{};
        if(item.type==='UserMessage')add('user',textBlocks(item.content,warnings),row.timestamp,item.id);
        else if(item.type==='AgentMessage'&&item.phase!=='analysis')add('assistant',textBlocks(item.content,warnings),row.timestamp,item.id,item.phase);
        else warnings.skipped_entries++;
      }else if(row.type==='event_msg'&&p.type==='user_message'&&legacyUsers)add('user',p.message||p.text||'',row.timestamp,p.id);
      else if(row.type==='event_msg'&&p.type==='agent_message'&&!nativeAssistants&&!group.responseAssistants)add('assistant',textBlocks(p.message||p.text||p.content,warnings),row.timestamp,p.id);
      else if(row.type==='event_msg'&&p.type==='task_complete'&&!nativeAssistants&&!group.responseAssistants&&!group.legacyAssistants)add('assistant',p.last_agent_message||'',row.timestamp,p.turn_id);
      else if(row.type==='response_item'&&p.type==='message'){
        if(p.role==='user'&&!nativeUsers&&!legacyUsers)add('user',textBlocks(p.content,warnings),row.timestamp,p.id);
        if(p.role==='assistant'&&!nativeAssistants&&!['analysis'].includes(p.phase||p.channel))add('assistant',textBlocks(p.content,warnings),row.timestamp,p.id,p.phase||p.channel);
      }else if(row.type==='response_item'&&['function_call','custom_tool_call','function_call_output','custom_tool_call_output','reasoning'].includes(p.type))warnings.omitted_process_blocks++;
    }
  }else{
    for(const row of objects){
      externalId ||=String(row.sessionId||row.session_id||'');cwd ||=String(row.cwd||'');metaTime ||=row.timestamp||row.created_at||'';
      if(row.type==='custom-title')explicitTitle=String(row.customTitle||'');
      else if(row.type==='ai-title'&&!explicitTitle)explicitTitle=String(row.aiTitle||'');
      const message=row.message||row;
      if(row.isSidechain||message.model==='<synthetic>'){warnings.skipped_entries++;continue;}
      const role=message.role||row.type;
      if(!['user','assistant'].includes(role)){warnings.skipped_entries++;continue;}
      model ||=String(message.model||'');
      add(role,textBlocks(message.content,warnings),row.timestamp||row.created_at,message.id||row.uuid||row.id);
    }
  }
  if(!messages.length)fail('no_chat_messages','记录中没有可导入的用户或助手文字消息');
  const firstUser=messages.find(message=>message.role==='user');
  const title=(explicitTitle||firstUser?.text||name).replace(/\s+/g,' ').trim().slice(0,80);
  const timestamps=messages.map(message=>message.created_at).filter(Boolean).sort();
  externalId ||=hash(source+'\n'+messages.map(message=>message.text).join('\n')).slice(0,32);
  const fingerprint=hash(JSON.stringify({source,externalId,messages:messages.map(({role,text,created_at})=>({role,text,created_at}))}));
  return {source,external_id:externalId,fingerprint,title,cwd,model,created_at:timestamps[0]||null,updated_at:timestamps.at(-1)||null,messages,warnings};
}
