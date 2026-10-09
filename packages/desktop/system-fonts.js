import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
export function normalizeFontFamilies(values){
 return [...new Set(values.filter(value=>typeof value==='string').map(value=>value.trim()).filter(value=>value&&value.length<=160&&!value.startsWith('.')&&!/[\u0000-\u001f\u007f]/.test(value)))].sort((a,b)=>a.localeCompare(b)).slice(0,5000);
}
export function parseFontFamilies(output,platform){
 if(platform==='darwin'){
  const data=JSON.parse(output);
  if(Array.isArray(data))return normalizeFontFamilies(data);
  const records=data.SPFontsDataType||[];
  return normalizeFontFamilies(records.filter(item=>item.enabled!=='no'&&item.valid!=='no').flatMap(item=>(item.typefaces||[]).filter(face=>face.enabled!=='no'&&face.valid!=='no').map(face=>face.family)));
 }
 if(platform==='win32'){const data=JSON.parse(output.replace(/^\uFEFF/,''));return normalizeFontFamilies(Array.isArray(data)?data:[data]);}
 return normalizeFontFamilies(output.split(/\r?\n/));
}
export function createSystemFontService({platform=process.platform,run=execute,now=Date.now}={}){
 let cached=null,expires=0,pending=null;
 return async function list(refresh=false){
  if(pending)return pending;
  if(!refresh&&cached&&now()<expires)return cached;
  pending=(async()=>{
   let command,args;
   if(platform==='darwin'){
    // Query the OS font registry directly, without inspecting every font file.
    // This fixed script only reads CoreText metadata; it never automates the UI.
    command='/usr/bin/osascript';args=['-l','JavaScript','-e',"ObjC.import('CoreText'); JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CTFontManagerCopyAvailableFontFamilyNames())));"];
   }
   else if(platform==='win32'){
    command='powershell.exe';args=['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Drawing; $collection=[System.Drawing.Text.InstalledFontCollection]::new(); try { ConvertTo-Json -InputObject @($collection.Families | ForEach-Object { $_.Name }) -Compress } finally { $collection.Dispose() }"];
   }else if(platform==='linux'){command='fc-list';args=['--format','%{family[0]}\\n'];}
   else throw Error('unsupported-platform');
   const scan=async(command,args)=>{
    const {stdout}=await run(command,args,{encoding:'utf8',timeout:20000,maxBuffer:32*1024*1024,windowsHide:true});
    const names=parseFontFamilies(stdout,platform);if(!names.length)throw Error('font-list-empty');return names;
   };
   let names;
   try{names=await scan(command,args);}catch(error){
    if(platform!=='darwin')throw error;
    names=await scan('/usr/sbin/system_profiler',['SPFontsDataType','-json']);
   }
   cached=names;expires=now()+60000;return names;
  })();
  try{return await pending;}finally{pending=null;}
 };
}
