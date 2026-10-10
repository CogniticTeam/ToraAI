import {isBuiltinCredential} from './builtin-models.js';

/** Legacy/code sessions belong to work; ordinary ToChat stays isolated. */
export const sessionHistoryKind = config => config?.application_mode==='tochat'&&config?.task_mode!=='work'?'chat':'work';
export function sessionModelSource(config) {
 const credential=config?.chat_model_config?.credential_id;
 if(credential)return isBuiltinCredential(credential)?'official':'custom';
 return config?.model_source==='custom'?'custom':config?.model_source==='official'||config?.application_mode==='tochat'?'official':'custom';
}
/** Switch only the execution view, never the stored session/history identity. */
export function sessionForView(session,viewMode) {
 if(viewMode===undefined)return session;
 if(!['tocode','tochat'].includes(viewMode))throw Error('无效的应用视图');
 const kind=sessionHistoryKind(session.config);
 if(kind==='chat'&&viewMode==='tocode')throw Error('聊天对话不能用于 ToCode，请新建工作对话');
 return {...session,config:{...session.config,application_mode:viewMode,task_mode:kind,model_source:sessionModelSource(session.config)}};
}
