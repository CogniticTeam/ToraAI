import test from 'node:test';
import assert from 'node:assert/strict';
import {browserConversationPath,browserRecommendations,queueBrowserPanel,takeBrowserPanel} from '../packages/desktop/frontend/src/lib/browserStart.ts';
test('Browser return routes stay within conversation context',()=>{
  assert.equal(browserConversationPath('/chat/agent/session?task=work'),'/chat/agent/session?task=work');
  assert.equal(browserConversationPath('/tochat/agent?task=chat'),'/tochat/agent?task=chat');
  for(const value of ['https://example.com','//example.com/chat/agent','/browser','javascript:alert(1)',null])assert.equal(browserConversationPath(value),null);
});
test('Recommendations use open sites, remove duplicates and exclude unsupported URLs',()=>{
  const sites=browserRecommendations([{url:'https://example.com/#one',title:'Open page'},{url:'javascript:alert(1)',title:'Unsafe'}],[{url:'https://example.com/#two',title:'Duplicate'},{url:'https://ohfun.online',title:'Cognitic'}]);
  assert.deepEqual(sites.map(x=>x.title),['Open page','Cognitic']);
  assert.equal(browserRecommendations([],Array.from({length:8},(_,i)=>({url:`https://example.com/${i}`,title:String(i)}))).length,4);
});
test('Tool requests are consumed only by the originating conversation and only once',()=>{
  queueBrowserPanel('/chat/a/b','terminal');assert.equal(takeBrowserPanel('/chat/a/c'),null);assert.equal(takeBrowserPanel('/chat/a/b'),'terminal');assert.equal(takeBrowserPanel('/chat/a/b'),null);
});
