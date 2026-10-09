import {test} from 'node:test';import assert from 'node:assert/strict';
import {createSystemFontService,parseFontFamilies,normalizeFontFamilies} from '../packages/desktop/system-fonts.js';
test('system font enumeration parses real platform formats, removes duplicates and disabled/private faces',()=>{
 assert.deepEqual(parseFontFamilies(JSON.stringify({SPFontsDataType:[{enabled:'yes',typefaces:[{family:'Arial',enabled:'yes'},{family:'Arial'},{family:'苹方-简'},{family:'Disabled',enabled:'no'},{family:'.Hidden'}]},{enabled:'no',typefaces:[{family:'No'}]}]}),'darwin'),['Arial','苹方-简']);
 assert.deepEqual(parseFontFamilies('["Arial","苹方-简","Arial",".Private"]','darwin'),['Arial','苹方-简']);
 assert.deepEqual(parseFontFamilies('\uFEFF["Segoe UI","Arial","Arial"]','win32'),['Arial','Segoe UI']);assert.deepEqual(parseFontFamilies('Noto Sans\nArial\nArial\n','linux'),['Arial','Noto Sans']);assert.deepEqual(normalizeFontFamilies(['bad\nfont',null,'.Private','Arial']),['Arial']);
});
test('enumeration is async, coalesces requests, caches and refreshes without accepting a command from the renderer',async()=>{
 let resolve,calls=0,time=0;const service=createSystemFontService({platform:'linux',now:()=>time,run:async(command,args)=>{assert.equal(command,'fc-list');assert.deepEqual(args,['--format','%{family[0]}\\n']);calls++;if(calls===1)await new Promise(done=>{resolve=done;});return {stdout:'Arial\nNoto Sans\n'};}});
 const first=service(),second=service();assert.equal(calls,1);resolve();assert.deepEqual(await first,await second);await service();assert.equal(calls,1);await service(true);assert.equal(calls,2);time=61000;await service();assert.equal(calls,3);
});
test('a failed font scan can be retried and unknown platforms fail explicitly',async()=>{
 let fail=true;const service=createSystemFontService({platform:'darwin',run:async()=>{if(fail)throw Error('scan failed');return {stdout:JSON.stringify({SPFontsDataType:[{typefaces:[{family:'Arial'}]}]})};}});await assert.rejects(service());fail=false;assert.deepEqual(await service(),['Arial']);await assert.rejects(createSystemFontService({platform:'unknown'})(),/unsupported/);
});
test('native installed fonts can actually be read on this runner',async()=>{
 const fonts=await createSystemFontService()();assert.ok(fonts.length>0);assert.ok(fonts.every(value=>typeof value==='string'&&value.length<=160));console.log('Native font families:',process.platform,fonts.length);
});

test('macOS reads the font registry first and caches it without running the slow profiler',async()=>{
 let calls=0;const service=createSystemFontService({platform:'darwin',run:async(command,args)=>{
  calls++;assert.equal(command,'/usr/bin/osascript');assert.deepEqual(args.slice(0,3),['-l','JavaScript','-e']);assert.match(args[3],/CTFontManagerCopyAvailableFontFamilyNames/);
  return {stdout:'["Arial","Noto Sans"]'};
 }});assert.deepEqual(await service(),['Arial','Noto Sans']);await service();assert.equal(calls,1);await service(true);assert.equal(calls,2);
});
test('macOS uses the profiler fallback after a failed, malformed or empty fast scan',async()=>{
 for(const output of [null,'invalid','[]']){
  const commands=[];const service=createSystemFontService({platform:'darwin',run:async(command)=>{
   commands.push(command);if(command==='/usr/bin/osascript'){if(output===null)throw Error('unavailable');return {stdout:output};}
   return {stdout:JSON.stringify({SPFontsDataType:[{typefaces:[{family:'Arial'}]}]})};
  }});assert.deepEqual(await service(),['Arial']);assert.deepEqual(commands,['/usr/bin/osascript','/usr/sbin/system_profiler']);
 }
});
