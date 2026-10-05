// Public metadata; upstream API keys remain in the Tora service.
export const BUILTIN_CREDENTIAL_ID = 'tora-official';
export const BUILTIN_PROVIDER_TYPE = 'tora_official';
export const BUILTIN_MODELS = [
  {id:'gpt-6.1-sol',name:'GPT-6.1 Sol',provider:'openai',context:1050000},
  {id:'gpt-6-astra',name:'GPT-6 Astra',provider:'openai',context:1050000},
  {id:'gpt-6-sol',name:'GPT-6 Sol',provider:'openai',context:1050000},
  {id:'gpt-6-luna',name:'GPT-6 Luna',provider:'openai',context:1050000},
  {id:'claude-opus-5',name:'Claude Opus 5',provider:'anthropic',context:1000000},
  {id:'deepseek-flash',name:'DeepSeek Flash',provider:'deepseek',context:1048576},
  {id:'gemini-3.8-flash',name:'Gemini 3.8 Flash',provider:'google',context:1048576},
];
export const isBuiltinCredential = id => id===BUILTIN_CREDENTIAL_ID||id==='tora-tochat-official';
export const isBuiltinModel = id => BUILTIN_MODELS.some(model=>model.id===id);
let runtimeAuth = null;
export const builtinAuth = cfg => runtimeAuth ?? cfg.tochat ?? {};
export const setBuiltinAuth = auth => { runtimeAuth = {...auth}; };
