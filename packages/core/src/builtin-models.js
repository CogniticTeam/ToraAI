// Public metadata; upstream API keys remain in the Tora service.
export const BUILTIN_CREDENTIAL_ID = 'tora-official';
export const BUILTIN_PROVIDER_TYPE = 'tora_official';
export const BUILTIN_MODELS = [
  {id:'deepseek-flash',name:'DeepSeek Flash',provider:'deepseek'},
  {id:'gemini-3.8-flash',name:'Gemini 3.8 Flash',provider:'google'},
  {id:'gpt-6.1-sol',name:'GPT-6.1 Sol',provider:'openai'},
];
export const isBuiltinCredential = id => id===BUILTIN_CREDENTIAL_ID||id==='tora-tochat-official';
export const isBuiltinModel = id => BUILTIN_MODELS.some(model=>model.id===id);
let runtimeAuth = null;
export const builtinAuth = cfg => runtimeAuth ?? cfg.tochat ?? {};
export const setBuiltinAuth = auth => { runtimeAuth = {...auth}; };
