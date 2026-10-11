import {FileDiff,Globe,MessageSquarePlus,Plus,Settings2,SquareTerminal} from 'lucide-react';

import {useTranslation} from '@/i18n/useI18n';

type Props={recommendations:{url:string;title:string}[];onNavigate:(url:string)=>void;onNewTab:()=>void;onSettings:()=>void;onChat?:()=>void;onTool?:(key:'diff'|'terminal')=>void};
export function BrowserNewTab({recommendations,onNavigate,onNewTab,onSettings,onChat,onTool}:Props){
	const {t}=useTranslation();
	const tools=[
		...(onTool?[{icon:FileDiff,label:t('browserPanel.redesign.changes'),action:()=>onTool('diff')},{icon:SquareTerminal,label:t('browserPanel.redesign.terminal'),action:()=>onTool('terminal')}]:[]),
		...(onChat?[{icon:MessageSquarePlus,label:t('browserPanel.redesign.sideChat'),action:onChat}]:[]),
		{icon:Plus,label:t('browserPanel.newTab'),action:onNewTab},
		{icon:Settings2,label:t('common.settings'),action:onSettings},
	];
	return <div className="browser-start" data-testid="browser-new-tab-page">
		<section aria-labelledby="browser-start-tools"><h2 id="browser-start-tools">{t('browserPanel.redesign.tools')}</h2><div className="browser-start-tools">{tools.map(({icon:Icon,label,action})=><button key={label} type="button" className="browser-start-tool" onClick={action}><Icon aria-hidden="true"/><span>{label}</span></button>)}</div></section>
		<section aria-labelledby="browser-start-recommendations"><h2 id="browser-start-recommendations">{t('browserPanel.redesign.recommended')}</h2><div className="browser-start-sites">{recommendations.map(site=><button key={site.url} type="button" className="browser-start-site" title={site.url} onClick={()=>onNavigate(site.url)}><span className="browser-site-icon">{new URL(site.url).hostname==='ohfun.online'?<img src="/icon.png" alt="" draggable={false}/>:<Globe aria-hidden="true"/>}</span><span className="browser-site-title">{site.title||new URL(site.url).hostname}</span></button>)}</div></section>
	</div>;
}
