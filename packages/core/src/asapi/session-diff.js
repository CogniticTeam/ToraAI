import {resolve} from 'node:path';

/** Latest recorded Write/Edit turn; no filesystem reads or Git requirement. */
export function recordedSessionDiff(record,root,path) {
 const wanted=path?resolve(root,path):null;
 for(const message of [...(record?.display||[])].reverse()){
  if(message.role!=='assistant'||!Array.isArray(message.content))continue;
  const calls=new Map(message.content.filter(block=>block.type==='tool_call'&&['Write','Edit'].includes(block.name)).map(block=>[block.id,block]));
  const diffs=[];
  for(const block of message.content){
   if(block.type!=='tool_result'||block.state!=='success'||typeof block.metadata?.diff!=='string'||!block.metadata.diff.trim())continue;
   const call=calls.get(block.id);if(!call)continue;
   let input;try{input=typeof call.input==='string'?JSON.parse(call.input):call.input;}catch{continue;}
   const file=input?.path||input?.file_path;if(typeof file!=='string'||!file)continue;
   if(wanted&&resolve(root,file)!==wanted)continue;
   const name=file.replace(/[\r\n]/g,' ');
   diffs.push(/^--- /m.test(block.metadata.diff)?block.metadata.diff:`--- ${name}\n+++ ${name}\n${block.metadata.diff}`);
  }
  if(diffs.length)return diffs.join('\n\n').slice(0,200000);
 }
 return '';
}
