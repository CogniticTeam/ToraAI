import {DEFAULT_TITLE,sanitizeTitle,titleMessages} from '../../core/src/title-rules.js';
import {toResponsesBody,responsesChatStream} from './tochat-responses.js';
/** Small, tool-free metadata request using the same selected provider as the conversation. */
export async function generateOfficialTitle(env,input,model,fetcher=fetch){
 if(!input||typeof input.userText!=='string'||!input.userText.trim()||input.userText.length>400) return {status:400,data:{detail:'标题输入无效'}};
 if(!model||!env[model.secret]||env.TOCHAT_ENABLED==='0')return {status:503,data:{detail:'标题服务暂不可用'}};
 const messages=titleMessages({userText:input.userText});
 const structured=input.model==='claude-opus-5';
 const tools=structured?[{type:'function',function:{name:'return_title',description:'Return a short title. No real operation is performed.',parameters:{type:'object',properties:{title:{type:'string'}},required:['title'],additionalProperties:false}}}]:[];
 if(structured)messages[0].content+=' 使用 return_title 提交标题。';
 const body=model.protocol==='responses'?{...toResponsesBody({model:input.model,messages},'low',model.adapter==='ark'?512:4096,model.adapter),stream:true,tools:[],tool_choice:'none'}:{model:input.model,messages,stream:true,...(structured?{tools,tool_choice:{type:'function',function:{name:'return_title'}}}:{}),max_tokens:structured?4096:1024,...(input.model==='deepseek-flash'?{thinking:{type:'disabled'}}:{reasoning_effort:'low'})};
 if(model.adapter==='ark'){delete body.reasoning;body.thinking={type:'disabled'};}
 try{
  const response=await fetcher(model.url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${env[model.secret]}`},body:JSON.stringify(body),signal:AbortSignal.timeout(18000)});
  if(!response.ok)return {status:502,data:{detail:'标题生成失败'}};
  let text='';const calls=new Map();
  if(response.headers.get('content-type')?.includes('text/event-stream')){
   const stream=model.protocol==='responses'?responsesChatStream(response,input.model):response;
   const reader=stream.body.getReader(),decoder=new TextDecoder();let buffer='';
   const consume=line=>{if(!line.startsWith('data:'))return;const raw=line.slice(5).trim();if(!raw||raw==='[DONE]')return;const event=JSON.parse(raw);if(event.error)throw Error('Title stream failed');for(const choice of event.choices||[]){if(typeof choice.delta?.content==='string')text+=choice.delta.content;for(const chunk of choice.delta?.tool_calls||[]){const previous=calls.get(chunk.index||0)||{name:'',args:''};previous.name+=chunk.function?.name||'';previous.args+=chunk.function?.arguments||'';calls.set(chunk.index||0,previous);}}};
   try{for(;;){const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true});const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines)consume(line);if(text.length>16384||buffer.length>1048576)throw Error('Title response too large');}buffer+=decoder.decode();if(buffer.trim())consume(buffer.trim());}finally{await reader.cancel().catch(()=>{});}
  }else{
   const data=await response.json();text=model.protocol==='responses'?(data.output||[]).filter(item=>item.type==='message').flatMap(item=>item.content||[]).map(part=>part.text||'').join(''):data.choices?.[0]?.message?.content;
  }
  if(structured)for(const call of calls.values())if(call.name==='return_title'){try{const title=JSON.parse(call.args).title;if(typeof title==='string')text=title;}catch{}}
  const title=sanitizeTitle(text);return {status:200,data:{title:title&&title!==DEFAULT_TITLE?title:null}};
 }catch{return {status:502,data:{detail:'标题生成失败'}};}
}
