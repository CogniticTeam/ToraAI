import {test} from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../packages/desktop/frontend/public/theme-boot.js',import.meta.url),'utf8');
const fixture=(saved)=>{const vars=new Map(),listeners=new Map(),storage=new Map(saved?[['tora.theme.font',saved]]:[]);const context={localStorage:{getItem:key=>storage.get(key)||null},document:{documentElement:{classList:{toggle(){}},dataset:{},style:{setProperty:(key,value)=>vars.set(key,value),removeProperty:key=>vars.delete(key)}}},window:{matchMedia:()=>({matches:false,addEventListener(){}}),addEventListener:(key,fn)=>{const rows=listeners.get(key)||[];rows.push(fn);listeners.set(key,rows);}}};vm.runInNewContext(source,context);return {vars,storage,fire:(key,event)=>listeners.get(key)?.forEach(fn=>fn(event))};};
test('font preference applies before first paint, escapes family names and restores the system fallback',()=>{
 const ui=fixture('Example "Display"\\Font');assert.equal(ui.vars.get('--tora-ui-font'),'"Example \\"Display\\"\\\\Font", var(--tora-system-font)');ui.storage.delete('tora.theme.font');ui.fire('tora:font-changed');assert.equal(ui.vars.has('--tora-ui-font'),false);
});
test('cross-window font changes are applied and malformed saved names fall back safely',()=>{
 const ui=fixture();ui.storage.set('tora.theme.font','Arial');ui.fire('storage',{key:'tora.theme.font'});assert.equal(ui.vars.get('--tora-ui-font'),'"Arial", var(--tora-system-font)');assert.equal(fixture('bad\nfont').vars.has('--tora-ui-font'),false);assert.equal(fixture('x'.repeat(161)).vars.has('--tora-ui-font'),false);
});
