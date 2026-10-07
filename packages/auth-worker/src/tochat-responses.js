// Server-side Responses adapter. No provider key or routing choice comes from clients.
export function toResponsesBody(body, effort, maxOutput, adapter = 'openai') {
  const input=[], instructions=[];
  for(const message of body.messages) {
    if(message.role==='system') {instructions.push(typeof message.content==='string'?message.content:(message.content||[]).map(part=>part.text||'').join('\n'));continue;}
    if(message.role==='tool') {input.push({type:'function_call_output',call_id:message.tool_call_id,output:String(message.content??'')});continue;}
    if(message.role==='assistant'&&Array.isArray(message.tora_response_items)) {
      if(message.tora_response_items.length>32)throw Error('模型上下文格式无效');
      for(const item of message.tora_response_items) {
        if(item?.type!=='reasoning'||typeof item.id!=='string'||typeof item.encrypted_content!=='string'||item.encrypted_content.length>1024*1024)throw Error('模型上下文格式无效');
        input.push({type:'reasoning',id:item.id,encrypted_content:item.encrypted_content,summary:(item.summary||[]).filter(part=>part?.type==='summary_text'&&typeof part.text==='string').map(part=>({type:'summary_text',text:part.text}))});
      }
    }
    const content=typeof message.content==='string' ? [{type:message.role==='assistant'?'output_text':'input_text',text:message.content}] : (message.content||[]).map(part=>{
      if(part.type==='image_url')return {type:'input_image',image_url:part.image_url.url};
      if(part.type==='input_audio'||part.type==='input_video'){
        if(adapter!=='ark')throw Error('此模型不支持音频或视频附件');
        return part.type==='input_audio'?{type:'input_audio',audio_url:part.audio_url}:{type:'input_video',video_url:part.video_url,fps:1};
      }
      return {type:message.role==='assistant'?'output_text':'input_text',text:part.text||''};
    });
    if(content.some(part=>['input_image','input_audio','input_video'].includes(part.type)||part.text))input.push({role:message.role,content});
    for(const call of message.tool_calls||[])input.push({type:'function_call',call_id:call.id,name:call.function.name,arguments:call.function.arguments||'{}'});
  }
  const tools=(body.tools||[]).map(tool=>({type:'function',name:tool.function.name,description:tool.function.description,parameters:tool.function.parameters,strict:false}));
  return {model:body.model,instructions:instructions.join('\n\n'),input,tools:tools.length?tools:undefined,tool_choice:tools.length?'auto':undefined,reasoning:adapter==='ark'?{effort}:{effort,summary:'auto'},max_output_tokens:maxOutput,stream:true,store:false,include:['reasoning.encrypted_content']};
}

/** Convert semantic Responses SSE into the existing Chat stream, preserving opaque reasoning. */
export function responsesChatStream(response, model) {
  if(!response.headers.get('content-type')?.includes('text/event-stream'))throw Error('模型未返回有效的流式响应');
  const reader=response.body.getReader(),decoder=new TextDecoder(),encoder=new TextEncoder();
  let buffer='',ended=false,textSeen=false,reasoningSeen=false;
  const calls=new Map();
  return new Response(new ReadableStream({
    async start(controller) {
      const emit=data=>controller.enqueue(encoder.encode('data: '+JSON.stringify({model,...data})+'\n\n'));
      const delta=value=>emit({choices:[{index:0,delta:value,finish_reason:null}]});
      const tool=item=>{if(calls.has(item.call_id))return;const index=calls.size;calls.set(item.call_id,index);delta({tool_calls:[{index,id:item.call_id,type:'function',function:{name:item.name,arguments:item.arguments||'{}'}}]});};
      const line=value=>{
        if(!value.startsWith('data:'))return;
        const payload=value.slice(5).trim();if(!payload||payload==='[DONE]')return;
        const event=JSON.parse(payload);
        if(event.type==='response.output_text.delta'){textSeen=true;delta({content:event.delta});}
        else if(event.type==='response.reasoning_summary_text.delta'){reasoningSeen=true;delta({reasoning_content:event.delta});}
        else if(event.type==='response.output_item.done'&&event.item?.type==='function_call')tool(event.item);
        else if(event.type==='response.completed') {
          if(event.response?.status&&event.response.status!=='completed')throw Error('模型回复未完成');
          const items=event.response?.output||[];
          for(const item of items)if(item.type==='function_call')tool(item);
          if(!textSeen){const text=items.filter(item=>item.type==='message').flatMap(item=>item.content||[]).map(part=>part.text||part.refusal||'').join('');if(text)delta({content:text});}
          if(!reasoningSeen){const text=items.filter(item=>item.type==='reasoning').flatMap(item=>item.summary||[]).map(part=>part.text||'').join('');if(text)delta({reasoning_content:text});}
          const contexts=items.filter(item=>item.type==='reasoning'&&typeof item.encrypted_content==='string').map(item=>({type:'reasoning',id:item.id,encrypted_content:item.encrypted_content,summary:item.summary||[]}));
          if(contexts.length)emit({choices:[],tora_response_items:contexts});
          const usage=event.response?.usage;
          emit({choices:[{index:0,delta:{},finish_reason:calls.size?'tool_calls':'stop'}],...(usage?{usage:{prompt_tokens:usage.input_tokens,completion_tokens:usage.output_tokens,total_tokens:usage.total_tokens??usage.input_tokens+usage.output_tokens,prompt_tokens_details:usage.input_tokens_details,completion_tokens_details:usage.output_tokens_details}}:{})});
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));ended=true;
        } else if(['response.failed','response.incomplete','error'].includes(event.type))throw Error('模型回复失败或未完成');
      };
      try {
        for(;;){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split('\n');buffer=lines.pop();for(const value of lines)line(value.replace(/\r$/,''));if(buffer.length>2*1024*1024)throw Error('模型响应过大');}
        buffer+=decoder.decode();if(buffer.trim())line(buffer.trim());if(!ended)throw Error('模型流式响应中断');controller.close();
      } catch {controller.error(Error('模型流式响应中断'));}finally{await reader.cancel().catch(()=>{});}
    },
    cancel(){return reader.cancel().catch(()=>{});},
  }),{headers:{'content-type':'text/event-stream'}});
}
