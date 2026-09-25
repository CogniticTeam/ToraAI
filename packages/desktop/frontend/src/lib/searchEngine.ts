export type SearchEngineId =
	| 'baidu'
	| 'google'
	| '360'
	| 'sogou'
	| 'yahoo'
	| 'duckduckgo'
	| 'ecosia'
	| 'bing';

export const SEARCH_ENGINE_STORAGE_KEY = 'cocode_search_engine';

export const SEARCH_ENGINES: ReadonlyArray<{
	id: SearchEngineId;
	homeUrl: string;
	searchUrl: string;
}> = [
	{ id: 'baidu', homeUrl: 'https://www.baidu.com/', searchUrl: 'https://www.baidu.com/s?wd=' },
	{ id: 'google', homeUrl: 'https://www.google.com/', searchUrl: 'https://www.google.com/search?q=' },
	{ id: '360', homeUrl: 'https://www.so.com/', searchUrl: 'https://www.so.com/s?q=' },
	{ id: 'sogou', homeUrl: 'https://www.sogou.com/', searchUrl: 'https://www.sogou.com/web?query=' },
	{ id: 'yahoo', homeUrl: 'https://search.yahoo.com/', searchUrl: 'https://search.yahoo.com/search?p=' },
	{ id: 'duckduckgo', homeUrl: 'https://duckduckgo.com/', searchUrl: 'https://duckduckgo.com/?q=' },
	{ id: 'ecosia', homeUrl: 'https://www.ecosia.org/', searchUrl: 'https://www.ecosia.org/search?q=' },
	{ id: 'bing', homeUrl: 'https://www.bing.com/', searchUrl: 'https://www.bing.com/search?q=' },
];

export const DEFAULT_SEARCH_ENGINE: SearchEngineId = 'baidu';

export function isSearchEngineId(value: string): value is SearchEngineId {
	return SEARCH_ENGINES.some((engine) => engine.id === value);
}

export function getSearchEngine(): SearchEngineId {
	if (typeof window === 'undefined') return DEFAULT_SEARCH_ENGINE;
	const saved = window.localStorage.getItem(SEARCH_ENGINE_STORAGE_KEY);
	return saved && isSearchEngineId(saved) ? saved : DEFAULT_SEARCH_ENGINE;
}

export function saveSearchEngine(engine: SearchEngineId): void {
	if (typeof window === 'undefined') return;
	window.localStorage.setItem(SEARCH_ENGINE_STORAGE_KEY, engine);
}

export function getSearchEngineHomeUrl(engineId = getSearchEngine()): string {
	return SEARCH_ENGINES.find((engine) => engine.id === engineId)?.homeUrl
		?? 'https://www.baidu.com/';
}

/** 判断没有协议的输入是否足够像网址，避免把普通单词误当成域名。 */
function looksLikeUrl(input: string): boolean {
	if (/\s|@/.test(input)) return false;
	if (/^localhost(?::\d+)?(?:[/?#].*)?$/i.test(input)) return true;
	if (/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#].*)?$/.test(input)) return true;
	if (/^\[[0-9a-f:]+\](?::\d+)?(?:[/?#].*)?$/i.test(input)) return true;

	const host = input.split(/[/?#]/, 1)[0].replace(/:\d+$/, '');
	return host.includes('.') && !host.startsWith('.') && !host.endsWith('.');
}

/** 工具或内部调用传入明确网址时补全协议，不把内容转换为搜索。 */
export function normalizeUrl(input: string): string {
	const value = input.trim();
	if (!value) return '';
	if (value.startsWith('//')) return `https:${value}`;
	if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:[/?#].*)?$/i.test(value)) {
		return `http://${value}`;
	}
	if (looksLikeUrl(value)) return `https://${value}`;
	if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
	return `https://${value}`;
}

/** 地址栏输入：网址直接打开，普通文本使用当前搜索引擎检索。 */
export function resolveAddressInput(input: string, engineId = getSearchEngine()): string {
	const value = input.trim();
	if (!value) return '';
	if (value.startsWith('//') || looksLikeUrl(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
		return normalizeUrl(value);
	}
	const engine = SEARCH_ENGINES.find((item) => item.id === engineId)
		?? SEARCH_ENGINES.find((item) => item.id === DEFAULT_SEARCH_ENGINE);
	return `${engine?.searchUrl ?? 'https://www.baidu.com/s?wd='}${encodeURIComponent(value)}`;
}
