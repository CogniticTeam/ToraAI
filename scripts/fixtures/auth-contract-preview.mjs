import {createServer} from 'node:http';
import {mkdtempSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pbkdf2Sync} from 'node:crypto';
import {registerHooks} from 'node:module';

const port=Number(process.argv[2]||3410),cloudPort=Number(process.argv[3]||3411);
process.env.TORA_HOME=mkdtempSync(join(process.env.TMPDIR,'tora-auth-contract-preview-'));
registerHooks({load(url,context,next){
  if(/\.(html|sql)$/.test(url))return{format:'module',shortCircuit:true,source:`export default ${JSON.stringify(readFileSync(new URL(url),'utf8'))}`};
  return next(url,context);
}});
const sqlite=new DatabaseSync(':memory:');
const DB={
  prepare(sql){
    const statement=args=>({bind:(...values)=>statement(values),first:async()=>sqlite.prepare(sql).get(...args)||null,
      all:async()=>({results:sqlite.prepare(sql).all(...args)}),run:async()=>{const result=sqlite.prepare(sql).run(...args);return{meta:{last_row_id:Number(result.lastInsertRowid),changes:result.changes}};}});
    return statement([]);
  },
  exec:async sql=>sqlite.exec(sql),
  batch:async statements=>{sqlite.exec('BEGIN');try{const values=[];for(const item of statements)values.push(await item.run());sqlite.exec('COMMIT');return values;}catch(error){sqlite.exec('ROLLBACK');throw error;}}
};
const mailbox=new Map(),realFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input.url);
  if(url.hostname==='api.resend.com'){
    const message=JSON.parse(init.body),destination=Array.isArray(message.to)?message.to[0]:message.to;
    const text=String(message.text||message.html||'');
    const code=text.match(/\b\d{6}\b/)?.[0];
    if(code)mailbox.set(destination,code);
    return Response.json({id:'local-fixture-mail'});
  }
  if(url.hostname==='challenges.cloudflare.com')return Response.json({success:false,'error-codes':['fixture-proof-required']});
  if(['127.0.0.1','localhost'].includes(url.hostname))return realFetch(input,init);
  throw Error('External requests are disabled in the local authentication fixture');
};
const{default:worker}=await import('../../packages/auth-worker/src/index.js');
const env={DB,TOCHAT_ENABLED:'0',RESEND_API_KEY:'local-fixture-key',TURNSTILE_SECRET:'local-fixture-secret',TURNSTILE_HOSTNAMES:'127.0.0.1'};
const ctx={waitUntil(promise){void promise.catch(()=>{});}};
const origin=`http://127.0.0.1:${cloudPort}`;
const health=await worker.fetch(new Request(origin+'/health'),env,ctx);
if(!health.ok)throw Error('Authentication fixture schema initialization failed');
const salt='0102030405060708090a0b0c0d0e0f10';
const hash=pbkdf2Sync('preview-password',Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex');
sqlite.prepare('INSERT INTO users(email,username,salt,hash,created_at) VALUES(?,?,?,?,?)')
  .run('preview@fixture.invalid','preview',salt,hash,new Date().toISOString());

createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin);
    if(url.pathname==='/fixture/mailbox'){
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store','access-control-allow-origin':'*'});
      res.end(JSON.stringify({code:mailbox.get(url.searchParams.get('email'))||null}));
      return;
    }
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=Buffer.concat(chunks);
    const headers=new Headers(req.headers);headers.set('cf-connecting-ip','127.0.0.1');
    const request=new Request(url,{method:req.method,headers,...(body.length?{body}:{}),...(body.length?{duplex:'half'}:{})});
    const response=await worker.fetch(request,env,ctx);
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }catch{
    res.writeHead(500,{'content-type':'application/json','access-control-allow-origin':'*'});
    res.end(JSON.stringify({detail:'Local authentication fixture failed'}));
  }
}).listen(cloudPort,'127.0.0.1');
const{startASAPIServer}=await import('../../packages/core/src/asapi/server.js');
await startASAPIServer({port});
console.log(`Local authentication contract preview: http://127.0.0.1:${port}; API: ${origin}`);
