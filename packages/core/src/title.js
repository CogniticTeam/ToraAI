// First-message naming is a background task; failure keeps the readable placeholder.
import {createClient,chatCompletion} from './model.js';
import {modelFetch} from './model-transport.js';
import {DEFAULT_TITLE,sanitizeTitle,titleMessages,normalizeTitleLanguage} from './title-rules.js';
export {DEFAULT_TITLE,placeholderTitle} from './title-rules.js';
export async function generateTitle(cfg,{userText,assistantText,language}) {
 if(!String(userText||'').trim())return null;
 try {
  let text;language=normalizeTitleLanguage(language);
  if(cfg.provider==='tochat-official'){
   // Separate metadata endpoint never shares a turn ID or reservation with an Agent run.
   const response=await modelFetch(cfg.baseURL.replace(/\/v1\/?$/,'')+'/title',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${cfg.apiKey}`},body:JSON.stringify({model:cfg.model,userText:String(userText).slice(0,400),...(language?{language}:{})}),signal:AbortSignal.timeout(20000)});
   if(!response.ok)return null;text=(await response.json()).title;
  }else{
   const client=createClient({...cfg,temperature:0.2,thinking:false,thinkingEffort:'low'});
   const {message}=await chatCompletion(client,{messages:titleMessages({userText,assistantText,language}),signal:AbortSignal.timeout(20000)});text=message?.content;
  }
  const title=sanitizeTitle(text,language);return title&&title!==DEFAULT_TITLE?title:null;
 }catch{return null;}
}
