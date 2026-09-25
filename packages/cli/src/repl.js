// CoCode 交互式 REPL：流式输出、工具调用展示、权限确认、会话管理、中止
import readline from 'node:readline';
import { join } from 'node:path';
import { runAgent } from '../../core/src/agent.js';
import { createSession, listSessions, loadSession, saveSession } from '../../core/src/session.js';
import { builtinTools, canonicalToolName } from '../../core/src/tools/builtin.js';
import { loadConfig, saveConfig } from '../../core/src/config.js';
import { matchCommand, loadCommands } from '../../core/src/commands.js';
import { realpathAllowMissing } from '../../core/src/security.js';
import { createAgentRenderer, C } from './render.js';

/** 5 档权限模式（与 agent.js decidePermission 一一对应） */
const PERMISSION_MODES = ['default', 'accept_edits', 'explore', 'bypass', 'dont_ask'];

const BANNER = `${C.cyan}${C.bold}
  ██████╗ ██████╗  ██████╗ ██████╗ ██████╗ ███████╗
 ██╔════╝██╔═══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝
 ██║     ██║   ██║██║     ██║   ██║██║  ██║█████╗
 ██║     ██║   ██║██║     ██║   ██║██║  ██║██╔══╝
 ╚██████╗╚██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗
  ╚═════╝ ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝  ${C.reset}${C.dim}Agent CLI${C.reset}`;

export async function runRepl(cfg) {
  console.log(BANNER);
  console.log(C.dim + `模型: ${cfg.model} @ ${cfg.baseURL}  ·  /help 查看命令  ·  Ctrl+C 中止当前任务` + C.reset + '\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${C.cyan}❯${C.reset} ` });
  let session = createSession();
  let running = null; // { ac }
  let sigintCount = 0;
  // 权限确认问答期间，主 line 处理器让位（否则会把回答当成新消息）
  let awaitingConfirm = false;
  // 持久 shell 需要稳定的工作目录：CLI 就用启动时的 cwd
  const cwd = realpathAllowMissing(process.cwd());
  console.log(C.dim + `工作目录: ${cwd}（工具只能读写这里；默认权限模式下写入/执行会先问你）` + C.reset);

  /** HITL 问答：agent.js 在 ask 处 await 它 */
  function askPermission({ name, args, suggestedRules }) {
    return new Promise((resolve) => {
      const rule = Array.isArray(suggestedRules) && suggestedRules.length ? suggestedRules[0] : null;
      const preview = JSON.stringify(args ?? {});
      awaitingConfirm = true;
      console.log(`\n${C.yellow}⚠ 权限确认${C.reset}  ${C.bold}${name}${C.reset}  ${C.dim}${preview.length > 200 ? preview.slice(0, 200) + '…' : preview}${C.reset}`);
      const hint = rule
        ? `  ${C.dim}[a] 以后都允许「${rule.rule_content}」（写入 ~/.cocode/config.json）${C.reset}`
        : '';
      rl.question(`${C.cyan}允许执行？ [y] 允许 / [n] 拒绝${rule ? ' / [a] 以后都允许' : ''}: ${C.reset}`, (ans) => {
        awaitingConfirm = false;
        const a = String(ans || '').trim().toLowerCase();
        if (a === 'a' && rule) return resolve({ confirmed: true, rules: [rule] });
        resolve({ confirmed: a === '' || a === 'y' || a === 'yes' });
      });
      if (hint) console.log(hint);
    });
  }

  /** AskUserQuestion 的终端形态：逐题列出选项，输入序号选择；0/回车 = 跳过 */
  function askUserTerminal({ questions }) {
    return new Promise((resolve) => {
      awaitingConfirm = true;
      const answers = [];
      const qs = Array.isArray(questions) ? questions : [];
      const askOne = (i) => {
        if (i >= qs.length) {
          awaitingConfirm = false;
          resolve({ answers });
          return;
        }
        const q = qs[i] || {};
        console.log(`\n${C.cyan}[${i + 1}/${qs.length}] ${q.question || ''}${C.reset}`);
        const opts = Array.isArray(q.options) ? q.options : [];
        opts.forEach((o, j) => {
          console.log(`  ${C.bold}${j + 1}. ${o.label || ''}${C.reset}  ${C.dim}${o.description || ''}${C.reset}`);
        });
        console.log(`  ${C.dim}0. 其他（直接输入文字）${q.multiSelect ? '（多选用逗号分隔）' : ''}${C.reset}`);
        rl.question(`${C.cyan}回答: ${C.reset}`, (ans) => {
          const raw = String(ans || '').trim();
          if (raw === '' || raw === '0') {
            answers.push({ selected: [], other: raw === '0' ? '' : '' });
          } else if (/^\d+([,，]\d+)*$/.test(raw)) {
            const idxs = raw.split(/[,，]/).map((x) => Number(x) - 1).filter((x) => x >= 0 && x < opts.length);
            answers.push({ selected: idxs.map((x) => opts[x]?.label || '').filter(Boolean), other: '' });
          } else {
            answers.push({ selected: [], other: raw });
          }
          askOne(i + 1);
        });
      };
      askOne(0);
    });
  }

  /** 通用 y/N 追问（同样要让出主 line 处理器，避免答案被当成新消息） */
  function askYesNo(prompt) {
    return new Promise((resolve) => {
      awaitingConfirm = true;
      rl.question(prompt, (ans) => {
        awaitingConfirm = false;
        resolve(['y', 'yes', '是'].includes(String(ans || '').trim().toLowerCase()));
      });
    });
  }

  rl.on('SIGINT', () => {
    if (running) {
      running.ac.abort();
      console.log(C.yellow + '\n（正在中止…）' + C.reset);
    } else {
      sigintCount++;
      if (sigintCount >= 2) { console.log('\n再见'); process.exit(0); }
      console.log(C.dim + '（再按一次 Ctrl+C 退出）' + C.reset);
      rl.prompt();
    }
  });
  rl.on('line', async (line) => {
    if (awaitingConfirm) return; // 交给权限问答的 question 回调
    const input = line.trim();
    sigintCount = 0;
    if (!running) {
      try { await handleInput(input); } catch (e) { console.error(C.red + '错误: ' + e.message + C.reset); }
    } else {
      console.log(C.dim + '（任务进行中，Ctrl+C 中止）' + C.reset);
    }
    rl.prompt();
  });
  rl.prompt();

  async function handleInput(input) {
    if (!input) return;
    if (input.startsWith('/')) return handleCommand(input.slice(1));
    // 自定义斜杠命令（~/.cocode/commands/*.md 或 <cwd>/.cocode/commands/*.md）
    const hit = matchCommand(input, cwd);
    await doRun(hit ? hit.prompt : input);
  }

  async function doRun(content) {
    if (!cfg.apiKey && !/localhost|127\.0\.0\.1/.test(cfg.baseURL)) {
      console.log(C.yellow + '未配置 apiKey：运行 `cocode config` 或设置环境变量 COCODE_API_KEY' + C.reset);
      return;
    }
    const renderer = createAgentRenderer();
    const ac = new AbortController();
    running = { ac };
    try {
      for await (const ev of runAgent({
        cfg,
        cwd,
        messages: session.messages,
        signal: ac.signal,
        sessionId: session.id,
        // CLI 有交互通道 → 默认走 default（写/执行会问），可用 /mode 切换
        permissionMode: cfg.permissionMode ?? 'default',
        permissionRules: loadConfig().permissionRules || [],
        permissionAsk: askPermission,
        askUser: askUserTerminal,
        onRuleAdded: (rule) => {
          try {
            saveConfig({ permissionRules: [...(loadConfig().permissionRules || []), rule] });
          } catch { /* ignore */ }
        },
        checkpoint: { enabled: cfg.checkpointEnabled !== false, sessionId: session.id },
        disposeShellOnEnd: false // REPL 里保留 shell 会话，跨轮次 cd 依然有效
      })) {
        renderer.feed(ev);
        if (ev.type === 'done') break;
      }
    } catch (e) {
      renderer.feed({ type: 'error', error: e.message });
    } finally {
      running = null;
      saveSession(session);
    }
  }

  async function handleCommand(raw) {
    const [cmd, ...rest] = raw.split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd) {
      case 'exit': case 'quit': case 'q':
        console.log('再见'); process.exit(0);
      case 'help':
        console.log(`${C.bold}命令${C.reset}
  /new                   新会话
  /sessions              会话列表
  /load <id>             加载会话（id 取前几位即可）
  /model [name]          查看或切换模型
  /mode [mode]           查看或切换权限模式（default/accept_edits/explore/bypass/dont_ask）
  /rules [add|rm|clear]  查看/管理允许清单；例：/rules add Bash "npm install"
  /repomap [子目录]      打印仓库符号骨架（省 token 的入口，先看它再动手）
  /index [关键词]        重建符号/语义索引；带关键词则直接检索（按词匹配，支持中文）
  /lsp                   检测本机装了哪些 language server（配 lspServers 后 Lsp 工具走真 LSP）
  /trace [id]            列出本会话的运行记录；带 id 则打印完整时间线（排障用）
  /hooks                 列出当前生效的钩子（含项目钩子是否被信任）
  /checkpoints           列出本会话的检查点
  /restore <轮号>        回滚工作目录到第 N 轮之前（会先让你确认）
  /export [md|json]      导出当前会话到当前目录
  /commands              列出可用的自定义斜杠命令
  /compact               立即压缩上下文（超预算时本来也会自动压缩）
  /tools                 工具列表
  /stats                 当前会话统计（token 估算）
  /exit                  退出

${C.dim}另外：~/.cocode/commands/*.md 或 <工作目录>/.cocode/commands/*.md 里的
markdown 会变成 /<文件名> 提示词模板，例如 /review、/commit-msg。${C.reset}`);
        break;
      case 'mode':
        if (arg) {
          if (!PERMISSION_MODES.includes(arg)) {
            console.log(C.red + `未知权限模式「${arg}」。可选：${PERMISSION_MODES.join(' / ')}` + C.reset);
            break;
          }
          cfg.permissionMode = arg;
          saveConfig({ permissionMode: arg });
          console.log(C.green + '✓ 权限模式已切换: ' + arg + C.reset);
        } else {
          console.log(`当前权限模式: ${C.cyan}${cfg.permissionMode ?? 'default'}${C.reset}`);
        }
        break;
      case 'rules': {
        const sub = rest[0];
        const rules = loadConfig().permissionRules || [];
        const save = (next) => { saveConfig({ permissionRules: next }); };
        if (!sub) {
          console.log(rules.length
            ? rules.map((r, i) => `${C.dim}${i}${C.reset} ${C.cyan}${r.tool_name}${C.reset} ${r.rule_content ?? '(任意)'} → ${r.behavior}`).join('\n')
            : '（还没有保存任何权限规则）');
          break;
        }
        if (sub === 'clear') {
          save([]);
          console.log(C.green + `✓ 已清空 ${rules.length} 条规则` + C.reset);
          break;
        }
        if (sub === 'rm') {
          const i = Number(rest[1]);
          if (!Number.isFinite(i) || i < 0 || i >= rules.length) { console.log(C.red + '用法: /rules rm <序号>（序号见 /rules）' + C.reset); break; }
          const [gone] = rules.splice(i, 1);
          save(rules);
          console.log(C.green + `✓ 已删除 ${gone.tool_name} ${gone.rule_content ?? '(任意)'}` + C.reset);
          break;
        }
        if (sub === 'add') {
          const tool = canonicalToolName(rest[1] || '');
          if (!tool) { console.log(C.red + '用法: /rules add <工具名> [匹配内容]，例: /rules add Bash "npm install"' + C.reset); break; }
          const content = rest.slice(2).join(' ').replace(/^["']|["']$/g, '').trim() || null;
          if (rules.some((r) => r.tool_name === tool && (r.rule_content ?? null) === content && r.behavior === 'allow')) {
            console.log(C.dim + '（规则已存在，未重复添加）' + C.reset);
            break;
          }
          rules.push({ tool_name: tool, rule_content: content, behavior: 'allow', source: 'userSettings' });
          save(rules);
          console.log(C.green + `✓ 已允许 ${tool}${content ? ` 「${content}」` : '（任意调用）'}` + C.reset);
          break;
        }
        console.log(C.dim + '用法: /rules | /rules add <工具> [内容] | /rules rm <序号> | /rules clear' + C.reset);
        break;
      }
      case 'repomap': {
        const { buildRepoMap } = await import('../../core/src/tools/repomap.js');
        const sub = arg || null;
        const target = sub ? join(cwd, sub) : cwd;
        const { text, files, symbols, truncated } = buildRepoMap(target, { maxChars: 6000 });
        if (!text) { console.log(C.dim + `（未提取到符号；扫描了 ${files} 个文件，可能是纯配置/资源目录）` + C.reset); break; }
        console.log(text);
        console.log(C.dim + `\n（${files} 个文件 / ${symbols} 个符号${truncated ? '，已达字符上限' : ''}）` + C.reset);
        break;
      }
      case 'index': {
        const { buildSymbolIndex } = await import('../../core/src/tools/lsp.js');
        const { buildSemanticIndex, searchIndex } = await import('../../core/src/tools/semantic.js');
        if (arg) {
          let r = searchIndex(cwd, arg, { limit: 12 });
          if (!r.hits.length) {
            buildSemanticIndex(cwd, { force: true });
            r = searchIndex(cwd, arg, { limit: 12 });
          }
          console.log(r.hits.length
            ? r.hits.map((h) => `${h.definition ? C.yellow + '★' + C.reset : ' '} ${C.cyan}${h.file}:${h.line}${C.reset} ${C.dim}${h.text}${C.reset}`).join('\n')
            : C.dim + `（没有命中「${arg}」；索引词：${r.tokens.join(', ') || '无'}）` + C.reset);
          break;
        }
        if (!cwd) { console.log(C.red + '（未确定工作目录）' + C.reset); break; }
        const sym = buildSymbolIndex(cwd, { force: true });
        const sem = buildSemanticIndex(cwd, { force: true });
        console.log(C.green + `✓ 索引完成：${sym.files} 个文件 / ${sym.symbols.length} 个符号 / ${sem.tokens} 个词条` + C.reset);
        break;
      }
      case 'lsp': {
        const { execFileSync } = await import('node:child_process');
        const known = [
          ['typescript-language-server', '.ts', 'TypeScript / JS'],
          ['pyright-langserver', '.py', 'Python (pyright)'],
          ['pylsp', '.py', 'Python (pylsp)'],
          ['gopls', '.go', 'Go'],
          ['rust-analyzer', '.rs', 'Rust'],
          ['bash-language-server', '.sh', 'Shell']
        ];
        const rows = [];
        for (const [bin, ext, label] of known) {
          let found = '';
          try { found = execFileSync('which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* 没装 */ }
          rows.push(`${found ? C.green + '✓' + C.reset : C.dim + '·' + C.reset} ${bin.padEnd(28)} ${C.dim}${label} ${ext}${found ? ' → ' + found : ''}${C.reset}`);
        }
        console.log(`${C.bold}本机 language server${C.reset}\n${rows.join('\n')}`);
        const configured = Object.entries(loadConfig().lspServers || {});
        console.log(configured.length
          ? `${C.dim}已配置：${configured.map(([e, v]) => `${e} → ${v.command || v}`).join('、')}${C.reset}`
          : `${C.dim}（还没配置 lspServers；Lsp 工具目前用本地符号索引，够用但没有类型信息）${C.reset}`);
        break;
      }
      case 'trace': {
        const { listTraces, renderTrace } = await import('../../core/src/trace.js');
        if (arg) {
          console.log(renderTrace(arg));
          break;
        }
        const list = listTraces({ sessionId: session.id, limit: 10 });
        console.log(list.length
          ? list.map((t) => `${C.cyan}${t.id}${C.reset}  ${C.dim}${new Date(t.startedAt).toLocaleString('zh-CN')} · ${t.turns} 轮 · ${t.tools} 次工具 · ${t.reason}${C.reset}`).join('\n')
          : C.dim + '（本会话还没有运行记录；traceEnabled=false 时不会记录）' + C.reset);
        break;
      }
      case 'hooks': {
        const { describeHooks } = await import('../../core/src/hooks.js');
        const info = describeHooks(cwd, cfg);
        if (!info.rows.length) {
          console.log(C.dim + '（没配置钩子。在 ~/.cocode/hooks.json 或 <工作目录>/.cocode/hooks.json 里写即可）' + C.reset);
        } else {
          console.log(info.rows.map((r) => `${C.cyan}${r.event}${C.reset} ${C.dim}[${r.matcher}]${C.reset} ${r.command} ${C.dim}(${r.source}, ${r.timeout}s)${C.reset}`).join('\n'));
        }
        if (info.projectHooksPresent && !info.projectHooksTrusted) {
          console.log(C.yellow + '⚠ 工作目录里有 .cocode/hooks.json，但未信任项目钩子，已跳过执行。' + C.reset);
        }
        for (const e of info.errors) console.log(C.red + `✗ ${e}` + C.reset);
        break;
      }
      case 'checkpoints': {
        const { listCheckpoints } = await import('../../core/src/tools/checkpoint.js');
        const list = listCheckpoints(session.id);
        console.log(list.length
          ? list.map((c) => `${C.cyan}第 ${c.turn} 轮${C.reset}  ${C.dim}${c.fileCount} 个文件 · ${new Date(c.at).toLocaleString('zh-CN')}${c.label ? ` · ${c.label}` : ''}${C.reset}`).join('\n')
          : '（本会话还没有检查点；每轮有写入/执行类工具调用前会自动建点）');
        break;
      }
      case 'restore': {
        const { listCheckpoints, restore } = await import('../../core/src/tools/checkpoint.js');
        const n = Number(arg);
        const list = listCheckpoints(session.id);
        if (!Number.isFinite(n)) {
          console.log(C.dim + `用法: /restore <轮号>${list.length ? `（可用：${list.map((c) => c.turn).join(', ')}）` : '（当前没有检查点）'}` + C.reset);
          break;
        }
        // 会覆盖工作目录里的文件 —— 必须确认，这个动作没有撤销
        const ok = await askYesNo(`${C.yellow}⚠ 将把工作目录回滚到第 ${n} 轮之前（覆盖现有文件、删除之后新增的文件）${C.reset}\n继续？[y/N]: `);
        if (!ok) { console.log(C.dim + '已取消' + C.reset); break; }
        const r = restore(session.id, n, cwd);
        console.log(r.ok
          ? C.green + `✓ 已回滚：恢复 ${r.restored} 个文件${r.deleted ? `，删除 ${r.deleted} 个新增文件` : ''}` + C.reset
          : C.red + `回滚失败：${r.reason}` + C.reset);
        break;
      }
      case 'commands': {
        const list = loadCommands(cwd);
        console.log(list.length
          ? list.map((c) => `/${c.name}  ${C.dim}${c.description} [${c.source}]${C.reset}`).join('\n')
          : '（还没有自定义命令；在 ~/.cocode/commands/ 或 .cocode/commands/ 放 .md 文件即可）');
        break;
      }
      case 'export': {
        const { exportSession } = await import('../../core/src/asapi/store.js');
        const fmt = arg === 'json' ? 'json' : 'md';
        const r = exportSession(session.id, fmt);
        if (!r) { console.log(C.red + '导出失败' + C.reset); break; }
        const out = `cocode-session-${session.id}.${fmt}`;
        const { writeFileSync } = await import('node:fs');
        writeFileSync(out, r.body);
        console.log(C.green + `✓ 已导出到 ${out}` + C.reset);
        break;
      }
      case 'new':
        saveSession(session);
        session = createSession();
        console.log(C.green + '✓ 已新建会话 ' + session.id + C.reset);
        break;
      case 'sessions': {
        const list = listSessions();
        if (!list.length) { console.log('（暂无会话）'); break; }
        console.log(list.map((s) => {
          const cur = s.id === session.id ? `${C.cyan}${C.bold}← 当前${C.reset}` : '';
          return `${C.dim}${s.id.slice(0, 12)}${C.reset} ${s.title} ${C.dim}(${s.messageCount} msg, ${s.updated.slice(0, 16)})${C.reset} ${cur}`;
        }).join('\n'));
        break;
      }
      case 'load': {
        if (!arg) { console.log('用法: /load <id前缀>'); break; }
        const found = listSessions().find((s) => s.id.startsWith(arg));
        if (!found) { console.log(C.red + '未找到该会话' + C.reset); break; }
        session = loadSession(found.id);
        console.log(C.green + `✓ 已加载「${session.title}」(${session.messages.length} 条消息)` + C.reset);
        break;
      }
      case 'model':
        if (arg) {
          cfg.model = arg;
          saveConfig({ model: arg });
          console.log(C.green + '✓ 模型已切换并保存: ' + arg + C.reset);
        } else {
          console.log(`当前模型: ${cfg.model} @ ${cfg.baseURL}`);
        }
        break;
      case 'tools':
        console.log(builtinTools.map((t) => `${C.cyan}${t.name}${C.reset}  ${t.description}`).join('\n'));
        break;
      case 'stats': {
        const { estimateMessagesTokens } = await import('../../core/src/context.js');
        console.log(`会话 ${session.id}\n消息数: ${session.messages.length}\n上下文估算: ${estimateMessagesTokens(session.messages)} tokens`);
        break;
      }
      case 'compact': {
        const { compactMessages, estimateMessagesTokens } = await import('../../core/src/context.js');
        const { createClient, chatCompletion } = await import('../../core/src/model.js');
        const before = estimateMessagesTokens(session.messages);
        // budget 设成当前的一半：只有"中段确实占着地方"时才值得压，否则压完更费 token
        const client = createClient(cfg);
        const { messages: out, compacted } = await compactMessages(session.messages, {
          budget: Math.max(200, Math.floor(before / 2)),
          summarize: async (p) => {
            const { message } = await chatCompletion(client, { messages: [{ role: 'user', content: p }] });
            return message.content;
          }
        });
        if (!compacted) {
          console.log(C.dim + `（没什么可压的：当前约 ${before} tokens，中段太小或消息太少）` + C.reset);
          break;
        }
        session.messages.length = 0;
        session.messages.push(...out);
        saveSession(session);
        console.log(C.green + `✓ 已压缩：${before} → ${estimateMessagesTokens(session.messages)} tokens（${session.messages.length} 条消息）` + C.reset);
        break;
      }
      default: {
        // 也允许 /<自定义命令> 直接执行
        const hit = matchCommand(`/${raw}`, cwd);
        if (hit) return void doRun(hit.prompt);
        console.log(C.dim + `未知命令 /${cmd}，/help 查看可用命令` + C.reset);
      }
    }
  }
}

/** 一次性任务模式：cocode "做某事" */
export async function runOneShot(cfg, content) {
  if (!cfg.apiKey && !/localhost|127\.0\.0\.1/.test(cfg.baseURL)) {
    throw new Error('未配置 apiKey：运行 `cocode config` 或设置环境变量 COCODE_API_KEY');
  }
  const session = createSession('oneshot');
  const renderer = createAgentRenderer();
  const ac = new AbortController();
  process.on('SIGINT', () => { ac.abort(); });
  let last = null;
  try {
    for await (const ev of runAgent({
      cfg,
      cwd: realpathAllowMissing(process.cwd()),
      messages: session.messages,
      signal: ac.signal,
      sessionId: session.id,
      // 一次性任务没有交互通道 → 不能用 default（会全部被拒），默认 bypass，
      // 可用 config 里的 permissionMode 覆盖。想被询问请用交互式 REPL。
      permissionMode: cfg.permissionMode ?? 'bypass',
      permissionRules: loadConfig().permissionRules || [],
      checkpoint: { enabled: cfg.checkpointEnabled !== false, sessionId: session.id }
    })) {
      renderer.feed(ev);
      if (ev.type === 'done') { last = ev; break; }
    }
  } catch (e) {
    renderer.feed({ type: 'error', error: e.message });
    process.exitCode = 1;
  }
  saveSession(session);
  if (last && last.reason === 'error') process.exitCode = 1;
}
