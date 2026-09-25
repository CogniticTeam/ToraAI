// 对最终签名、公证并附票据后的 DMG 重建差分更新元数据。
// electron-builder 初次生成的 blockmap/latest-mac.yml 对应的是附票据前的文件。
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const builderDirectory = dirname(require.resolve('app-builder-lib/package.json'));
const { buildBlockMap } = require(join(builderDirectory, 'out/targets/blockmap/blockmap.js'));
const desktop = JSON.parse(await readFile(resolve('packages/desktop/package.json'), 'utf8'));
const releaseDirectory = resolve(process.argv[2] || 'packages/desktop/release');
const fileName = `CoCode-${desktop.version}-mac.dmg`;
const zipName = `CoCode-${desktop.version}-mac.zip`;
const dmg = join(releaseDirectory, fileName);
const metadataPath = join(releaseDirectory, 'latest-mac.yml');
const metadata = yaml.load(await readFile(metadataPath, 'utf8'));

const dmgEntry = metadata.files?.find((file) => file.url === fileName);
const zipEntry = metadata.files?.find((file) => file.url === zipName);
if (metadata.version !== desktop.version || !dmgEntry || !zipEntry || ![fileName, zipName].includes(metadata.path)) {
  throw new Error('latest-mac.yml 必须同时包含当前版本的 DMG 和 ZIP，已停止更新');
}
await stat(join(releaseDirectory, zipName));

const { sha512, size } = await buildBlockMap(dmg, 'gzip', `${dmg}.blockmap`);
dmgEntry.sha512 = sha512;
dmgEntry.size = size;
if (metadata.path === fileName) metadata.sha512 = sha512;
await writeFile(metadataPath, yaml.dump(metadata, { lineWidth: -1 }), 'utf8');
console.log(`已更新 ${fileName} 的 blockmap 与 latest-mac.yml，保留 ZIP 更新包（${size} 字节）`);
