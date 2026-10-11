import {BUILTIN_MODELS} from '../../core/src/builtin-models.js';
import {MODEL_MINIMUM_PLAN,PLAN_RANKS} from '../../core/src/model-access.js';
import {CREDIT_RATES} from './subscription-plans.js';
import {DEFAULT_ROUTES} from './official-model-defaults.js';

const TABLES=[
 'CREATE TABLE IF NOT EXISTS official_model_catalog (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, document TEXT NOT NULL, write_id TEXT NOT NULL DEFAULT \'\', updated_at INTEGER NOT NULL)',
 'CREATE TABLE IF NOT EXISTS official_catalog_audit (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL)',
 'CREATE TABLE IF NOT EXISTS official_request_prices (user_id INTEGER NOT NULL, request_id TEXT NOT NULL, catalog_revision INTEGER NOT NULL, rates TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id,request_id))',
];
const error=(message,status=422)=>Object.assign(Error(message),{status});
const idPattern=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const DEFAULT_EFFORTS=['low','medium','high','xhigh','max'];
const defaultEfforts=id=>DEFAULT_ROUTES[id].efforts||(id.startsWith('gpt-6')?DEFAULT_EFFORTS:[id.startsWith('doubao'),id==='gemini-3.8-flash'].some(Boolean)?['low','medium','high','max']:['low','high','max']);
export function defaultCatalog(env={}){
 const channels=[],models=[];let overrides={};
 try{overrides=JSON.parse(env.AGENT_CREDIT_RATES||'{}');}catch{throw error('服务端 Credits 配置无效',503);}
 for(const metadata of BUILTIN_MODELS){
  const route=DEFAULT_ROUTES[metadata.id],channelId=route.secret.toLowerCase();
  if(!channels.some(item=>item.id===channelId))channels.push({id:channelId,name:({ARK_API_KEY:'火山方舟',SHULIUYUN_GPT_API_KEY:'枢流云 GPT',SHULIUYUN_CLAUDE_API_KEY:'枢流云 Claude',SHULIUYUN_GROK_API_KEY:'枢流云 Grok',SHULIUYUN_GLM_API_KEY:'枢流云 GLM',SHULIUYUN_API_KEY:'枢流云 Gemini',DEEPSEEK_API_KEY:'DeepSeek'})[route.secret],url:route.url,protocol:route.protocol||'chat',adapter:route.adapter||'openai',secretRef:route.secret,enabled:true});
  models.push({id:metadata.id,name:metadata.name,provider:metadata.provider,channelId,upstreamModel:metadata.id,context:metadata.context,maxOutput:16384,efforts:defaultEfforts(metadata.id),inputModalities:route.inputModalities||(route.adapter==='ark'?['text','image','audio','video']:['text','image']),modes:route.modes||['chat','work','tocode'],minimumPlan:MODEL_MINIMUM_PLAN[metadata.id],enabled:true,rates:overrides[metadata.id]||CREDIT_RATES[metadata.id],thinking:route.thinking?.type||'default',effortParameter:route.effortParameter||'reasoning_effort'});
 }
 return {models,channels};
}
export function validateRates(rates){
 if(!rates||typeof rates!=='object'||Array.isArray(rates))throw error('请填写 Credits 单价');
 const result={};
 for(const key of ['input','cached','output']){if(!Number.isSafeInteger(rates[key])||rates[key]<=0||rates[key]>100000000)throw error('Credits 单价必须是 1 至 100000000 的整数');result[key]=rates[key];}
 for(const key of ['audioInput','audioCached'])if(rates[key]!==undefined){if(!Number.isSafeInteger(rates[key])||rates[key]<=0||rates[key]>100000000)throw error('音频 Credits 单价无效');result[key]=rates[key];}
 if(rates.threshold!==undefined){for(const key of ['threshold','longInput','longCached','longOutput']){if(!Number.isSafeInteger(rates[key])||rates[key]<=0||rates[key]>100000000)throw error('长上下文 Credits 单价或阈值无效');result[key]=rates[key];}}
 if(Object.keys(rates).some(key=>!['input','cached','output','audioInput','audioCached','threshold','longInput','longCached','longOutput'].includes(key)))throw error('Credits 字段无效');
 if(rates.threshold===undefined&&['longInput','longCached','longOutput'].some(key=>rates[key]!==undefined))throw error('长上下文单价需要阈值');
 return result;
}
function text(value,label,max=120){if(typeof value!=='string'||!value.trim()||value.trim().length>max||/[\x00-\x1f]/.test(value))throw error(label+'无效');return value.trim();}
function list(value,allowed,label){if(!Array.isArray(value)||!value.length||value.length>allowed.length||value.some(item=>!allowed.includes(item))||new Set(value).size!==value.length)throw error(label+'无效');return value;}
export function validateModel(body,channels){
 if(body?.id==='claude-opus-5')throw error('Claude Opus 5 已下架，请使用新模型 ID');
 if(!body||!idPattern.test(body.id)||['__proto__','constructor','prototype'].includes(body.id))throw error('模型 ID 无效');
 const channel=channels.find(item=>item.id===body.channelId);if(!channel)throw error('API 渠道不存在');
 if(typeof body.enabled!=='boolean')throw error('启用状态无效');
 if(body.minimumPlan!==null&&!Object.hasOwn(PLAN_RANKS,body.minimumPlan))throw error('最低订阅等级无效');
 for(const key of ['context','maxOutput'])if(!Number.isSafeInteger(body[key])||body[key]<256||body[key]>10000000)throw error('上下文或输出窗口无效');
 if(body.maxOutput>body.context)throw error('输出上限不能超过上下文窗口');
 const inputModalities=list(body.inputModalities,['text','image','audio','video'],'输入能力');
 if(!inputModalities.includes('text'))throw error('必须支持文本输入');
 // Audio/video transport currently uses Ark Responses; do not advertise unsupported wire formats.
 if(inputModalities.some(type=>['audio','video'].includes(type))&&(channel.protocol!=='responses'||channel.adapter!=='ark'))throw error('音视频输入需要方舟 Responses 渠道');
 const thinking=body.thinking||'default',effortParameter=body.effortParameter||'reasoning_effort';
 if(!['default','enabled','adaptive','disabled'].includes(thinking)||!['reasoning_effort','output_config','none'].includes(effortParameter))throw error('思考参数无效');
 return {id:body.id,name:text(body.name,'模型名称'),provider:text(body.provider,'提供商',60),channelId:channel.id,upstreamModel:text(body.upstreamModel,'上游模型 ID'),enabled:body.enabled,minimumPlan:body.minimumPlan,context:body.context,maxOutput:body.maxOutput,efforts:list(body.efforts,DEFAULT_EFFORTS,'思考强度'),inputModalities,modes:list(body.modes,['chat','work','tocode'],'开放模式'),rates:validateRates(body.rates),thinking,effortParameter};
}
export function validateChannel(body){
 if(!body||!idPattern.test(body.id))throw error('渠道 ID 无效');
 let url;try{url=new URL(body.url);}catch{throw error('API 地址无效');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||(url.port&&url.port!=='443')||!url.hostname.includes('.')||/^[\d.]+$/.test(url.hostname)||url.hostname.includes(':')||/(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname))throw error('API 地址必须是公网 HTTPS 完整接口地址，不含密钥或查询参数');
 if(!['chat','responses'].includes(body.protocol)||!['openai','ark','xai'].includes(body.adapter))throw error('API 协议无效');
 if(body.protocol==='chat'&&body.adapter!=='openai')throw error('专用适配器需要 Responses 协议');
 if(typeof body.enabled!=='boolean')throw error('渠道状态无效');
 return {id:body.id,name:text(body.name,'渠道名称'),url:url.href,protocol:body.protocol,adapter:body.adapter,enabled:body.enabled};
}
const bytesBase64=bytes=>btoa(String.fromCharCode(...bytes));
const base64Bytes=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
async function encryptionKey(env){let raw;try{raw=base64Bytes(env.MODEL_CATALOG_ENCRYPTION_KEY||'');}catch{}if(raw?.length!==32)throw error('新的 API 密钥加密服务尚未配置',503);return crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);}
async function encryptApiKey(env,id,value){const key=await encryptionKey(env),iv=crypto.getRandomValues(new Uint8Array(12)),cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(id)},key,new TextEncoder().encode(value));return {iv:bytesBase64(iv),cipher:bytesBase64(new Uint8Array(cipher))};}
export async function channelApiKey(env,channel){if(channel.keyCipher){try{return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:base64Bytes(channel.keyCipher.iv),additionalData:new TextEncoder().encode(channel.id)},await encryptionKey(env),base64Bytes(channel.keyCipher.cipher)));}catch{throw error('API 渠道密钥暂不可用',503);}}return channel.secretRef?env[channel.secretRef]||'':'';}
const initialized=new WeakSet();
export async function readOfficialCatalog(env){
 const db=env.DB;
 if(!initialized.has(db)){
  for(const sql of TABLES)await db.prepare(sql).bind().run();
  const defaults=defaultCatalog(env);for(const model of defaults.models)validateRates(model.rates);
  await db.prepare("INSERT INTO official_model_catalog(id,revision,document,updated_at) VALUES(1,1,?,?) ON CONFLICT(id) DO NOTHING").bind(JSON.stringify(defaults),Date.now()).run();initialized.add(db);
 }
 const row=await db.prepare('SELECT revision,document FROM official_model_catalog WHERE id=1').bind().first();
 if(!row)throw error('模型目录暂不可用',503);
 const doc=JSON.parse(row.document);if(!Array.isArray(doc.models)||!Array.isArray(doc.channels))throw error('模型目录格式无效',503);
 return {...doc,revision:row.revision};
}
export function resolvedModels(catalog){return Object.fromEntries(catalog.models.filter(model=>!model.deleted).map(model=>{const channel=catalog.channels.find(item=>item.id===model.channelId);return [model.id,{...model,channel,url:channel?.url,protocol:channel?.protocol,adapter:channel?.adapter,secret:channel?.secretRef,thinking:model.thinking==='default'?undefined:{type:model.thinking},inputModalities:model.inputModalities}];}));}
export function adminCatalog(catalog,env){return {revision:catalog.revision,models:catalog.models.map(model=>({...model})),channels:catalog.channels.map(({keyCipher,secretRef,...channel})=>({...channel,keySet:!!keyCipher||!!env[secretRef],managedSecret:!!secretRef})),encryptionReady:!!env.MODEL_CATALOG_ENCRYPTION_KEY};}
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','cache-control':'no-store','access-control-allow-origin':'*'}});
export async function handleAdminModels(request,env){
 try{
  const catalog=await readOfficialCatalog(env),path=new URL(request.url).pathname;
  if(path==='/admin/official-models'&&request.method==='GET')return json(adminCatalog(catalog,env));
  const match=path.match(/^\/admin\/(official-models|model-channels)(?:\/([a-zA-Z0-9._-]{1,120}))?$/);
  if(!match)return json({detail:'接口不存在'},404);
  if(!['POST','PATCH','DELETE'].includes(request.method))return json({detail:'方法不允许'},405);
  const raw=await request.text();if(raw.length>65536)throw error('配置过大',413);
  const body=JSON.parse(raw);if(!Number.isSafeInteger(body.revision)||body.revision!==catalog.revision)throw error('配置已被其他管理员修改，请刷新后重试',409);
  const kind=match[1]==='official-models'?'models':'channels',items=catalog[kind],id=match[2]||body.id,index=items.findIndex(item=>item.id===id),create=request.method==='POST';
  if(create&&match[2]||!create&&!match[2])throw error('接口格式无效');
  if(create&&index>=0)throw error('ID 已存在；已删除模型可以恢复',409);
  if(!create&&index<0)throw error('配置不存在',404);
  const previous=items[index];let next;
  if(request.method==='DELETE'){
   if(kind==='channels'&&catalog.models.some(model=>!model.deleted&&model.channelId===id))throw error('渠道仍被模型使用，请先更换模型渠道',409);
   next={...previous,enabled:false,deleted:true};
  }else if(kind==='models'){
   next=validateModel({...previous,...body,id},catalog.channels.filter(channel=>!channel.deleted));
  }else{
   next={...validateChannel({...previous,...body,id}),...(previous?.secretRef?{secretRef:previous.secretRef}:{}),...(previous?.keyCipher?{keyCipher:previous.keyCipher}:{})};
   if(body.apiKey!==undefined&&typeof body.apiKey!=='string')throw error('API Key 无效');
   if(body.apiKey?.trim()){if(body.apiKey.length>4096||/[\r\n\x00]/.test(body.apiKey))throw error('API Key 无效');next.keyCipher=await encryptApiKey(env,id,body.apiKey.trim());delete next.secretRef;}
   if(!next.secretRef&&!next.keyCipher)throw error('新渠道需要 API Key');
   if(next.secretRef&&next.url!==previous.url&&!body.apiKey?.trim())throw error('更换预置渠道地址需要同时提供新 API Key');
   for(const model of catalog.models.filter(model=>!model.deleted&&model.channelId===id))validateModel(model,[next]);
  }
  if(create)items.push(next);else items[index]=next;
  if(items.length>200)throw error('最多支持 200 项配置');
  const revision=catalog.revision+1,writeId=crypto.randomUUID(),now=Date.now(),action=`${kind}:${request.method.toLowerCase()}`;
  const safeDetails=kind==='models'?next:{id:next.id,name:next.name,url:next.url,protocol:next.protocol,adapter:next.adapter,enabled:next.enabled,deleted:next.deleted,apiKeyChanged:!!body.apiKey?.trim()};
  const results=await env.DB.batch([
   env.DB.prepare('UPDATE official_model_catalog SET document=?,revision=?,write_id=?,updated_at=? WHERE id=1 AND revision=?').bind(JSON.stringify({models:catalog.models,channels:catalog.channels}),revision,writeId,now,catalog.revision),
   env.DB.prepare('INSERT INTO official_catalog_audit(id,revision,action,target,detail,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM official_model_catalog WHERE id=1 AND write_id=?)').bind(writeId,revision,action,id,JSON.stringify(safeDetails),now,writeId),
  ]);
  if(results[0]?.meta?.changes!==1)throw error('配置已更新，请刷新后重试',409);
  return json(adminCatalog({...catalog,revision},env));
 }catch(e){return json({detail:e instanceof SyntaxError?'配置 JSON 无效':e.message},e.status||400);}
}
