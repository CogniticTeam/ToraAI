import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const root=new URL('../packages/desktop/frontend/',import.meta.url),require=createRequire(new URL('package.json',root));
const ts=require('typescript'),i18next=require('i18next');
const languages=['en','en-GB','en-US','zh','zh-HK','zh-TW','ja','ko','fr','de','it','ar','es','pt','ru','hi','lzh','zh-Neko','ja-Neko'];
const packs=Object.fromEntries(languages.map(code=>[code,JSON.parse(readFileSync(new URL('src/i18n/locales/'+code+'.json',root),'utf8'))]));
function load(file,imports={}){
 const output=ts.transpileModule(readFileSync(new URL(file,root),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const exports={};vm.runInNewContext(output,{exports,require:name=>{if(!(name in imports))throw Error('Unexpected import '+name);return imports[name];}});return exports;
}
const {normalizeLanguage,LANGUAGE_OPTIONS,LANGUAGE_FLAG_COUNTRIES,messageTranslationLanguage}=load('src/i18n/languages.ts');
const instance=i18next.createInstance();
await instance.init({lng:'en',fallbackLng:'en',resources:Object.fromEntries(languages.map(code=>[code,{translation:packs[code]}])),interpolation:{escapeValue:false}});
const {modeCopy,MODE_COPY_KEYS}=load('src/lib/applicationModes.ts',{'@/i18n':{__esModule:true,default:instance,normalizeLanguage}});

test('18 种语言的模式词条完整，ToCode、聊天和工作标题直接使用对应语言',()=>{
 for(const code of languages){
  const catalog=packs[code].applicationModes;assert.deepEqual(Object.keys(catalog).sort(),Array.from(MODE_COPY_KEYS).sort(),code);
  const copy=modeCopy(code);
  for(const key of MODE_COPY_KEYS)assert.equal(copy(key),catalog[key].replaceAll('{{amount}}','—'),code+'.'+key);
  for(const key of ['ready','workReady'])if(!code.startsWith('en'))assert.notEqual(copy(key),packs.en.applicationModes[key],code+' 标题不能回退英文');
  if(!code.startsWith('en'))assert.notEqual(packs[code].chat.greeting,packs.en.chat.greeting,code+' ToCode 标题不能回退英文');
 }
 assert.equal(instance.language,'en','按语言读取文案不能修改全局语言');
});

test('区域语言映射和用量占位符仍然正确，零用量不能变成缺省值',()=>{
 assert.equal(modeCopy('ja-JP')('ready'),packs.ja.applicationModes.ready);
 assert.equal(modeCopy('pt-BR')('workReady'),packs.pt.applicationModes.workReady);
 assert.equal(modeCopy('zh-TW')('ready'),packs['zh-TW'].applicationModes.ready);
 assert.equal(modeCopy('zh-Hant-HK')('official'),packs['zh-HK'].applicationModes.official);
 assert.equal(modeCopy('zh-Hant')('official'),packs['zh-TW'].applicationModes.official);
 for(const code of languages)for(const count of [0,150,'—']){
  const text=modeCopy(code)('chatRemaining',count);assert.ok(text.includes(String(count)),code);assert.ok(!text.includes('{{'),code);
 }
 assert.equal(modeCopy('unknown')('ready'),packs.en.applicationModes.ready);
});

test('语言目录包含两个繁体地区，系统和旧设置的映射一致',()=>{
 assert.equal(LANGUAGE_OPTIONS.length,18);
 assert.ok(!LANGUAGE_OPTIONS.some(option=>option.value==='zh-Hant'||option.value==='en'));
 assert.equal(packs['en-GB'].settings.general.behavior,'Behaviour');
 assert.equal(packs['en-US'].settings.general.behavior,'Behavior');
 assert.equal(LANGUAGE_FLAG_COUNTRIES['en-GB'],'gb');
 assert.equal(LANGUAGE_FLAG_COUNTRIES['en-US'],'us');
 for(const [value,expected]of [['en','en-US'],['en_US','en-US'],['en-GB','en-GB'],['en_UK','en-GB'],['en-US-u-hc-h12','en-US'],['en-GB-u-hc-h23','en-GB'],['zh_HK','zh-HK'],['zh-Hant-HK','zh-HK'],['zh-MO','zh-HK'],['zh-Hant-MO','zh-HK'],['zh_TW','zh-TW'],['zh-Hant-TW','zh-TW'],['zh-Hant','zh-TW'],['zh-CN','zh']])assert.equal(normalizeLanguage(value),expected,value);
});

test('界面地区保持独立，旧消息翻译接口使用受支持的语言代码，未知来源仍可翻译',()=>{
 for(const [value,expected]of [['en-GB','en'],['en-US','en'],['en','en'],['zh-HK','zh-Hant'],['zh-TW','zh-Hant'],['zh-Hant','zh-Hant'],['ja','ja']])assert.equal(messageTranslationLanguage(value),expected,value);
 assert.equal(messageTranslationLanguage(null),null);
 assert.equal(messageTranslationLanguage('unknown'),null);
 assert.equal(messageTranslationLanguage('en'),messageTranslationLanguage('en-GB'));
});
