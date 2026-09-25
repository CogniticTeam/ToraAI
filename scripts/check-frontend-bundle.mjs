// 前端产物预算：防止一个静态导入把已登录用户的首屏重新拖回多 MB。
// 运行前必须先执行 packages/desktop/frontend 的 production build。
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const assetsDir = join(process.cwd(), 'packages/desktop/frontend/dist/assets');
const files = readdirSync(assetsDir).filter((name) => name.endsWith('.js'));
const entry = files.filter((name) => /^index-[^.]+\.js$/.test(name));
const workspace = files.filter((name) => /^Workspace-[^.]+\.js$/.test(name));
const markdown = files.filter((name) => /^markdown-[^.]+\.js$/.test(name));
const MIB = 1024 * 1024;
const MAX_ENTRY_BYTES = Math.floor(0.75 * MIB);
const MAX_WORKSPACE_BYTES = Math.floor(0.8 * MIB);
const MIN_MARKDOWN_CHUNK_BYTES = Math.floor(0.5 * MIB);

if (entry.length !== 1) {
	throw new Error(`预期恰好一个前端入口 chunk，实际为 ${entry.length} 个：${entry.join(', ') || '(无)'}`);
}
if (workspace.length !== 1) {
	throw new Error(`预期恰好一个工作区 chunk，实际为 ${workspace.length} 个：${workspace.join(', ') || '(无)'}`);
}
if (markdown.length < 1) {
	throw new Error('未找到 Markdown 动态 chunk；请勿把 Streamdown/高亮插件重新静态打进首包。');
}

const entryBytes = statSync(join(assetsDir, entry[0])).size;
const workspaceBytes = statSync(join(assetsDir, workspace[0])).size;
const markdownBytes = Math.max(...markdown.map((name) => statSync(join(assetsDir, name)).size));
if (entryBytes > MAX_ENTRY_BYTES) {
	throw new Error(`首包 ${format(entryBytes)} 超过预算 ${format(MAX_ENTRY_BYTES)}；请恢复路由或渲染器懒加载。`);
}
if (workspaceBytes > MAX_WORKSPACE_BYTES) {
	throw new Error(`工作区主包 ${format(workspaceBytes)} 超过预算 ${format(MAX_WORKSPACE_BYTES)}；请检查侧栏面板是否重新变成静态导入。`);
}
if (markdownBytes < MIN_MARKDOWN_CHUNK_BYTES) {
	throw new Error(`Markdown chunk ${format(markdownBytes)} 异常偏小；请确认高亮/渲染依赖未被重新并入首包。`);
}

console.log(`前端预算通过：首包 ${format(entryBytes)} / ${format(MAX_ENTRY_BYTES)}；工作区 ${format(workspaceBytes)} / ${format(MAX_WORKSPACE_BYTES)}；Markdown 动态块 ${format(markdownBytes)}`);

function format(bytes) {
	return `${(bytes / MIB).toFixed(2)} MiB`;
}
