#!/usr/bin/env node
// CoCode CLI 入口：交互 REPL / 一次性任务 / 配置管理 / 会话管理
import { parseArgs } from 'node:util';
import { runRepl, runOneShot } from './repl.js';
import { loadConfig } from '../../core/src/config.js';
import { listSessions } from '../../core/src/session.js';
import { builtinTools } from '../../core/src/tools/builtin.js';
import { createRequire } from 'node:module';

const VERSION = '0.1.0';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string', short: 'm' },
    'base-url': { type: 'string' },
    'api-key': { type: 'string' },
    list: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' }
  }
});

function printHelp() {
  console.log(`CoCode v${VERSION} — 低 token 终端 Agent

用法:
  cocode                   交互式 REPL
  cocode "任务描述"        一次性执行任务（默认 bypass 权限）
  cocode config            配置向导（模型接入）
  cocode config --list     查看当前配置
  cocode sessions          列出历史会话
  cocode tools             列出内置工具
  cocode models            探测本机已启动的模型服务（Ollama / LM Studio / vLLM）

选项:
  -m, --model <name>       覆盖模型名（本次生效）
  --base-url <url>         覆盖 baseURL（任何 OpenAI 兼容接口）
  --api-key <key>          覆盖 apiKey
  -h, --help               帮助
  -v, --version            版本

环境变量: COCODE_BASE_URL / COCODE_API_KEY / COCODE_MODEL
          （优先级高于配置文件；COCODE_HOME 可指定数据目录）

REPL 内命令:
  /help                    帮助
  /new                     新建会话
  /sessions                列出会话        /load <id>  载入会话
  /mode [default|accept_edits|explore|bypass|dont_ask]
                           查看/切换权限模式
  /rules [add <tool> <content> | rm <index> | clear]
                           查看/管理允许清单（允许清单命中即免确认）
  /commands                列出可用的斜杠命令（~/.cocode/commands 与项目 .cocode/commands）
  /repomap                 打印仓库符号骨架
  /index [关键词]          重建符号/语义索引；带关键词直接检索
  /lsp                     检测本机 language server 并查看 lspServers 配置
  /trace [id]              列出运行记录 / 打印某次运行的完整时间线
  /hooks                   列出当前生效的钩子（项目钩子是否被信任）
  /checkpoints             列出检查点      /restore <turn>  回滚到第 N 轮
  /export [md|json]        导出当前会话（写到当前目录）
  /model <name>            切换模型        /compact  立即压缩上下文
  /tools                   列出内置工具    /exit     退出

斜杠命令: 在 ~/.cocode/commands/ 或 <项目>/.cocode/commands/ 放 .md 文件即可
          自定义命令（支持 $ARGUMENTS 占位），然后在 REPL 里直接 /<名字> 使用。`);
}

async function main() {
  const cmd = positionals[0];
  if (values.help || cmd === 'help') return printHelp();
  if (values.version) return console.log(`cocode ${VERSION}`);

  // 配置覆盖
  const cfg = loadConfig();
  if (values.model) cfg.model = values.model;
  if (values['base-url']) cfg.baseURL = values['base-url'];
  if (values['api-key']) cfg.apiKey = values['api-key'];

  if (cmd === 'config' && values.list) {
    const { listConfig } = await import('./config-wizard.js');
    return listConfig();
  }
  if (cmd === 'config') {
    const { runConfigWizard } = await import('./config-wizard.js');
    return runConfigWizard();
  }
  if (cmd === 'sessions') {
    const list = listSessions();
    if (!list.length) return console.log('（暂无会话）');
    console.log(list.map((s) => `${s.id}  [${s.updated.slice(0, 16)}]  ${s.title} (${s.messageCount} 条消息)`).join('\n'));
    return;
  }
  if (cmd === 'tools') {
    return console.log(builtinTools.map((t) => `${t.name}\n  ${t.description}`).join('\n\n'));
  }
  // 探测本机已启动的推理服务（Ollama / LM Studio / vLLM / llama.cpp …），
  // 找到就顺手写进配置 —— "自接入模型"最省事的一条路径
  if (cmd === 'models') {
    const { discoverLocalModels } = await import('../../core/src/discover.js');
    const found = await discoverLocalModels({ timeout: 1200 });
    if (!found.length) {
      return console.log('未发现本地模型服务。已探测: Ollama 11434 / LM Studio 1234 / vLLM 8000 / llama.cpp 8080');
    }
    console.log(found.map((p) => `${p.name}\t${p.baseURL}\t${(p.models || []).slice(0, 5).join(', ')}`).join('\n'));
    console.log('\n把它们接进来： cocode config   （或 cocode --base-url <url> --model <name> "任务"）');
    return;
  }

  if (cmd) return runOneShot(cfg, positionals.join(' ')); // 一次性任务
  return runRepl(cfg);
}

main().catch((e) => {
  console.error(`\x1b[31m错误: ${e.message}\x1b[0m`);
  process.exit(1);
});
