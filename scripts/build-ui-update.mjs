// Build a signed, immutable renderer release. Private key is supplied from outside the repository.
import {readFile,writeFile,readdir,lstat,mkdir,rm} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {sign,createPrivateKey,createPublicKey} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {digest,assetPath,readManifest,UI_PROTOCOL} from '../packages/desktop/ui-updates.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=Object.fromEntries(process.argv.slice(2).map(value=>{const i=value.indexOf('=');return [value.slice(0,i),value.slice(i+1)];}));
if(!process.env.TORA_UI_SIGNING_KEY_FILE)throw Error('Set TORA_UI_SIGNING_KEY_FILE to a private publisher key outside the repository');
const build=Number(args['--build']||Date.now()),version=`ui-${build}`,base=`/ui/${version}/`;
const work=join(root,'.tmp','ui-release-build',version),out=resolve(args['--out']||join(root,'.tmp','ui-release',version));
// This UI depends on the dynamic core catalog delivered by the next installer.
const minimumShell=args['--minimum-shell']||'1.1.1';
const parts=/^(\d+)\.(\d+)\.(\d+)$/.exec(minimumShell)?.slice(1).map(Number);
if(!parts||parts[0]<1||parts[0]===1&&(parts[1]<1||parts[1]===1&&parts[2]<1))throw Error('This renderer requires shell 1.1.1 or newer (dynamic model catalog)');
await mkdir(out,{recursive:true});await rm(work,{recursive:true,force:true});
const result=spawnSync('npm',['run','build','--prefix',join(root,'packages/desktop/frontend'),'--','--outDir',work],{stdio:'inherit',env:{...process.env,TORA_UI_BASE:base,TORA_UI_VERSION:version,TORA_UI_BUILD:String(build)}});
if(result.status!==0)throw Error('UI build failed');
const files=[];
async function walk(directory,prefix=''){
 for(const name of (await readdir(directory)).sort()){
  const path=join(directory,name),entry=assetPath(prefix+name),info=await lstat(path);
  if(info.isSymbolicLink())throw Error('UI build cannot contain symlinks');
  if(info.isDirectory()){await walk(path,entry+'/');continue;}
  if(!info.isFile())throw Error('Unsupported UI build entry');
  const bytes=await readFile(path);files.push({path:entry,bytes:bytes.length,sha256:digest(bytes),data:bytes.toString('base64')});
 }
}
await walk(work);
const data=gzipSync(JSON.stringify({files:files.map(({path,data})=>({path,data}))}),{level:9}),file=`${version}.json.gz`;
const manifest={protocol:UI_PROTOCOL,version,build,minimumShell,url:`https://ohfun.online/tora-updates/ui/${file}`,bytes:data.length,sha256:digest(data),files:files.map(({data,...entry})=>entry)};
const payload=Buffer.from(JSON.stringify(manifest)),key=createPrivateKey(await readFile(process.env.TORA_UI_SIGNING_KEY_FILE));
const pinned=await readFile(join(root,'packages/desktop/assets/hot-ui-public-key.pem'));
if(createPublicKey(key).export({type:'spki',format:'pem'}).toString()!==pinned.toString())throw Error('Publisher key does not match the packaged public key');
const envelope={payload:payload.toString('base64'),signature:sign(null,payload,key).toString('base64')};
readManifest(envelope,pinned,minimumShell,'https://ohfun.online/tora-updates/ui/stable.json');
await writeFile(join(out,file),data);await writeFile(join(out,'stable.json'),JSON.stringify(envelope));
console.log(JSON.stringify({version,build,files:files.length,bytes:data.length,out,minimumShell}));
