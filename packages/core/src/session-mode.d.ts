export type HistoryKind = 'chat' | 'work';
export interface HistoryConfig {application_mode?: string;task_mode?: string;model_source?: string;chat_model_config?: {credential_id?: string} | null}
export function sessionHistoryKind(config?: HistoryConfig | null): HistoryKind;
export function sessionModelSource(config?: HistoryConfig | null): 'official' | 'custom';
export function sessionForView<T extends {config: HistoryConfig}>(session:T,viewMode?:'tocode'|'tochat'):T;
