import { useSyncExternalStore } from 'react';

export const CATGIRL_PACK_KEY = 'tora_catgirl_language_pack';
type CatgirlSettings = { installed: boolean; enabled: boolean };
let settings: CatgirlSettings = {
	installed: typeof localStorage !== 'undefined' && localStorage.getItem(CATGIRL_PACK_KEY) === '1',
	enabled: false,
};
let revision = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const isCatgirlPackInstalled = () => settings.installed;
export const useCatgirlSettings = () => useSyncExternalStore(subscribe, () => settings);

function publish(next: CatgirlSettings) {
	settings = next;
	localStorage.setItem(CATGIRL_PACK_KEY, next.installed ? '1' : '0');
	listeners.forEach(listener => listener());
}

async function request(patch?: { install?: boolean; enabled?: boolean }): Promise<CatgirlSettings> {
	const base = (localStorage.getItem('server_url') || (/^https?:$/.test(location.protocol) ? location.origin : 'http://127.0.0.1:3210')).replace(/\/+$/, '');
	const response = await fetch(`${base}/admin/catgirl`, {
		method: patch ? 'POST' : 'GET',
		...(patch ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) } : {}),
		signal: AbortSignal.timeout(10000),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const next = await response.json();
	if (typeof next.installed !== 'boolean' || typeof next.enabled !== 'boolean') throw new Error('Invalid catgirl settings');
	return next;
}

export async function refreshCatgirlSettings() {
	const at = revision;
	const next = await request();
	if (revision === at) publish(next);
}

export async function updateCatgirlSettings(patch: { install?: boolean; enabled?: boolean }) {
	const at = ++revision;
	const next = await request(patch);
	if (revision === at) publish(next);
}

export function catgirlTrigger(value: string, language: string): 'zh' | 'ja' | null {
	const base = language.toLowerCase();
	const text = value.trim();
	if ((base === 'zh' || base.startsWith('zh-') || base === 'lzh') && ['喵喵喵', '猫娘语'].includes(text)) return 'zh';
	if ((base === 'ja' || base.startsWith('ja-')) && ['にゃにゃにゃ', '猫娘語'].includes(text)) return 'ja';
	return null;
}

const chinese = {
	title: '是否添加猫娘语言包？',
	description: '添加「猫娘语（中文）」和「猫娘語（日本語）」，让界面换上猫娘语气喵。添加后可在设置 → 智能体中开启「猫娘人格」。',
	add: '添加语言包', cancel: '暂时不要', busy: '正在添加…', error: '添加失败，请重试。',
	persona: '猫娘人格', personaDesc: '开启后，所有智能体从下一轮回复起使用猫娘语气；切换界面语言不会关闭人格。',
	loadError: '无法读取猫娘人格设置，请重试。', saveError: '保存失败，请重试。', retry: '重试',
	disable: '停用猫娘语言包', disabling: '正在停用…', disableError: '停用失败，请重试。',
};
const japanese: typeof chinese = {
	title: '猫娘言語パックを追加しますか？',
	description: '「猫娘语（中文）」と「猫娘語（日本語）」を追加して、猫娘の口調の画面にするにゃ。追加後、設定 → エージェントで「猫娘人格」を有効にできます。',
	add: '言語パックを追加', cancel: '今はしない', busy: '追加中…', error: '追加に失敗しました。もう一度お試しください。',
	persona: '猫娘人格', personaDesc: '有効にすると、すべてのエージェントが次の応答から猫娘の口調になります。画面の言語を変えても有効のままです。',
	loadError: '猫娘人格の設定を読み込めません。もう一度お試しください。', saveError: '保存に失敗しました。もう一度お試しください。', retry: '再試行',
	disable: '猫娘言語パックを無効にする', disabling: '無効にしています…', disableError: '無効にできませんでした。もう一度お試しください。',
};
const english: typeof chinese = {
	title: 'Add the catgirl language pack?', description: 'Adds Catgirl Chinese and Japanese. Enable the catgirl persona in Settings → Agents.',
	add: 'Add language pack', cancel: 'Not now', busy: 'Adding…', error: 'Could not add the pack. Please retry.',
	persona: 'Catgirl persona', personaDesc: 'All agents use a catgirl tone from their next reply. Changing the interface language keeps the persona enabled.',
	loadError: 'Could not load catgirl settings. Please retry.', saveError: 'Could not save. Please retry.', retry: 'Retry',
	disable: 'Disable catgirl language pack', disabling: 'Disabling…', disableError: 'Could not disable the pack. Please retry.',
};
export function catgirlCopy(language: string) {
	return language.startsWith('ja') ? japanese : language.startsWith('zh') || language === 'lzh' ? chinese : english;
}
