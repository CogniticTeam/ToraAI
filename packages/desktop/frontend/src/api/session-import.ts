import {getBaseUrl,getUserId} from './client';
export type ImportSource='codex'|'claude';
export interface ImportCandidate {selection_id:string;source:ImportSource;name:string;title:string;cwd:string;size_bytes:number;modified_at:string}
export interface ImportPreviewEntry {id:string;source:ImportSource;name:string;title:string;cwd:string;model:string;created_at:string|null;updated_at:string|null;message_count:number;duplicate:boolean;warnings:{invalid_lines:number;omitted_attachments:number;omitted_process_blocks:number;skipped_entries:number;unknown_timestamps:number};sample:{role:'user'|'assistant';text:string;created_at:string|null}[]}
export interface ImportPreview {preview_id:string;entries:ImportPreviewEntry[];errors:{name:string;code:string;detail:string}[]}
export class SessionImportClientError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
async function call<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{
 const response=await fetch(new URL('/sessions/import/'+path,getBaseUrl()),{method:body===undefined?'GET':'POST',signal,headers:{'X-User-ID':getUserId(),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const result=await response.json();if(!response.ok)throw new SessionImportClientError(result.code||'import_failed');return result;
}
export const sessionImportApi={
 discover:(source:ImportSource,signal?:AbortSignal)=>call<{sessions:ImportCandidate[];total:number;limited:boolean}>('sources?source='+source,undefined,signal),
 preview:(body:{selection_ids?:string[];files?:{name:string;content:string;source?:string}[]},signal?:AbortSignal)=>call<ImportPreview>('preview',body,signal),
 commit:(body:{preview_id:string;entry_ids:string[];agent_id:string;application_mode:'tochat'|'tocode'})=>call<{session_ids:string[];imported:number;skipped:number}>('commit',body),
};
