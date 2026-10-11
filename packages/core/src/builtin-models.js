import {DOUBAO_MODEL_ID,DOUBAO_INPUT_TYPES,IMAGE_MIME_TYPES,AUDIO_MIME_TYPES,VIDEO_MIME_TYPES} from './chat-media.js';
// Public metadata; upstream API keys remain in the Tora service.
export const BUILTIN_CREDENTIAL_ID = 'tora-official';
export const BUILTIN_PROVIDER_TYPE = 'tora_official';
export const BUILTIN_MODELS = [
  {id:DOUBAO_MODEL_ID,name:'Doubao Seed 2.1 Lite',provider:'volcengine',context:1048576,modes:['chat','work'],inputTypes:DOUBAO_INPUT_TYPES},
  {id:'gpt-6.1-sol',name:'GPT-6.1 Sol',provider:'openai',context:1050000},
  {id:'gpt-6-astra',name:'GPT-6 Astra',provider:'openai',context:1050000},
  {id:'gpt-6-sol',name:'GPT-6 Sol',provider:'openai',context:1050000},
  {id:'gpt-6-luna',name:'GPT-6 Luna',provider:'openai',context:1050000},
  {id:'grok-4.7',name:'Grok 4.7',provider:'xai',context:500000},
  {id:'claude-opus-5-5',name:'Claude Opus 5.5',provider:'anthropic',context:1000000},
  {id:'claude-sonnet-5-5',name:'Claude Sonnet 5.5',provider:'anthropic',context:1000000},
  {id:'claude-haiku-5-5',name:'Claude Haiku 5.5',provider:'anthropic',context:1000000},
  {id:'glm-5.3',name:'GLM 5.3',provider:'bigmodel',context:1000000,inputTypes:['text']},
  {id:'deepseek-flash',name:'DeepSeek Flash',provider:'deepseek',context:1048576},
  {id:'gemini-3.8-flash',name:'Gemini 3.8 Flash',provider:'google',context:1048576},
];
export const isBuiltinCredential = id => id===BUILTIN_CREDENTIAL_ID||id==='tora-tochat-official';
let runtimeCatalog=null,runtimeCatalogRevision=0;
export const getBuiltinModels=()=>runtimeCatalog??BUILTIN_MODELS;
export function setBuiltinCatalog(models,revision=undefined){
 if(revision!==undefined&&(!Number.isSafeInteger(revision)||revision<1))throw Error('官方模型目录版本无效');
 if(revision!==undefined&&revision<runtimeCatalogRevision)return runtimeCatalog;
 if(!Array.isArray(models)||models.length>200)throw Error('官方模型目录无效');
 const seen=new Set();
 const catalog=models.map(model=>{
  if(typeof model.id!=='string'||!model.id||seen.has(model.id)||!Number.isSafeInteger(model.context)||model.context<256||model.context>10000000||typeof model.name!=='string'||!Array.isArray(model.modes)||!model.modes.every(mode=>['chat','work','tocode'].includes(mode))||!Array.isArray(model.input_modalities))throw Error('官方模型元数据无效');
  seen.add(model.id);
  const types={text:['text'],image:IMAGE_MIME_TYPES,audio:AUDIO_MIME_TYPES,video:VIDEO_MIME_TYPES};
  return {id:model.id,name:model.name,provider:model.provider||'custom',context:model.context,maxOutput:model.maxOutput||16384,efforts:model.efforts,modes:model.modes,inputTypes:model.input_modalities.flatMap(type=>types[type]||[]),enabled:model.enabled};
 });
 runtimeCatalog=catalog;if(revision!==undefined)runtimeCatalogRevision=revision;return catalog;
}
export const isBuiltinModel = id => getBuiltinModels().some(model=>model.id===id&&model.enabled!==false);
export const builtinModelAllowed = (id,mode) => {const model=getBuiltinModels().find(item=>item.id===id);return !!model&&model.enabled!==false&&(!model.modes||model.modes.includes(mode));};
let runtimeAuth = null;
export const builtinAuth = cfg => runtimeAuth ?? cfg.tochat ?? {};
export const setBuiltinAuth = auth => {if(runtimeAuth?.authToken!==auth.authToken||runtimeAuth?.baseURL!==auth.baseURL){runtimeCatalog=null;runtimeCatalogRevision=0;}runtimeAuth = {...auth};};
