import type {PanelKey} from '@/components/panel/PanelDock';

/** Only local conversation routes can receive browser tool navigation. */
export function browserConversationPath(value:unknown):string|null {
	if(typeof value!=='string'||!/^\/(chat|tochat)\//.test(value)||/[\r\n]/.test(value))return null;
	const url=new URL(value,'https://tora.invalid');
	return url.origin==='https://tora.invalid'?url.pathname+url.search:null;
}

export function browserRecommendations(openTabs:{url:string;title:string}[],defaults:{url:string;title:string}[]) {
	const seen=new Set<string>();
	return [...openTabs,...defaults].filter(item=>{
		try {const url=new URL(item.url);if(!['https:','http:'].includes(url.protocol))return false;url.hash='';const key=url.href;if(seen.has(key))return false;seen.add(key);return true;}catch{return false;}
	}).slice(0,4);
}

let pending:{path:string;key:PanelKey;created:number}|null=null;
export function queueBrowserPanel(path:string,key:PanelKey){pending={path,key,created:Date.now()};}
export function takeBrowserPanel(path:string):PanelKey|null {
	if(!pending)return null;
	if(Date.now()-pending.created>5000){pending=null;return null;}
	if(pending.path!==path)return null;
	const key=pending.key;pending=null;return key;
}
