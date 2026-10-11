import {DOUBAO_MODEL_ID} from '../../core/src/chat-media.js';
export const DEFAULT_ROUTES = Object.freeze({
  [DOUBAO_MODEL_ID]: {name:'Doubao Seed 2.1 Lite',secret:'ARK_API_KEY',url:'https://ark.cn-beijing.volces.com/api/v3/responses',protocol:'responses',adapter:'ark',modes:['chat','work']},
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
