import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handlePasskeys,encodeBytes,decodeBytes} from '../src/passkeys.js';
import {handleAuthEmail} from '../src/auth-email-flows.js';
import {digest} from '../src/auth-security.js';

function database(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec('CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE,username TEXT UNIQUE,salt TEXT,hash TEXT,created_at TEXT,avatar TEXT);CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id INTEGER,expires_at INTEGER);');
 sqlite.exec(readFileSync(new URL('../migrations/0013_auth_passkeys.sql',import.meta.url),'utf8'));
 sqlite.prepare("INSERT INTO users(id,email,username,salt,hash,created_at) VALUES(1,'one@fixture.invalid','one','salt','hash','2026-10-11'),(2,'two@fixture.invalid','two','salt','hash','2026-10-11')").run();
 const DB={prepare(sql){const statement=args=>({bind:(...values)=>statement(values),first:async()=>sqlite.prepare(sql).get(...args)||null,all:async()=>({results:sqlite.prepare(sql).all(...args)}),run:async()=>{const result=sqlite.prepare(sql).run(...args);return {meta:{last_row_id:Number(result.lastInsertRowid),changes:result.changes}};}});return statement([]);},exec:async sql=>sqlite.exec(sql),batch:async statements=>{sqlite.exec('BEGIN');try{const result=[];for(const item of statements)result.push(await item.run());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 return {sqlite,DB};
}
const request=(path,body,token='')=>new Request('https://tora.ohfun.online'+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
const helpers={userFromRequest:async(_db,req)=>{const id=Number(req.headers.get('authorization')?.split(' ').at(-1));return id?[{},{id:1,email:'one@fixture.invalid'},{id:2,email:'two@fixture.invalid'}][id]:null;},checkPassword:async(id,password)=>password===`correct-${id}`,createSession:async(_db,id)=>`session_${id}`};
const invoke=(env,path,body,token)=>handlePasskeys(request(path,body,token),env,new URL('https://tora.ohfun.online'+path),helpers);
const concat=(...values)=>Uint8Array.from(values.flatMap(value=>Array.from(value)));
const u32=value=>new Uint8Array([value>>>24,(value>>>16)&255,(value>>>8)&255,value&255]);
// Independent fixture encoder: just the CBOR values used by an attestation-none authenticator.
function cbor(value){
 const head=(type,length)=>length<24?Uint8Array.of(type*32+length):length<256?Uint8Array.of(type*32+24,length):Uint8Array.of(type*32+25,length>>>8,length&255);
 if(typeof value==='number')return head(value<0?1:0,value<0?-1-value:value);
 if(typeof value==='string'){const bytes=new TextEncoder().encode(value);return concat(head(3,bytes.length),bytes);}
 if(value instanceof Uint8Array)return concat(head(2,value.length),value);
 if(value instanceof Map)return concat(head(5,value.size),...Array.from(value).flatMap(([key,item])=>[cbor(key),cbor(item)]));
 throw Error('Unsupported fixture CBOR value');
}
const clientData=(type,challenge,origin='https://tora.ohfun.online')=>new TextEncoder().encode(JSON.stringify({type,challenge,origin,crossOrigin:false}));
async function authenticator(){
 const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const jwk=await crypto.subtle.exportKey('jwk',pair.publicKey),id=crypto.getRandomValues(new Uint8Array(32));
 const publicKey=cbor(new Map([[1,2],[3,-7],[-1,1],[-2,decodeBytes(jwk.x)],[-3,decodeBytes(jwk.y)]]));
 const rpHash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('ohfun.online')));
 const registration=options=>{
  const authData=concat(rpHash,Uint8Array.of(0x45),u32(0),new Uint8Array(16),Uint8Array.of(0,id.length),id,publicKey);
  return{id:encodeBytes(id),rawId:encodeBytes(id),type:'public-key',clientExtensionResults:{},response:{clientDataJSON:encodeBytes(clientData('webauthn.create',options.challenge)),attestationObject:encodeBytes(cbor(new Map([['fmt','none'],['attStmt',new Map()],['authData',authData]]))),transports:['internal']}};
 };
 const der=raw=>{const integer=part=>{while(part.length>1&&part[0]===0)part=part.slice(1);if(part[0]&128)part=concat(Uint8Array.of(0),part);return concat(Uint8Array.of(2,part.length),part);};const bytes=concat(integer(raw.slice(0,32)),integer(raw.slice(32)));return concat(Uint8Array.of(0x30,bytes.length),bytes);};
 const authentication=async(options,handle,counter=1,{origin='https://tora.ohfun.online',uv=true,tamper=false}={})=>{
  const data=clientData('webauthn.get',options.challenge,origin),authData=concat(rpHash,Uint8Array.of(uv?5:1),u32(counter));
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',data));const signature=der(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,concat(authData,digest))));if(tamper)signature[signature.length-1]^=1;
  return{id:encodeBytes(id),rawId:encodeBytes(id),type:'public-key',clientExtensionResults:{},response:{clientDataJSON:encodeBytes(data),authenticatorData:encodeBytes(authData),signature:encodeBytes(signature),userHandle:handle}};
 };
 return {registration,authentication,id:encodeBytes(id)};
}

test('Passkey enrollment and signed login are owner-bound, verified, single-use and never return tokens to the browser',async t=>{
 const{sqlite,DB}=database();t.after(()=>sqlite.close());const env={DB};const key=await authenticator();
 const start=await invoke(env,'/auth/passkeys/start',{purpose:'register',password:'correct-1',label:'My device'},'1');assert.equal(start.status,200);const register=await start.json();
 const browserURL=new URL(register.url);assert.equal(browserURL.search,'');assert.ok(browserURL.hash.includes(register.id));assert.ok(!register.url.includes(register.pollSecret));
 const options=await(await invoke(env,'/auth/passkeys/options',{flow:register.id})).json();assert.equal(options.options.authenticatorSelection.userVerification,'required');
 const response=key.registration(options.options);const verified=await invoke(env,'/auth/passkeys/verify',{flow:register.id,id:options.id,response});assert.deepEqual(await verified.json(),{verified:true});
 assert.equal((await invoke(env,'/auth/passkeys/verify',{flow:register.id,id:options.id,response})).status,410);
 const login=await(await invoke(env,'/auth/passkeys/start',{purpose:'login',account:'one@fixture.invalid'})).json();const challenge=await(await invoke(env,'/auth/passkeys/options',{flow:login.id})).json();
 const handle=sqlite.prepare('SELECT handle FROM passkey_users WHERE user_id=1').get().handle;
 assert.equal((await invoke(env,'/auth/passkeys/verify',{flow:login.id,id:challenge.id,response:await key.authentication(challenge.options,handle)})).status,200);
 assert.equal((await invoke(env,'/auth/passkeys/poll',{id:login.id,pollSecret:'a'.repeat(64)})).status,410);
 const poll=await(await invoke(env,'/auth/passkeys/poll',{id:login.id,pollSecret:login.pollSecret})).json();assert.equal(poll.token,'session_1');assert.equal(poll.email,'one@fixture.invalid');
 assert.deepEqual(await(await invoke(env,'/auth/passkeys/poll',{id:login.id,pollSecret:login.pollSecret})).json(),{status:'consumed'});
 assert.equal(sqlite.prepare('SELECT result FROM passkey_handoffs WHERE id=?').get(login.id).result,null);assert.equal(sqlite.prepare('SELECT counter FROM passkeys WHERE id=?').get(key.id).counter,1);
 const repeat=await(await invoke(env,'/auth/passkeys/start',{purpose:'login',account:'one@fixture.invalid'})).json();const repeatChallenge=await(await invoke(env,'/auth/passkeys/options',{flow:repeat.id})).json();
 assert.equal((await invoke(env,'/auth/passkeys/verify',{flow:repeat.id,id:repeatChallenge.id,response:await key.authentication(repeatChallenge.options,handle,1)})).status,400); // Cloned/reused nonzero counter.
 const next=await(await invoke(env,'/auth/passkeys/start',{purpose:'login',account:'one@fixture.invalid'})).json();const nextChallenge=await(await invoke(env,'/auth/passkeys/options',{flow:next.id})).json();
 assert.equal((await invoke(env,'/auth/passkeys/verify',{flow:next.id,id:nextChallenge.id,response:await key.authentication(nextChallenge.options,null,2)})).status,200); // An identified account need not return userHandle.
 const concurrent=await Promise.all(Array.from({length:3},async()=> (await invoke(env,'/auth/passkeys/poll',{id:next.id,pollSecret:next.pollSecret})).json()));assert.equal(concurrent.filter(result=>result.token).length,1);

});

test('Passkeys reject bad signatures, wrong origin, missing UV, account mismatch, expired challenges and canceled flows',async t=>{
 const{sqlite,DB}=database();t.after(()=>sqlite.close());const env={DB},key=await authenticator();const register=await(await invoke(env,'/auth/passkeys/start',{purpose:'register',password:'correct-1'},'1')).json();const options=await(await invoke(env,'/auth/passkeys/options',{flow:register.id})).json();await invoke(env,'/auth/passkeys/verify',{flow:register.id,id:options.id,response:key.registration(options.options)});const handle=sqlite.prepare('SELECT handle FROM passkey_users WHERE user_id=1').get().handle;
 for(const variant of [{tamper:true},{origin:'https://attacker.invalid'},{uv:false},{account:'two@fixture.invalid'}]){
  const flow=await(await invoke(env,'/auth/passkeys/start',{purpose:'login',account:variant.account||'one@fixture.invalid'})).json();const challenge=await(await invoke(env,'/auth/passkeys/options',{flow:flow.id})).json();
  const response=await key.authentication(challenge.options,handle,1,variant);const result=await invoke(env,'/auth/passkeys/verify',{flow:flow.id,id:challenge.id,response});assert.equal(result.status,400,JSON.stringify(variant));
  assert.equal((await invoke(env,'/auth/passkeys/verify',{flow:flow.id,id:challenge.id,response})).status,400); // Failed challenges are consumed too.
 }
 const canceled=await(await invoke(env,'/auth/passkeys/start',{purpose:'login'})).json();await invoke(env,'/auth/passkeys/cancel',{id:canceled.id,pollSecret:canceled.pollSecret});assert.equal((await invoke(env,'/auth/passkeys/options',{flow:canceled.id})).status,410);
 const expired=await(await invoke(env,'/auth/passkeys/start',{purpose:'login'})).json();const challenge=await(await invoke(env,'/auth/passkeys/options',{flow:expired.id})).json();sqlite.prepare('UPDATE passkey_challenges SET expires_at=0 WHERE id=?').run(challenge.id);assert.equal((await invoke(env,'/auth/passkeys/verify',{flow:expired.id,id:challenge.id,response:await key.authentication(challenge.options,handle)})).status,400);
 assert.equal((await invoke(env,'/auth/passkeys/start',{purpose:'register',password:'wrong'},'1')).status,403);
 const removeReq=new Request('https://tora.ohfun.online/account/passkeys/'+key.id,{method:'DELETE',headers:{authorization:'Bearer 2'},body:JSON.stringify({password:'correct-2'})});assert.equal((await handlePasskeys(removeReq,env,new URL(removeReq.url),helpers)).status,404);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM passkeys').get().n,1);
});

test('Email code purposes are isolated, replay/guessing are rejected and password reset revokes existing sessions',async t=>{
 const{sqlite,DB}=database();t.after(()=>sqlite.close());const env={DB};const email='one@fixture.invalid';
 const add=async(purpose,code='123456')=>sqlite.prepare('INSERT OR REPLACE INTO auth_email_codes(email,user_id,purpose,code_hash,expires_at,sent_at) VALUES(?,1,?,?,?,?)').run(email,purpose,await digest(`${purpose}:${email}:${code}`),Date.now()+60000,Date.now());
 const service={makeSalt:async()=> 'new-salt',hashPassword:async password=>'hashed:'+password,createSession:async(db,id)=>{await db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').bind('new-session',id,Date.now()+60000).run();return 'new-session';},sendWelcomeEmail:async()=>{}};
 const call=(path,body)=>handleAuthEmail(request(path,body),env,path,service);
 await add('signup');assert.equal((await call('/auth/email-login',{email,code:'123456'})).status,400); // Registration proof never signs in an existing account.
 await add('login');assert.equal((await call('/auth/email-login',{email:email.toUpperCase(),code:'123456'})).status,200);assert.equal((await call('/auth/email-login',{email,code:'123456'})).status,400);
 await add('login');for(let i=0;i<5;i++)assert.equal((await call('/auth/email-login',{email,code:'000000'})).status,400);assert.equal((await call('/auth/email-login',{email,code:'123456'})).status,400);
 await add('reset');const proof=await(await call('/auth/reset-verify',{email,code:'123456'})).json();assert.ok(proof.resetToken);assert.equal((await call('/auth/reset-password',{email,password:'new-password',resetToken:proof.resetToken})).status,200);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);assert.equal(sqlite.prepare('SELECT hash FROM users WHERE id=1').get().hash,'hashed:new-password');assert.equal((await call('/auth/reset-password',{email,password:'another-password',resetToken:proof.resetToken})).status,400);
});


test('An email code is bound to the original account even if the address moves to another user',async t=>{
 const{sqlite,DB}=database();t.after(()=>sqlite.close());const email='one@fixture.invalid';
 sqlite.prepare('INSERT INTO auth_email_codes(email,user_id,purpose,code_hash,expires_at,sent_at) VALUES(?,1,?,?,?,?)').run(email,'login',await digest(`login:${email}:123456`),Date.now()+60000,Date.now());
 sqlite.prepare("UPDATE users SET email='changed@fixture.invalid' WHERE id=1").run();sqlite.prepare('UPDATE users SET email=? WHERE id=2').run(email);
 const result=await handleAuthEmail(request('/auth/email-login',{email,code:'123456'}),{DB},'/auth/email-login',{createSession:()=>{throw Error('Must never create a session for the new owner');}});
 assert.equal(result.status,400);
});

test('Email dispatch requires human verification, stores only a hash, enforces cooldown, and recovers a failed sender',async t=>{
 const{sqlite,DB}=database();t.after(()=>sqlite.close());const original=globalThis.fetch;let sends=0,succeed=true;
 globalThis.fetch=async url=>{assert.equal(url,'https://api.resend.com/emails');sends++;return new Response('{}',{status:succeed?200:502});};t.after(()=>globalThis.fetch=original);
 const body={email:'one@fixture.invalid',purpose:'login'};
 const locked=await handleAuthEmail(request('/auth/email-code',body),{DB,RESEND_API_KEY:'fixture-not-a-secret'},'/auth/email-code',{});assert.equal(locked.status,403);assert.equal(sends,0);
 const env={DB,RESEND_API_KEY:'fixture-not-a-secret',TURNSTILE_DEV_BYPASS:'1'};
 const send=()=>handleAuthEmail(request('/auth/email-code',body),env,'/auth/email-code',{});
 assert.equal((await send()).status,200);const row=sqlite.prepare('SELECT * FROM auth_email_codes').get();assert.equal(row.user_id,1);assert.match(row.code_hash,/^[0-9a-f]{64}$/);assert.equal(sends,1);
 assert.equal((await send()).status,429);assert.equal(sends,1);
 sqlite.prepare('UPDATE auth_email_codes SET sent_at=0').run();succeed=false;assert.equal((await send()).status,502);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM auth_email_codes').get().n,0);
 succeed=true;assert.equal((await send()).status,200);assert.equal(sends,3);
});

test('Worker schema startup works with D1 exec newline semantics, including a pre-existing account database',async t=>{
 const{sqlite,DB}=database();t.after(()=>sqlite.close());
 DB.exec=async sql=>{for(const line of sql.split('\n'))if(line.trim()&&!line.trim().startsWith('--'))sqlite.exec(line);};
 const{registerHooks}=await import('node:module');
 const hook=registerHooks({load(url,context,next){if(/\.(html|sql)$/.test(url))return{format:'module',shortCircuit:true,source:`export default ${JSON.stringify(readFileSync(new URL(url),'utf8'))}`};return next(url,context);}});t.after(()=>hook.deregister());
 const{default:worker}=await import('../src/index.js');
 const response=await worker.fetch(new Request('https://fixture.invalid/health'),{DB},{waitUntil(){}});assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).status,'ok');
});
