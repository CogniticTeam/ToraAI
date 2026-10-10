import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const home=mkdtempSync(join(tmpdir(),'tora-quota-transport-'));process.env.TORA_HOME=home;
const{startASAPIServer}=await import('../src/asapi/server.js');const{setBuiltinAuth}=await import('../src/builtin-models.js');
const original=globalThis.fetch,server=await startASAPIServer({port:0}),base='http://127.0.0.1:'+server.address().port;
after(async()=>{globalThis.fetch=original;server.closeAllConnections?.();await new Promise(r=>server.close(r));rmSync(home,{recursive:true,force:true});});
test('quota uses the server account token and Node transport; failed/foreign requests do not expose keys',async()=>{
 setBuiltinAuth({baseURL:'https://quota-fixture.invalid',authToken:'synthetic-account-only'});
 let status=200,calls=0;
 try{globalThis.fetch=async(url,init)=>{calls++;assert.equal(url,'https://quota-fixture.invalid/tochat/quota');assert.equal(init.headers.authorization,'Bearer synthetic-account-only');assert.equal(init.redirect,'error');return status===200?Response.json({enabled:true,models:[{id:'gpt-6-sol',enabled:true}],remainingPercent:70}):new Response('synthetic-account-only',{status});};
 const response=await original(base+'/admin/tochat-quota');assert.equal(response.status,200);const body=await response.json();assert.equal(body.models[0].id,'gpt-6-sol');assert.ok(!JSON.stringify(body).includes('synthetic-account-only'));
 const foreign=await original(base+'/admin/tochat-quota',{headers:{origin:'https://untrusted.invalid'}});assert.equal(foreign.status,403);assert.equal(calls,1);
 status=401;const expired=await original(base+'/admin/tochat-quota');assert.equal(expired.status,401);assert.ok(!(await expired.text()).includes('synthetic-account-only'));
 setBuiltinAuth({authToken:''});assert.equal((await original(base+'/admin/tochat-quota')).status,503);
 }finally{globalThis.fetch=original;}
});
test('a quota response from the old account is discarded after auth changes',async()=>{
 let release,started;const pending=new Promise(r=>release=r),called=new Promise(r=>started=r);
 setBuiltinAuth({baseURL:'https://quota-fixture.invalid',authToken:'old-account'});
 try{globalThis.fetch=async()=>{started();await pending;return Response.json({models:[],remainingPercent:42});};
 const request=original(base+'/admin/tochat-quota');await called;setBuiltinAuth({baseURL:'https://quota-fixture.invalid',authToken:'new-account'});release();const result=await request;assert.equal(result.status,409);assert.ok(!(await result.text()).includes('42'));
 }finally{globalThis.fetch=original;}
});
