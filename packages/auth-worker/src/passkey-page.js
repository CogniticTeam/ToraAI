import {randomToken} from './auth-security.js';

// Public UI copy only. No account data or flow capability is embedded in the HTML.
import passkeyPageCopy from './passkey-locales.js';
export {passkeyPageCopy};

export function passkeyPage(){
 const nonce=randomToken();
 const packs=JSON.stringify(passkeyPageCopy).replaceAll('<','\\u003c');
 const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tora</title><style nonce="${nonce}">:root{color-scheme:light dark;--bg:#fff;--fg:#111;--muted:#666;--border:#ddd;--button:#111;--button-text:#fff}@media(prefers-color-scheme:dark){:root{--bg:#212121;--fg:#f8f8f8;--muted:#b0b0b0;--border:#444;--button:#fff;--button-text:#111}}*{box-sizing:border-box}body{margin:0;font-family:system-ui;background:var(--bg);color:var(--fg);min-height:100vh;display:grid;place-items:center;padding:32px 24px}main{width:100%;max-width:380px;text-align:center}.brand{font-size:22px;font-weight:650;margin-bottom:32px}h1{font-size:28px;font-weight:550;line-height:1.3;margin:0 0 20px}p{line-height:1.65;color:var(--muted);font-size:14px}output{display:block;direction:ltr;font-size:30px;letter-spacing:7px;margin:26px 0}button{border:0;width:100%;border-radius:999px;background:var(--button);color:var(--button-text);font:inherit;font-weight:550;padding:15px;margin-top:12px;cursor:pointer}button:disabled{opacity:.45;cursor:default}button:focus-visible{outline:2px solid var(--fg);outline-offset:4px}[hidden]{display:none!important}</style></head><body><main><div class="brand">Tora</div><h1 id="title"></h1><p id="description" role="status"></p><output id="code"></output><button id="continue" hidden></button></main><script nonce="${nonce}">
const packs=${packs};const params=new URLSearchParams(location.hash.slice(1));const flow=params.get('flow')||'';const language=params.get('lang')||'zh';history.replaceState(null,'',location.pathname);
const copy=packs[language]||packs[language.split('-')[0]]||packs.en;document.documentElement.lang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';
const title=document.getElementById('title'),description=document.getElementById('description'),button=document.getElementById('continue'),code=document.getElementById('code');description.textContent=copy.loading;button.textContent=copy.continue;
const decode=value=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0));const encode=buffer=>btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
async function api(path,data){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const body=await response.json();if(!response.ok)throw Error(body.code||'failed');return body;}
let challenge;
async function prepare(){if(!window.PublicKeyCredential||!navigator.credentials){description.textContent=copy.unsupported;return;}try{challenge=await api('/auth/passkeys/options',{flow});title.textContent=challenge.purpose==='register'?copy.register:copy.login;description.textContent=copy.confirm;code.textContent=challenge.confirmation;button.hidden=false;}catch{description.textContent=copy.failed;}}
button.addEventListener('click',async()=>{button.disabled=true;description.textContent=copy.loading;try{
 const publicKey={...challenge.options,challenge:decode(challenge.options.challenge)};let credential;
 if(challenge.purpose==='register'){publicKey.user={...publicKey.user,id:decode(publicKey.user.id)};publicKey.excludeCredentials=publicKey.excludeCredentials?.map(key=>({...key,id:decode(key.id)}));credential=await navigator.credentials.create({publicKey});}
 else{publicKey.allowCredentials=publicKey.allowCredentials?.map(key=>({...key,id:decode(key.id)}));credential=await navigator.credentials.get({publicKey});}
 if(!credential)throw Error('canceled');const response=credential.response;
 const proof={id:credential.id,rawId:encode(credential.rawId),type:credential.type,clientExtensionResults:credential.getClientExtensionResults(),response:challenge.purpose==='register'?{clientDataJSON:encode(response.clientDataJSON),attestationObject:encode(response.attestationObject),transports:response.getTransports?.()||[]}:{clientDataJSON:encode(response.clientDataJSON),authenticatorData:encode(response.authenticatorData),signature:encode(response.signature),userHandle:response.userHandle?encode(response.userHandle):null}};
 await api('/auth/passkeys/verify',{flow,id:challenge.id,response:proof});description.textContent=copy.done;code.hidden=true;button.hidden=true;
 }catch(error){description.textContent=error.name==='NotAllowedError'?copy.canceled:copy.failed;button.disabled=false;try{challenge=await api('/auth/passkeys/options',{flow});}catch{button.hidden=true;}}});prepare();
</script></body></html>`;
 return new Response(html,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':`default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`}});
}
