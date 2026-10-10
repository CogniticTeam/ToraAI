import {DOUBAO_MODEL_ID,DOUBAO_INPUT_TYPES} from './chat-media.js';
// Public metadata; upstream API keys remain in the Tora service.
export const BUILTIN_CREDENTIAL_ID = 'tora-official';
export const BUILTIN_PROVIDER_TYPE = 'tora_official';
export const BUILTIN_MODELS = [
  {id:DOUBAO_MODEL_ID,name:'Doubao Seed 2.1 Lite',provider:'volcengine',context:1048576,modes:['chat'],inputTypes:DOUBAO_INPUT_TYPES},
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
export const isBuiltinModel = id => BUILTIN_MODELS.some(model=>model.id===id);
export const builtinModelAllowed = (id,mode) => {const model=BUILTIN_MODELS.find(item=>item.id===id);return !!model&&(!model.modes||model.modes.includes(mode));};
let runtimeAuth = null;
export const builtinAuth = cfg => runtimeAuth ?? cfg.tochat ?? {};
export const setBuiltinAuth = auth => { runtimeAuth = {...auth}; };
