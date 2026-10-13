export const authJSON=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','access-control-allow-origin':'*','cache-control':'no-store'}});
export const authError=(code,detail,status=400)=>authJSON({code,detail},status);
export const randomToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),value=>value.toString(16).padStart(2,'0')).join('');
export async function digest(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');}
export async function readAuthBody(request){
 const text=await request.text();if(new TextEncoder().encode(text).length>32768)throw new Error('AUTH_BODY_TOO_LARGE');
 try{return JSON.parse(text);}catch{return{};}
}
/** Atomic fixed window limit, keyed only by hashed account/IP identifiers. */
export async function authLimit(db,key,total=20,span=3600000){
 const now=Date.now(),window=Math.floor(now/span)*span,id=await digest(key);
 const row=await db.prepare('INSERT INTO auth_flow_limits(id,window,total) VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET window=excluded.window,total=CASE WHEN auth_flow_limits.window=excluded.window THEN auth_flow_limits.total+1 ELSE 1 END RETURNING total').bind(id,window).first();
 return Number(row?.total)<=total;
}
export async function consumeEmailCode(db,email,purpose,code){
 const hash=await digest(`${purpose}:${email}:${String(code).trim()}`);
 const row=await db.prepare('DELETE FROM auth_email_codes WHERE email=? AND purpose=? AND code_hash=? AND expires_at>? AND attempts<5 RETURNING email,user_id').bind(email,purpose,hash,Date.now()).first();
 if(row)return row;
 await db.prepare('UPDATE auth_email_codes SET attempts=attempts+1 WHERE email=? AND purpose=?').bind(email,purpose).run();
 return false;
}
