import {DOUBAO_MODEL_ID, AUDIO_MIME_TYPES, VIDEO_MIME_TYPES} from '../../core/src/chat-media.js';
import {generateOfficialTitle} from './tochat-title.js';
import {normalizeTitleLanguage} from '../../core/src/title-rules.js';
import { toResponsesBody, responsesChatStream } from './tochat-responses.js';
import {readAgentQuota,publicQuota,reserveCreditStatement,progressCredit,settleCreditStatement} from './agent-credits.js';
import {modelRates} from './subscription-plans.js';

// Shared official key never crosses this server boundary.
const MODELS = Object.freeze({
  [DOUBAO_MODEL_ID]: {name:'Doubao Seed 2.1 Lite',secret:'ARK_API_KEY',url:'https://ark.cn-beijing.volces.com/api/v3/responses',protocol:'responses',adapter:'ark',modes:['chat']},
  'gpt-6-sol': {name:'GPT-6 Sol',secret:'SHULIUYUN_GPT_API_KEY',url:'https://shuliuyun.com/v1/responses',protocol:'responses'},
  'gpt-6-luna': {name:'GPT-6 Luna',secret:'SHULIUYUN_GPT_API_KEY',url:'https://shuliuyun.com/v1/responses',protocol:'responses'},
  'gpt-6-astra': {name:'GPT-6 Astra',secret:'SHULIUYUN_GPT_API_KEY',url:'https://shuliuyun.com/v1/responses',protocol:'responses'},
  'grok-4.7': {name:'Grok 4.7',secret:'SHULIUYUN_GROK_API_KEY',url:'https://shuliuyun.com/v1/responses',protocol:'responses',adapter:'xai',efforts:['low','medium','high','xhigh']},
  'claude-opus-5-5': {name:'Claude Opus 5.5',secret:'SHULIUYUN_CLAUDE_API_KEY',url:'https://shuliuyun.com/v1/chat/completions',efforts:['low','medium','high','xhigh','max'],thinking:{type:'adaptive'},effortParameter:'output_config'},
  'claude-sonnet-5-5': {name:'Claude Sonnet 5.5',secret:'SHULIUYUN_CLAUDE_API_KEY',url:'https://shuliuyun.com/v1/chat/completions',efforts:['low','medium','high','xhigh','max'],thinking:{type:'adaptive'},effortParameter:'output_config'},
  'claude-haiku-5-5': {name:'Claude Haiku 5.5',secret:'SHULIUYUN_CLAUDE_API_KEY',url:'https://shuliuyun.com/v1/chat/completions',efforts:['low','medium','high','xhigh','max'],thinking:{type:'adaptive'},effortParameter:'output_config'},
  'glm-5.3': {name:'GLM 5.3',secret:'SHULIUYUN_GLM_API_KEY',url:'https://shuliuyun.com/v1/chat/completions',efforts:['low','high','max'],thinking:{type:'enabled'},inputModalities:['text']},
  'deepseek-flash': {name:'DeepSeek Flash',secret:'DEEPSEEK_API_KEY',url:'https://api.deepseek.com/v1/chat/completions'},
  'gemini-3.8-flash': {name:'Gemini 3.8 Flash',secret:'SHULIUYUN_API_KEY',url:'https://shuliuyun.com/v1/chat/completions'},
  'gpt-6.1-sol': {name:'GPT-6.1 Sol',secret:'SHULIUYUN_GPT_API_KEY',url:'https://shuliuyun.com/v1/responses',protocol:'responses'},
});
const modelConfig = id => Object.hasOwn(MODELS,id) ? MODELS[id] : null;
export const toChatModels = env => Object.entries(MODELS).map(([id,model]) => ({id,name:model.name,input_modalities:model.inputModalities||(model.adapter==='ark'?['text','image','audio','video']:['text','image']),modes:model.modes||['chat','work'],free:!!model.modes,enabled:!!env[model.secret]&&env.TOCHAT_ENABLED!=='0'}));
const json = (data,status=200) => new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','access-control-allow-origin':'*','cache-control':'no-store'}});
const fail = (detail,status=400) => json({detail},status);
export function quotaPeriods(now=Date.now()) {
  const shifted = new Date(now+8*3600000);
  const day = shifted.toISOString().slice(0,10);
  const midnight = Date.UTC(shifted.getUTCFullYear(),shifted.getUTCMonth(),shifted.getUTCDate());
  const monday = midnight-((shifted.getUTCDay()+6)%7)*86400000;
  return {day,week:new Date(monday).toISOString().slice(0,10),dailyReset:new Date(midnight+86400000-8*3600000).toISOString(),weeklyReset:new Date(monday+7*86400000-8*3600000).toISOString()};
}
export async function readToChatQuota(db,userId,now=Date.now()) {
  const quota=await readAgentQuota(db,userId,now);
  return {...publicQuota(quota),chatUnlimited:true};
}
export function validateToChatBody(body,kind) {
  if(body?.model==='claude-opus-5')throw Error('Claude Opus 5 已下架，请选择其他官方模型');
  if (!body || !modelConfig(body.model) || !Array.isArray(body.messages) || !body.messages.length || body.messages.length>1000) throw Error('模型或消息格式无效');
  if(modelConfig(body.model).modes&&!modelConfig(body.model).modes.includes(kind))throw Error('豆包免费模型仅支持 ToChat 聊天模式');
  const effort=body.reasoning_effort||'high';
  const efforts=modelConfig(body.model).efforts||(body.model.startsWith('gpt-6')?['low','medium','high','xhigh','max']:[DOUBAO_MODEL_ID,'gemini-3.8-flash'].includes(body.model)?['low','medium','high','max']:['low','high','max']);
  if (!efforts.includes(effort)) throw Error('此模型不支持该思考强度');
  if (body.tools && (!Array.isArray(body.tools)||body.tools.length>100)) throw Error('工具格式无效');
  if (kind==='chat' && (body.tools||[]).some(tool=>!['WebSearch','WebFetch'].includes(tool?.function?.name))) throw Error('聊天模式只允许联网搜索工具');
  let images=0,media=0;
  const clean=JSON.parse(JSON.stringify(body));
  for(const message of clean.messages) {
    if(!['system','user','assistant','tool'].includes(message.role)) throw Error('消息角色无效');
    if(Array.isArray(message.content)) for(const part of message.content) {
      if(part.type==='image_url') {
        if(modelConfig(body.model).inputModalities&&!modelConfig(body.model).inputModalities.includes('image'))throw Error('此模型不支持图片输入');
        if(message.role!=='user') throw Error('图片必须放在用户消息中');
        const url=part.image_url?.url;
        if(typeof url!=='string'||!/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(url)) throw Error('请通过附件上传图片');
        if(url.length>45*1024*1024) throw Error('图片过大');
        if(++images>20) throw Error('单次最多20张图片');
        part.image_url.url='[image]';
      } else if(['input_audio','input_video'].includes(part.type)) {
        if(body.model!==DOUBAO_MODEL_ID||message.role!=='user')throw Error('音频和视频仅支持豆包聊天的用户附件');
        const audio=part.type==='input_audio',field=audio?'audio_url':'video_url',url=part[field];
        const match=typeof url==='string'&&url.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
        if(!match||!(audio?AUDIO_MIME_TYPES:VIDEO_MIME_TYPES).includes(match[1]))throw Error('请上传受支持的音频或视频附件');
        if(match[2].length>(audio?10:20)*1024*1024*4/3+4)throw Error('音频最大 10 MB，视频最大 20 MB');
        if(++media>4)throw Error('单次最多 4 个音频或视频附件');
        part[field]='[media]';
      } else if(part.type!=='text') throw Error('附件格式不受支持');
    }
  }
  // UTF-8 byte count is a conservative text-token bound, plus chat framing.
  const inputBound=new TextEncoder().encode(JSON.stringify({messages:clean.messages,tools:clean.tools})).length+32768*(images+media)+128*clean.messages.length+512;
  const output=Math.min(16384,Math.max(256,Number.isFinite(Number(body.max_tokens))?Math.floor(Number(body.max_tokens)):8192));
  return {effort,inputBound,output};
}
export async function reserveToChat(db,params) {
  const {userId,messageId,requestId,kind,fingerprint,reserved,now=Date.now()}=params;
  const p=quotaPeriods(now);
  const credit=params.credit;
  await db.batch([
    ...(credit?[reserveCreditStatement(db,{userId,requestId,now,...credit})]:[]),
    db.prepare('INSERT INTO tochat_turns(user_id,message_id,day,kind,fingerprint,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,message_id) DO NOTHING').bind(userId,messageId,p.day,kind,fingerprint,now),
    db.prepare("UPDATE tochat_turns SET state='active',current_request=?,rounds=rounds+1 WHERE user_id=? AND message_id=? AND kind=? AND fingerprint=? AND (state IN ('new','waiting_tools') OR (kind='work' AND state='done')) AND rounds<?").bind(requestId,userId,messageId,kind,fingerprint,kind==='chat'?6:120),
    db.prepare('INSERT INTO tochat_requests(user_id,request_id,message_id,day,week,kind,charged,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(userId,requestId,messageId,p.day,p.week,kind,kind==='work'?reserved:0,now),
  ]);
}
export function totalUsage(usage) {
  if(Number.isFinite(usage?.total_tokens)&&usage.total_tokens>=0) return Math.ceil(usage.total_tokens);
  if(Number.isFinite(usage?.prompt_tokens)&&Number.isFinite(usage?.completion_tokens)) return Math.ceil(usage.prompt_tokens+usage.completion_tokens);
  return null; // completion_tokens already includes DeepSeek reasoning tokens.
}
export async function settleToChat(db,params) {
  const {userId,requestId,messageId,usage,failed=false,unknown=false,tools=[]}=params;
  const tokens=totalUsage(usage);
  await db.batch([
    ...(params.creditStatement?[params.creditStatement]:[]),
    db.prepare("UPDATE tochat_requests SET charged=CASE WHEN ? THEN 0 WHEN kind='work' AND ? IS NOT NULL THEN ? ELSE charged END,status=?,finished_at=? WHERE user_id=? AND request_id=? AND status='pending'").bind(failed?1:0,tokens,tokens,failed?'failed':unknown||tokens===null?'unknown':'settled',Date.now(),userId,requestId),
    db.prepare("UPDATE tochat_turns SET state=?,expected_tools=?,counted=CASE WHEN ? AND rounds=1 THEN 0 ELSE counted END WHERE user_id=? AND message_id=? AND current_request=? AND state='active'").bind(failed?'failed':tools.length&&!unknown?'waiting_tools':'done',JSON.stringify(tools),failed?1:0,userId,messageId,requestId),
  ]);
}
export async function handleToChat(request,env,ctx,user) {
  if(!user) return fail('请先登录',401);
  if(user.banned) return fail('账户已被封禁',403);
  const path=new URL(request.url).pathname;
  if(path==='/tochat/title'&&request.method==='POST'){
    let input;try{const raw=await request.text();if(new TextEncoder().encode(raw).length>4096)return fail('标题输入过大',413);input=JSON.parse(raw);}catch{return fail('标题输入无效');}
    if(!modelConfig(input?.model)||typeof input?.userText!=='string'||!input.userText.trim()||input.userText.length>400)return fail('标题输入无效');
    if(input.language!==undefined&&!normalizeTitleLanguage(input.language))return fail('标题语言无效');
    if(!env.ACCOUNT_EVENTS)return fail('标题服务暂不可用',503);
    const gate=env.ACCOUNT_EVENTS.get(env.ACCOUNT_EVENTS.idFromName('titles:'+user.id));
    let permit;try{permit=await (await gate.fetch('https://internal/title-permit',{method:'POST'})).json();}catch{return fail('标题服务暂不可用',503);}
    if(!permit.allowed)return fail('标题请求过于频繁',429);
    const selected=modelConfig(input.model);
    // Keep metadata fast on the same configured gateway; never switch the conversation model.
    const fast=selected.url.startsWith('https://shuliuyun.com/')&&env.SHULIUYUN_API_KEY?modelConfig('gemini-3.8-flash'):selected;
    const namingInput={...input,model:fast===selected?input.model:'gemini-3.8-flash'};
    const result=await generateOfficialTitle(env,namingInput,fast);return json(result.data,result.status);
  }
  if(path==='/tochat/quota'&&request.method==='GET') {const models=toChatModels(env);return json({...await readToChatQuota(env.DB,user.id),enabled:models.some(model=>model.enabled),model:'deepseek-flash',models});}
  if(path==='/tochat/v1/models'&&request.method==='GET') return json({data:toChatModels(env).filter(model=>model.enabled&&(!(request.headers.get('x-tochat-mode')==='work'||request.headers.get('x-tora-feature')==='tocode')||model.modes.includes('work')))});
  if(path!=='/tochat/v1/chat/completions'||request.method!=='POST') return fail('Not Found',404);
  const kind=request.headers.get('x-tochat-mode');
  const messageId=request.headers.get('x-tochat-message-id');
  const requestId=request.headers.get('x-tochat-request-id');
  if(!['chat','work'].includes(kind)||![messageId,requestId].every(id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(id))) return fail('缺少有效的模式或请求标识');
  const raw=await request.text();
  if(new TextEncoder().encode(raw).length>48*1024*1024) return fail('请求体过大',413);
  let body,checked;
  try{body=JSON.parse(raw);checked=validateToChatBody(body,kind);}catch(error){return fail(error.message);}
  const selected=modelConfig(body.model);
  if(selected.modes&&request.headers.get('x-tora-feature')==='tocode')return fail('豆包免费模型仅支持 ToChat 聊天模式',403);
  if(!env[selected.secret]||env.TOCHAT_ENABLED==='0') return fail('官方模型暂不可用，请稍后重试或在设置中主动切换为自定义模型',503);
  let upstreamBody;
  try{if(selected.protocol==='responses')upstreamBody=toResponsesBody(body,checked.effort,checked.output,selected.adapter);}catch(error){return fail(error.message);}
  const lastUser=[...body.messages].reverse().find(m=>m.role==='user');
  if(!lastUser) return fail('缺少用户消息');
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(kind==='work'?messageId:JSON.stringify(lastUser.content)));
  const fingerprint=Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('');
  if(selected.adapter==='xai'){
    const cacheHash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('tora:grok:'+user.id));
    upstreamBody.prompt_cache_key=Array.from(new Uint8Array(cacheHash),n=>n.toString(16).padStart(2,'0')).join('');
  }
  // An abandoned stream retains its conservative reservation, never refunds unknown usage.
  await env.DB.batch([
    env.DB.prepare("UPDATE tochat_requests SET status='unknown',finished_at=? WHERE user_id=? AND status='pending' AND created_at<?").bind(Date.now(),user.id,Date.now()-300000),
    env.DB.prepare("UPDATE usage_log SET credit_micro=credit_micro+held_micro,held_micro=0,status='unknown',finished_at=? WHERE user_id=? AND status='pending' AND created_at<?").bind(Date.now(),user.id,Date.now()-300000),
    env.DB.prepare("UPDATE tochat_turns SET state='done' WHERE user_id=? AND state='active' AND current_request IN (SELECT request_id FROM tochat_requests WHERE user_id=? AND status='unknown')").bind(user.id,user.id),
  ]);
  const existing=await env.DB.prepare('SELECT * FROM tochat_turns WHERE user_id=? AND message_id=?').bind(user.id,messageId).first();
  if(existing?.state==='waiting_tools'&&kind==='chat') {
    const expected=JSON.parse(existing.expected_tools||'[]');
    if(!expected.every(id=>body.messages.some(m=>m.role==='tool'&&m.tool_call_id===id))) return fail('缺少对应的联网工具结果');
  }
  const quota=kind==='work'?await readAgentQuota(env.DB,user.id):null;
  const rate=kind==='work'?modelRates(body.model,checked.inputBound,env):{input:0,cached:0,output:0};
  const available=quota?.availableMicro??Infinity;
  const inputCost=checked.inputBound*rate.input;
  const output=kind==='work'?Math.min(checked.output,Math.floor((available-inputCost)/rate.output)):checked.output;
  if(output<1) return json({detail:quota?.subscription?'官方工作额度已耗尽或无法覆盖当前上下文，请等待滚动窗口释放额度':'请先订阅后使用官方工作模型',quota:quota?publicQuota(quota):null},429);
  const reserved=inputCost+output*rate.output;
  try{await reserveToChat(env.DB,{userId:user.id,messageId,requestId,kind,fingerprint,reserved:0,credit:kind==='work'?{model:body.model,feature:request.headers.get('x-tora-feature')==='tocode'?'tocode':'work',reserved}:null});}
  catch(error){return fail(/LIMIT|SUBSCRIPTION/.test(error.message)?'官方工作额度或并发限制已达到，请等待额度释放':'此消息已经完成、正在执行或标识重复，请勿重复提交',/LIMIT|SUBSCRIPTION/.test(error.message)?429:409);}
  const settle=options=>settleToChat(env.DB,{userId:user.id,messageId,requestId,...options,creditStatement:kind==='work'?settleCreditStatement(env.DB,{userId:user.id,requestId,model:body.model,env,...options}):null});
  const abort=new AbortController();
  let upstream;
  try{upstream=await fetch(selected.url,{
    method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${env[selected.secret]}`},signal:AbortSignal.any([abort.signal,AbortSignal.timeout(300000)]),
    body:JSON.stringify(selected.protocol==='responses'?{...upstreamBody,max_output_tokens:output}:{model:body.model,messages:body.messages.map(({tora_response_items,...message})=>message),tools:body.tools,tool_choice:body.tools?.length?'auto':undefined,...(selected.thinking?{thinking:selected.thinking}:body.model==='deepseek-flash'?{thinking:{type:'enabled'}}:{}),...(selected.effortParameter==='output_config'?{output_config:{effort:checked.effort}}:{reasoning_effort:body.model==='gemini-3.8-flash'&&checked.effort==='max'?'high':checked.effort}),max_tokens:output,stream:true,stream_options:{include_usage:true}}),
  });}catch{await settle({unknown:true});return fail('官方模型连接失败，请稍后重试',502);}
  if(!upstream.ok){await settle({failed:true});return fail(`官方模型请求失败（HTTP ${upstream.status}）`,upstream.status===429?429:502);}
  if(selected.protocol==='responses'){try{upstream=responsesChatStream(upstream,body.model);}catch{await settle({unknown:true});return fail('模型未返回有效的流式响应',502);}}
  const reader=upstream.body.getReader();
  const decoder=new TextDecoder();let buffer='',usage=null,finish='',expected=new Set(),cancelled=false,outputBytes=0,lastProgress=0;
  const stream=new ReadableStream({
    start(controller){
      let broken=false;
      const pump=(async()=>{
        try{for(;;){const{done,value}=await reader.read();if(done)break;
          buffer+=decoder.decode(value,{stream:true});
          const lines=buffer.split('\n');buffer=lines.pop();
          for(const line of lines){if(!line.startsWith('data: '))continue;try{const data=JSON.parse(line.slice(6));if(data.usage)usage=data.usage;
            for(const choice of data.choices||[]){const delta=choice.delta||{};outputBytes+=new TextEncoder().encode((delta.content||'')+(delta.reasoning_content||'')+(delta.tool_calls||[]).map(tool=>tool.function?.arguments||'').join('')).length;if(choice.finish_reason)finish=choice.finish_reason;for(const tool of choice.delta?.tool_calls||[])if(tool.id)expected.add(tool.id);}
          }catch{/* delta fragments are not complete JSON payloads */}}
          if(kind==='work'&&Date.now()-lastProgress>=1000){lastProgress=Date.now();await progressCredit(env.DB,user.id,requestId,Math.min(reserved,inputCost+Math.ceil(outputBytes/3)*rate.output));}
          if(buffer.length>1024*1024)throw Error('invalid stream');
          if(!cancelled)controller.enqueue(value);
        }
        }catch{broken=true;if(!cancelled)controller.error(Error('官方模型流式响应中断'));}
        finally{try{await settle({usage,unknown:!usage||cancelled||broken,tools:finish==='tool_calls'?[...expected]:[]});}catch{broken=true;if(!cancelled)controller.error(Error('额度结算暂时失败，请稍后重试'));}if(!cancelled&&!broken)controller.close();}
      })();ctx.waitUntil(pump);
    },
    async cancel(){cancelled=true;abort.abort();await reader.cancel().catch(()=>{});},
  });
  return new Response(stream,{headers:{'content-type':'text/event-stream','cache-control':'no-store','access-control-allow-origin':'*','x-tochat-request-id':requestId}});
}
