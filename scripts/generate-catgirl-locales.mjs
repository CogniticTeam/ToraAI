// 从现有中日译文生成完整猫娘词库，保留技术标识和插值；常用交互单独润色。
import { readFileSync, writeFileSync } from 'node:fs';
import { applicationMenuTemplate } from '../packages/desktop/application-menu.js';

const localeRoot = new URL('../packages/desktop/frontend/src/i18n/locales/', import.meta.url);
const overrides = {
  zh: {
    'common.cancel': '先不了喵', 'common.confirm': '好哒喵', 'common.error': '哎呀，出错了喵',
    'common.loading': '本喵正在加载…', 'common.completed': '完成啦喵', 'common.noData': '这里还空空的喵',
    'common.save': '保存好喵', 'common.saving': '本喵正在保存…', 'common.new-task': '开始新任务喵',
    'common.settings': '设置喵', 'common.my-skill': '本喵的技能', 'common.mine': '本喵的',
    'chat.inputPlaceholder': '想做什么，告诉本喵吧～', 'chat.greeting': '今天想和本喵一起构建什么呀？',
    'chat.greetingProject': '要和本喵一起在{{project}}中做些什么呀？', 'chat.thinking': '本喵认真想想…',
    'chat.confirmToolCall': '可以让本喵执行这个操作吗？',
    'chat.agent.emptyTitle': '还没有智能体喵', 'chat.session.emptyTitle': '还没有会话喵',
    'textInput.send': '发送喵', 'textInput.stop': '先停一下喵', 'textInput.stopping': '本喵正在停下来…',
    'textInput.attach': '带上附件喵', 'textInput.optimize': '让本喵润色提示词',
    'languageDialog.title': '选个语言喵', 'languageDialog.search': '找找喜欢的语言喵',
    'languageDialog.noResults': '本喵没找到这个语言呢',
    'agentSection.desc': '给智能体取个名字、写下系统提示词喵。留空时本喵会使用 Tora 内置提示词。',
    'agentSection.systemPromptPlaceholder': '留空就用 Tora 内置提示词喵',
  },
  ja: {
    'common.cancel': '今はやめるにゃ', 'common.confirm': '了解にゃ', 'common.error': 'あれれ、エラーにゃ',
    'common.loading': '読み込み中にゃ…', 'common.completed': 'できたにゃ！', 'common.noData': 'まだ何もないにゃ',
    'common.save': '保存するにゃ', 'common.saving': '保存中にゃ…', 'common.new-task': '新しいタスクにゃ',
    'common.settings': '設定にゃ', 'common.my-skill': 'わたしのスキルにゃ', 'common.mine': 'わたしのにゃ',
    'chat.inputPlaceholder': 'やりたいことを教えてにゃ', 'chat.greeting': '今日は一緒に何を作るにゃ？',
    'chat.greetingProject': '{{project}} で一緒に何をするにゃ？', 'chat.thinking': 'じっくり考え中にゃ…',
    'chat.confirmToolCall': 'この操作をしてもいいかにゃ？',
    'chat.agent.emptyTitle': 'エージェントはまだいないにゃ', 'chat.session.emptyTitle': '会話はまだないにゃ',
    'textInput.send': '送るにゃ', 'textInput.stop': 'いったん止めるにゃ', 'textInput.stopping': '停止中にゃ…',
    'textInput.attach': 'ファイルを添えるにゃ', 'textInput.optimize': 'プロンプトを磨くにゃ',
    'languageDialog.title': '言語を選ぶにゃ', 'languageDialog.search': '好きな言語を探すにゃ',
    'languageDialog.noResults': 'その言語は見つからなかったにゃ',
    'agentSection.desc': 'エージェントの名前とシステムプロンプトを設定するにゃ。空欄なら Tora の標準プロンプトを使うにゃ。',
    'agentSection.systemPromptPlaceholder': '空欄なら Tora の標準プロンプトを使うにゃ',
  },
};

function tone(text, language, path) {
  if (overrides[language][path]) return overrides[language][path];
  // 固有名・言語名・法律文面・モデルへ送る指示・日時フォーマットは原文を維持。
  if (/^settings\.general\.language\.(?!title$|desc$)/.test(path)
    || /^(firstUseConsent|firstRun\.privacy)/.test(path)
    || /(?:format|placeholder|elementRefLine|skillOnlyPrompt|optimizeBy|providers)\b/i.test(path)
    || !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return text;
  // 口癖は文末だけ。テンプレート/コード/タグ/URLの内容は一切書き換えない。
  const parts = text.split(/(\{\{[^{}]*\}\}|`[^`]*`|<\/?[A-Za-z][^>]*>|https?:\/\/\S+)/g);
  const body = parts.map((part, index) => index % 2 ? part : language === 'zh'
    ? part.replaceAll('我们', '本喵和你').replaceAll('我的', '本喵的')
    : part).join('');
  const match = body.match(/([。！？!?…\.]+)?(\s*)$/);
  const ending = match[1] || '';
  const space = match[2];
  const base = body.slice(0, body.length - match[0].length);
  if (language === 'zh') return `${base}喵${ending}${space}`;
  const japanese = base.replace(/してください$/, 'してほしいにゃ').replace(/しました$/, 'したにゃ')
    .replace(/ありません$/, 'ないにゃ').replace(/できます$/, 'できるにゃ')
    .replace(/します$/, 'するにゃ').replace(/です$/, 'だにゃ').replace(/ます$/, 'ますにゃ');
  return `${japanese.endsWith('にゃ') ? japanese : japanese + 'にゃ'}${ending}${space}`;
}

function translate(value, language, path = '') {
  if (typeof value === 'string') return tone(value, language, path);
  if (Array.isArray(value)) return value.map((item, index) => translate(item, language, `${path}.${index}`));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, translate(item, language, path ? `${path}.${key}` : key)]));
}

for (const language of ['zh', 'ja']) {
  const source = JSON.parse(readFileSync(new URL(`${language}.json`, localeRoot), 'utf8'));
  const result = translate(source, language);
  writeFileSync(new URL(`${language}-Neko.json`, localeRoot), JSON.stringify(result, null, 2) + '\n');
}
const nativeFile = new URL('../packages/desktop/native-locales.json', import.meta.url);
const native = JSON.parse(readFileSync(nativeFile, 'utf8'));
// 普通中文菜单的原文在 application-menu 中；按同一模板取出中英文对应项。
const zhNative = {
  'You have a new message': '收到一条 Tora 消息', 'Tora is up to date': '当前已是最新版本',
  'Updates are disabled in development': '开发版本不检查更新', 'Unable to check for updates': '暂时无法检查更新',
};
function collectLabels(english, chinese) {
  english.forEach((item, index) => {
    if (item.label) zhNative[item.label] = chinese[index].label;
    if (item.submenu) collectLabels(item.submenu, chinese[index].submenu);
  });
}
collectLabels(applicationMenuTemplate({ language: 'en', isMac: true }), applicationMenuTemplate({ language: 'zh', isMac: true }));
native['zh-Neko'] = translate(Object.fromEntries(Object.keys(native.en).map(key => [key, zhNative[key] || key])), 'zh');
native['ja-Neko'] = translate(native.ja, 'ja');
writeFileSync(nativeFile, JSON.stringify(native, null, 2) + '\n');
console.log('已生成中文、日语猫娘界面与原生菜单词库');
