// Prices are monthly CNY. Credits are internal units; clients show percentages.
export const CREDIT_SCALE = 1000000;
export const WINDOWS = { fiveHour: 5*3600000, week: 7*86400000, month: 30*86400000 };
export const PLANS = Object.freeze([
 {id:'plus',name:'Tora Plus',price:70,usd:10,rank:1,afdianId:'a37febe4bfe511f18c5652540025c377',limits:{fiveHour:500,week:1600,month:7000}},
 {id:'pro',name:'Tora Pro',price:140,usd:20,rank:2,afdianId:'bcfa1d7ebfe511f1b2745254001e7c00',limits:{fiveHour:1000,week:3200,month:14000}},
 {id:'max5',name:'Tora Max 5x',price:700,usd:100,rank:3,afdianId:'a4ddfb38bfe611f1891a52540025c377',limits:{week:16000}},
 {id:'max20',name:'Tora Max 20x',price:1400,usd:200,rank:4,afdianId:'cebe7f2cbfe611f1bc135254001e7c00',limits:{week:64000}},
 {id:'ultra',name:'Tora Ultra',price:3500,usd:500,rank:5,afdianId:'1627986cbfe711f18b0552540025c377',limits:{week:100000}},
 {id:'ultrax',name:'Tora Ultra x',price:7000,usd:1000,rank:6,afdianId:'46ff5ad8bfe711f18e9e52540025c377',limits:{month:700000}},
]);
// Versioned service rates, not claims about OpenAI's internal prices.
export const CREDIT_RATES = Object.freeze({
 // New channel rates: ceil(CNY per 1M tokens × 400 service Credits/CNY).
 'claude-opus-5':{input:288,cached:29,output:1440},
 'gpt-6-sol':{input:68,cached:7,output:336,longInput:135,longCached:14,longOutput:504,threshold:272000},
 'gpt-6-luna':{input:135,cached:14,output:672,longInput:269,longCached:27,longOutput:1008,threshold:272000},
 'gpt-6-astra':{input:336,cached:34,output:1680,longInput:672,longCached:68,longOutput:2520,threshold:272000},
 'deepseek-flash':{input:300,cached:30,output:600},
 'gemini-3.8-flash':{input:1000,cached:100,output:6000},
 'gpt-6.1-sol':{input:1200,cached:60,output:6000,longInput:2400,longCached:120,longOutput:9000,threshold:272000},
});
export function modelRates(model,input=0,env={}) {
 let overrides={};try{overrides=JSON.parse(env.AGENT_CREDIT_RATES||'{}');}catch{throw Error('Invalid configured credit rates');}
 const rate=overrides[model]||CREDIT_RATES[model];if(!rate)throw Error('Unknown credit model');
 const result=rate.threshold&&input>rate.threshold?{input:rate.longInput,cached:rate.longCached,output:rate.longOutput}:rate;
 for(const key of ['input','cached','output'])if(!Number.isSafeInteger(result[key])||result[key]<=0)throw Error('Invalid configured credit rates');
 return {input:result.input,cached:result.cached,output:result.output};
}
export function usageTokens(usage) {
 const input=Number(usage?.prompt_tokens??usage?.input_tokens),output=Number(usage?.completion_tokens??usage?.output_tokens);
 if(!Number.isSafeInteger(input)||!Number.isSafeInteger(output)||input<0||output<0)return null;
 const cached=Math.min(input,Math.max(0,Number(usage?.prompt_cache_hit_tokens??usage?.prompt_tokens_details?.cached_tokens??usage?.input_tokens_details?.cached_tokens)||0));
 return {input,cached:Math.floor(cached),output}; // Output already includes reasoning; never count it twice.
}
export function usageCost(model,tokens,env={}){const rate=modelRates(model,tokens.input,env);return (tokens.input-tokens.cached)*rate.input+tokens.cached*rate.cached+tokens.output*rate.output;}
