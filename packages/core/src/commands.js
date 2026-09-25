// 自定义斜杠命令：把常用的提示词模板做成 /review、/commit-msg 这样的命令。
//
// 现状：斜杠菜单只弹技能列表（SlashCommandMenu 的数据形状就是 SkillView），
// 不是命令系统。这里补上后端：把 markdown 文件变成可展开的提示词模板。
//
// 约定：`~/.cocode/commands/*.md` 与 `<工作目录>/.cocode/commands/*.md`
// 文件名即命令名。文件可带一段极简 frontmatter：
//   ---
//   description: 审查当前改动
//   argument-hint: [文件路径]
//   ---
// 正文即提示词模板；`$ARGUMENTS` 或 `{{args}}` 会被替换成用户输入的参数。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { COCODE_DIR } from './config.js';

export const USER_COMMANDS_DIR = join(COCODE_DIR, 'commands');

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const hit = /^([\w-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (hit) meta[hit[1]] = hit[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

function readDir(dir, source) {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  let files;
  try { files = readdirSync(dir); } catch { return []; }
  for (const f of files.sort()) {
    if (!/\.(md|markdown|txt)$/i.test(f)) continue;
    const name = basename(f).replace(/\.(md|markdown|txt)$/i, '');
    if (!/^[\w-]+$/.test(name)) continue;
    let raw;
    try { raw = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    const { meta, body } = parseFrontmatter(raw);
    out.push({
      name,
      description: meta.description || body.trim().split('\n')[0].slice(0, 80) || '',
      argument_hint: meta['argument-hint'] || meta.argument_hint || '',
      body: body.trim(),
      source
    });
  }
  return out;
}

/**
 * 列出可用命令（项目级覆盖用户级同名命令）。
 * @param {string} [cwd]
 */
export function loadCommands(cwd) {
  const project = cwd ? readDir(join(cwd, '.cocode', 'commands'), 'project') : [];
  const user = readDir(USER_COMMANDS_DIR, 'user');
  const byName = new Map();
  for (const c of [...user, ...project]) byName.set(c.name, c);
  return [...byName.values()];
}

/** 把命令模板展开成最终提示词 */
export function expandCommand(command, args = '') {
  const body = String(command?.body ?? '');
  const a = String(args ?? '').trim();
  return body
    .replace(/\$ARGUMENTS/g, a)
    .replace(/\{\{\s*args\s*\}\}/g, a)
    .replace(/\{\{\s*argument[s]?\s*\}\}/g, a);
}

/** 从输入里识别 `/命令 参数`（未知命令返回 null，交给上层当普通消息处理） */
export function matchCommand(text, cwd) {
  const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const cmd = loadCommands(cwd).find((c) => c.name === m[1]);
  if (!cmd) return null;
  return { command: cmd, args: m[2] ?? '', prompt: expandCommand(cmd, m[2] ?? '') };
}
