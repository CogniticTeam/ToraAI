import {PLANS,CREDIT_SCALE,WINDOWS} from './subscription-plans.js';
import {readAgentQuota,publicQuota} from './agent-credits.js';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store','access-control-allow-origin':'*'}});
export async function afdianQuery(env,params,{fetcher=fetch,digest=data=>crypto.subtle.digest('MD5',data)}={}){
 if(!env.AFD_TOKEN||!env.AFD_USER_ID)throw Error('爱发电服务尚未配置');
 const encoded=JSON.stringify(params),ts=Math.floor(Date.now()/1000),bytes=new Uint8Array(await digest(new TextEncoder().encode(`${env.AFD_TOKEN}params${encoded}ts${ts}user_id${env.AFD_USER_ID}`))),sign=Array.from(bytes,v=>v.toString(16).padStart(2,'0')).join('');
 const response=await fetcher('https://afdian.com/api/open/query-order',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user_id:env.AFD_USER_ID,params:encoded,ts,sign}),signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('爱发电订单查询暂不可用');const data=await response.json();if(data.ec!==200||!Array.isArray(data.data?.list))throw Error('爱发电订单核验失败');return data.data.list;
}
export async function applyVerifiedOrder(db,order,now=Date.now()){
 if(order?.status!==2||!order.out_trade_no||!order.custom_order_id)return false;
 const intent=await db.prepare('SELECT * FROM subscription_checkout WHERE id=?').bind(order.custom_order_id).first();if(!intent)return false;
 if(intent.status==='paid')return true;
 const plan=PLANS.find(plan=>plan.id===intent.plan_id);if(!plan||plan.afdianId!==order.plan_id)return false;
 // Server-generated checkout binds the buyer to a Tora account. Never trust a username/remark.
 const units=order.product_type===1?(order.sku_detail||[]).reduce((n,item)=>n+Number(item.count||0),0):Number(order.month);
 const months=Math.floor(units||Number(order.month)||1);if(months<1||months>36||!Number.isFinite(Number(order.total_amount))||Number(order.total_amount)<=0)return false;
 if(Number(order.show_amount)<plan.price*months||Number(order.total_amount)<plan.price*months*0.8)return false;
 const previous=await db.prepare('SELECT * FROM user_subscription WHERE user_id=?').bind(intent.user_id).first();
 const current=previous&&previous.expires_at>now?PLANS.find(item=>item.id===previous.plan_id):null;
 if(current&&current.rank>plan.rank)throw Error('当前套餐有效期内不能降级，请联系客服处理此订单');
 // A paid renewal never erases the remaining days or resets rolling usage.
 const expires=(current?.id===plan.id?Math.max(now,previous.expires_at):now)+months*WINDOWS.month;
 const limit=key=>(plan.limits[key]||0)*CREDIT_SCALE;
 try{await db.batch([
  db.prepare('INSERT INTO subscription_orders(order_no,checkout_id,user_id,plan_id,months,amount,created_at) VALUES(?,?,?,?,?,?,?)').bind(order.out_trade_no,intent.id,intent.user_id,plan.id,months,String(order.total_amount),now),
  db.prepare('INSERT INTO user_subscription(user_id,plan_id,expires_at,five_hour_limit,week_limit,month_limit,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET plan_id=excluded.plan_id,expires_at=CASE WHEN user_subscription.plan_id=excluded.plan_id THEN MAX(user_subscription.expires_at,?)+? ELSE excluded.expires_at END,five_hour_limit=excluded.five_hour_limit,week_limit=excluded.week_limit,month_limit=excluded.month_limit,updated_at=excluded.updated_at').bind(intent.user_id,plan.id,expires,limit('fiveHour'),limit('week'),limit('month'),now,now,months*WINDOWS.month),
  db.prepare("UPDATE subscription_checkout SET status='paid',order_no=? WHERE id=? AND status='pending'").bind(order.out_trade_no,intent.id),
 ]);}catch(error){if(/UNIQUE/.test(String(error))){const applied=await db.prepare('SELECT user_id FROM subscription_orders WHERE order_no=?').bind(order.out_trade_no).first();return applied?.user_id===intent.user_id;}throw error;}
 return true;
}
export async function handleSubscriptions(request,env,ctx,user){
 const path=new URL(request.url).pathname;
 if(path==='/billing/afdian/webhook'){
  if(request.method!=='POST'||!env.AFD_WEBHOOK_KEY||new URL(request.url).searchParams.get('key')!==env.AFD_WEBHOOK_KEY)return json({ec:403},403);
  const raw=await request.text();if(raw.length>32768)return json({ec:413},413);let body;try{body=JSON.parse(raw);}catch{return json({ec:400},400);}
  const orderNo=body?.data?.order?.out_trade_no;if(typeof orderNo!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(orderNo))return json({ec:400},400);
  // Afdian does not document a webhook signature: re-query every notification.
  try{for(const order of await afdianQuery(env,{out_trade_no:orderNo}))await applyVerifiedOrder(env.DB,order);return json({ec:200,em:''});}catch{return json({ec:503,em:'retry'},503);}
 }
 if(!user)return json({detail:'请先登录'},401);if(user.banned)return json({detail:'账户已被封禁'},403);
 if(path==='/billing/subscription'&&request.method==='GET')return json({...publicQuota(await readAgentQuota(env.DB,user.id)),plans:PLANS.map(({id,name,price,usd,rank,limits})=>({id,name,price,usd,rank,windows:Object.keys(limits)})),extraPurchasesEnabled:false});
 if(path==='/billing/redeem'&&request.method==='POST'){
  let body;try{body=await request.json();}catch{return json({code:'invalid_order',detail:'订单号无效'},400);}
  const orderNo=String(body.orderNo||'').trim();if(!/^[0-9]{16,40}$/.test(orderNo))return json({code:'invalid_order',detail:'请输入完整爱发电订单号'},400);
  const redeemed=await env.DB.prepare('SELECT user_id FROM subscription_orders WHERE order_no=?').bind(orderNo).first();
  if(redeemed)return redeemed.user_id===user.id?json({redeemed:true,alreadyRedeemed:true,...publicQuota(await readAgentQuota(env.DB,user.id))}):json({code:'already_redeemed',detail:'此订单已兑换'},409);
  const now=Date.now();const attempt=await env.DB.prepare('INSERT INTO subscription_redemption_attempt(user_id,created_at) SELECT ?,? WHERE (SELECT COUNT(*) FROM subscription_redemption_attempt WHERE user_id=? AND created_at>?)<5').bind(user.id,now,user.id,now-3600000).run();if(!attempt.meta.changes)return json({code:'too_many_attempts',detail:'兑换尝试过多，请稍后重试'},429);
  try{
   const order=(await afdianQuery(env,{out_trade_no:orderNo})).find(item=>item.out_trade_no===orderNo);
   if(!order||!PLANS.some(plan=>plan.afdianId===order.plan_id)||order.status!==2)return json({code:'invalid_order',detail:'未找到可兑换的订阅订单'},400);
   if(order.custom_order_id){const intent=await env.DB.prepare('SELECT user_id FROM subscription_checkout WHERE id=?').bind(order.custom_order_id).first();if(!intent||intent.user_id!==user.id)return json({code:'wrong_account',detail:'此订单绑定了另一个账号'},409);}
   else{
    const plan=PLANS.find(item=>item.afdianId===order.plan_id),id='redeem_'+orderNo;
    await env.DB.prepare('INSERT INTO subscription_checkout(id,user_id,plan_id,created_at,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(id,user.id,plan.id,now,now+86400000).run();
    const intent=await env.DB.prepare('SELECT user_id FROM subscription_checkout WHERE id=?').bind(id).first();if(intent.user_id!==user.id)return json({code:'already_redeemed',detail:'此订单已兑换'},409);order.custom_order_id=id;
   }
   if(!await applyVerifiedOrder(env.DB,order))return json({code:'invalid_order',detail:'此订单暂不能兑换，请核对商品和付款金额'},400);
   return json({redeemed:true,...publicQuota(await readAgentQuota(env.DB,user.id))});
  }catch{return json({code:'unavailable',detail:'订单核验暂不可用，请稍后重试'},502);}
 }
 if(path==='/billing/checkout'&&request.method==='POST'){
  let body;try{body=await request.json();}catch{return json({detail:'无效请求'},400);}
  const plan=PLANS.find(item=>item.id===body.planId);if(!plan)return json({detail:'未知订阅方案'},400);
  const quota=await readAgentQuota(env.DB,user.id);const active=PLANS.find(item=>item.id===quota.subscription?.planId);if(active&&active.rank>plan.rank)return json({detail:'请在当前订阅到期后再选择较低档位'},409);
  const now=Date.now(),count=await env.DB.prepare("SELECT COUNT(*) AS n FROM subscription_checkout WHERE user_id=? AND created_at>? AND status='pending'").bind(user.id,now-3600000).first();if(count.n>=10)return json({detail:'待支付订单较多，请稍后再试'},429);
  const id='tora_'+crypto.randomUUID().replaceAll('-','');await env.DB.prepare('INSERT INTO subscription_checkout(id,user_id,plan_id,created_at,expires_at) VALUES(?,?,?,?,?)').bind(id,user.id,plan.id,now,now+86400000).run();
  const url=new URL('https://afdian.com/item/'+plan.afdianId);return json({id,url:url.toString(),requiresRedemption:true});
 }
 if(path==='/billing/sync'&&request.method==='POST'){
  let body;try{body=await request.json();}catch{return json({detail:'无效请求'},400);}
  const checkout=await env.DB.prepare('SELECT * FROM subscription_checkout WHERE id=? AND user_id=?').bind(String(body.checkoutId||''),user.id).first();if(!checkout)return json({detail:'订单不存在'},404);
  if(checkout.status==='paid')return json({paid:true,...publicQuota(await readAgentQuota(env.DB,user.id))});
  if(checkout.expires_at<Date.now())return json({detail:'支付链接已过期，请重新创建'},410);
  const claimed=await env.DB.prepare('UPDATE subscription_checkout SET next_poll_at=? WHERE id=? AND next_poll_at<=?').bind(Date.now()+30000,checkout.id,Date.now()).run();if(!claimed.meta.changes)return json({paid:false,retryAfter:30});
  try{const orders=await afdianQuery(env,{page:1});for(const order of orders)if(order.custom_order_id===checkout.id)await applyVerifiedOrder(env.DB,order);const result=await env.DB.prepare('SELECT status FROM subscription_checkout WHERE id=?').bind(checkout.id).first();return json({paid:result.status==='paid',...publicQuota(await readAgentQuota(env.DB,user.id))});}catch{return json({detail:'暂时无法核验支付，请稍后刷新'},502);}
 }
 return json({detail:'Not Found'},404);
}
