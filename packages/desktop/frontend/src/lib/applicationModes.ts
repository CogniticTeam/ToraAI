export type ApplicationMode = 'tochat' | 'tocode';
export type ToChatTask = 'chat' | 'work';
export type ToChatSource = 'official' | 'custom';
export const TOCHAT_SOURCE_KEY = 'tora_tochat_source';
export const TOCHAT_SOURCE_EVENT = 'tora:tochat-source-changed';

export function readToChatSource(): ToChatSource {
	return localStorage.getItem(TOCHAT_SOURCE_KEY) === 'custom' ? 'custom' : 'official';
}

const en = {
	mode: 'Application mode', chatDescription: 'Chat, explore and work', codeDescription: 'Build, debug and execute project tasks',
	chat: 'Chat', work: 'Work', ready: 'Ready when you are.', workReady: 'What shall we work on?',
	quota: 'Official model usage', quotaLoading: 'Loading usage…', quotaError: 'Usage unavailable',
	chatRemaining: '{{count}} messages left today', workRemaining: '{{count}}K tokens left today',
	chatLimit: 'Chat: {{count}} / 150 messages per day', dayLimit: 'Work: {{count}} / 1M tokens per day', weekLimit: 'Work: {{count}} / 10M tokens per week',
	reset: 'Resets at 00:00 Beijing time daily and every Monday. Input, output and reasoning tokens are counted without duplication.',
	customQuota: 'Custom model · no official quota', retry: 'Retry', source: 'ToChat model source',
	sourceHelp: 'Applies to new ToChat conversations. Existing conversations keep their model; custom models do not consume official quota.',
	official: 'Official DeepSeek Flash (default)', custom: 'Custom model', model: 'DeepSeek Flash',
	effort: 'Thinking effort', low: 'Low', high: 'High', max: 'Maximum', search: 'Web search',
	searchOn: 'Web search enabled', selectModel: 'Select a custom model first', syncError: 'Could not connect official model authentication',
	connectError: 'Official model unavailable. Your paid custom model will not be used automatically.',
	limitReached: 'Official quota reached. Wait for the reset or start a new conversation using a custom model.',
	imageError: 'Use a JPEG, PNG, GIF or WebP image under 32 MB.', missingSession: 'Conversation not found',
};
const zh: typeof en = {
	mode: '应用模式', chatDescription: '聊天、探索与工作', codeDescription: '构建、调试与执行项目任务',
	chat: '聊天', work: '工作', ready: '随时可以开始。', workReady: '我们要做什么？',
	quota: '官方模型额度', quotaLoading: '正在读取额度…', quotaError: '额度暂不可用',
	chatRemaining: '今日剩余 {{count}} 条', workRemaining: '今日剩余 {{count}} 千 Token',
	chatLimit: '聊天：{{count}} / 150 条（日）', dayLimit: '工作：{{count}} / 100 万 Token（日）', weekLimit: '工作：{{count}} / 1000 万 Token（周）',
	reset: '北京时间每日 00:00、每周一 00:00 重置。输入、输出与思考 Token 不重复计量。',
	customQuota: '自定义模型 · 不占官方额度', retry: '重试', source: 'ToChat 模型来源',
	sourceHelp: '新 ToChat 会话生效，已有会话保留原模型；自定义模型不占官方额度。',
	official: '官方 DeepSeek Flash（默认）', custom: '自定义模型', model: 'DeepSeek Flash',
	effort: '思考强度', low: '低', high: '高', max: '最大', search: '联网搜索',
	searchOn: '已开启联网搜索', selectModel: '请先选择自定义模型', syncError: '官方模型身份连接失败',
	connectError: '官方模型暂不可用，不会自动改用你的付费自定义模型。',
	limitReached: '官方额度已用完，请等待重置，或使用自定义模型开启新会话。',
	imageError: '支持 32 MB 以内的 JPEG、PNG、GIF、WebP 图片。', missingSession: '会话不存在',
};
const hant: typeof en = {
	...zh, mode: '應用模式', chatDescription: '聊天、探索與工作', codeDescription: '建構、偵錯與執行專案任務',
	chat: '聊天', work: '工作', ready: '隨時可以開始。', workReady: '我們要做什麼？',
	quota: '官方模型額度', quotaLoading: '正在讀取額度…', quotaError: '額度暫不可用',
	chatRemaining: '今日剩餘 {{count}} 則', workRemaining: '今日剩餘 {{count}} 千 Token',
	chatLimit: '聊天：{{count}} / 150 則（日）', dayLimit: '工作：{{count}} / 100 萬 Token（日）', weekLimit: '工作：{{count}} / 1000 萬 Token（週）',
	reset: '北京時間每日 00:00、每週一 00:00 重置。輸入、輸出與思考 Token 不重複計量。',
	customQuota: '自訂模型 · 不佔官方額度', source: 'ToChat 模型來源', sourceHelp: '新 ToChat 對話生效，已有對話保留原模型；自訂模型不佔官方額度。',
	custom: '自訂模型', effort: '思考強度', search: '連網搜尋', searchOn: '已開啟連網搜尋', selectModel: '請先選擇自訂模型', syncError: '官方模型身分連線失敗',
	connectError: '官方模型暫不可用，不會自動改用你的付費自訂模型。', limitReached: '官方額度已用完，請等待重置，或使用自訂模型開啟新對話。',
	imageError: '支援 32 MB 以內的 JPEG、PNG、GIF、WebP 圖片。', missingSession: '對話不存在',
};

export function modeCopy(language: string) {
	const copy = language === 'zh-Hant' ? hant : language.startsWith('zh') || language === 'lzh' ? zh : en;
	return (key: keyof typeof en, count?: number | string) => copy[key].replace('{{count}}', String(count ?? '—'));
}
