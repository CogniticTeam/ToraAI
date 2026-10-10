import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {recordedSessionDiff} from '../src/asapi/session-diff.js';

const turn=(id,path,diff,state='success',name='Write')=>({role:'assistant',content:[{type:'tool_call',id,name,input:JSON.stringify({path})},{type:'tool_result',id,name,state,metadata:{diff}}]});
test('recorded diff selects the latest successful Write/Edit turn and labels headerless patches',()=>{
 const record={display:[turn('old','a.txt','@@ -1 +1 @@\n-old\n+previous'),turn('new','b.txt','@@ -0,0 +1 @@\n+new file'),turn('failed','c.txt','+not written','error')]};
 assert.match(recordedSessionDiff(record,'/project'),/b.txt/);assert.match(recordedSessionDiff(record,'/project'),/\+new file/);assert.doesNotMatch(recordedSessionDiff(record,'/project'),/old|not written/);
 assert.match(recordedSessionDiff(record,'/project','a.txt'),/\+previous/);assert.equal(recordedSessionDiff(record,'/project','unknown.txt'),'');
 assert.equal(recordedSessionDiff({display:[turn('read','a.txt','+read only','success','Read')]},'/project'),'');
});

const home=mkdtempSync(join(tmpdir(),'tora-non-git-diff-'));process.env.TORA_HOME=join(home,'data');
const{startASAPIServer}=await import('../src/asapi/server.js');
const{loadSessionRecord,saveSessionRecord}=await import('../src/asapi/store.js');
const server=await startASAPIServer({port:0}),base='http://127.0.0.1:'+server.address().port;
after(async()=>{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));rmSync(home,{recursive:true,force:true});});
test('non-Git workspace previews recorded changes without creating a repository; staged and Git working-tree views remain separate',async()=>{
 const agent=(await(await fetch(base+'/agent/')).json()).agents[0],cwd=join(home,'project');mkdirSync(cwd);
 const made=await(await fetch(base+'/sessions/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agent_id:agent.id,cwd})})).json();
 const url=base+'/workspace/diff?session_id='+made.session_id;
 const empty=await(await fetch(url)).json();assert.equal(empty.error_code,'not_git_repository');
 const record=loadSessionRecord(made.session_id);record.display=[turn('file','pelican-bike.html','--- /dev/null\n+++ b/pelican-bike.html\n@@ -0,0 +1,2 @@\n+<html>\n+</html>')];saveSessionRecord(record);
 const data=await(await fetch(url)).json();assert.equal(data.source,'session');assert.match(data.diff,/\+<html>/);assert.equal(data.error_code,undefined);assert.equal(existsSync(join(cwd,'.git')),false);
 const staged=await(await fetch(url+'&staged=1')).json();assert.equal(staged.error_code,'not_git_repository');
 const filtered=await(await fetch(url+'&path=other.txt')).json();assert.equal(filtered.diff,'');
 execFileSync('git',['init','--quiet'],{cwd});
 const actual=await(await fetch(url)).json();assert.equal(actual.source,undefined);assert.equal(actual.diff,'','Git working-tree mode must not display old recorded patches');
});
