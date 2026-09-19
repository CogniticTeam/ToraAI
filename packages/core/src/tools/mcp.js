// MCP（Model Context Protocol）stdio 客户端：把外部工具服务器接进会话。
//
// 配置在 `~/.vega/config.json` 的 `mcpServers`（与 Claude Desktop 同形）：
//   { "fetch": { "command": "npx", "args": ["-y", "mcp-server-fetch"], "env": {} } }
//
// 设计取舍：
//  · 只做 stdio 传输（子进程 + 换行分隔 JSON-RPC）。纯 Node 内建模块，core
//    保持零依赖；HTTP/SSE 传输等有真实需求再补。
//  · 进程**懒启动、常驻、空闲回收**：MCP 服务器往往有昂贵的初始化（下载、
//    建索引），每轮重启太浪费；但常驻不回收会留一堆僵尸子进程。
//  · 工具名 `mcp__<server>__<tool>`：跨服务器不冲突，模型一看前缀就知道来源。
//  · 一台服务器挂了不影响其它服务器 —— 每台独立超时、独立报错，绝不假装成功。
//
// 安全：command 来自用户自己的配置（与 lspServers 同级信任）。子进程环境走
// buildChildEnv（剥密钥），不透传 API key 一类的东西。

import { spawn } from 'node:child_process';
import { buildChildEnv } from '../security.js';

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'cocode', version: '1.0.0' };
const DEFAULT_TIMEOUT_MS = 30000; // 单次请求
const START_TIMEOUT_MS = 15000; // 握手
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000; // 空闲回收

// ---------------------------------------------------------------- 状态

/** name → client（懒启动的常驻连接）。 */
const clients = new Map();

let nextRequestId = 1;

export function normalizeMcpServers(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [name, v] of Object.entries(raw).slice(0, 30)) {
    const key = String(name).trim();
    if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) continue; // 会进工具名，收紧
    if (!v || typeof v.command !== 'string' || !v.command.trim()) continue;
    out[key] = {
      command: v.command.trim(),
      args: Array.isArray(v.args) ? v.args.slice(0, 20).map(String) : [],
      ...(v.env && typeof v.env === 'object' && !Array.isArray(v.env)
        ? {
            env: Object.fromEntries(
              Object.entries(v.env)
                .slice(0, 20)
                .map(([k, val]) => [String(k), String(val)])
            )
          }
        : {})
    };
  }
  return out;
}

function serverDef(cfg, name) {
  return normalizeMcpServers(cfg?.mcpServers)[name] ?? null;
}

// ---------------------------------------------------------------- 传输

class McpConnection {
  constructor(name, def) {
    this.name = name;
    this.def = def;
    this.proc = null;
    this.pending = new Map(); // id → {resolve, reject, timer}
    this.buffer = '';
    this.tools = null; // 缓存的 tools/list 结果
    this.toolNames = null; // 缓存的工具名（不触网的快速视图）
    this.idleTimer = null;
    this.stderrTail = '';
    this.starting = null; // 进行中的握手 Promise（并发去重）
  }

  /** 起进程 + 握手。并发调用共享同一次握手。 */
  start() {
    if (this.starting) return this.starting;
    this.starting = this.#startImpl().catch((e) => {
      this.stop();
      throw e;
    });
    return this.starting;
  }

  async #startImpl() {
    const proc = spawn(this.def.command, this.def.args ?? [], {
      cwd: undefined,
      env: buildChildEnv(process.env, this.def.env ?? {}),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.proc = proc;

    proc.stderr.on('data', (chunk) => {
      // 只留尾部用于报错；MCP 服务器常把日志打 stderr，别让它们进工具输出
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-2000);
    });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this.#onData(chunk));
    // spawn 失败（ENOENT 等）只发 error 事件：不监听会把宿主进程整个崩掉
    proc.on('error', (err) => {
      this.proc = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err instanceof Error ? err : new Error(String(err)));
      }
      this.pending.clear();
    });
    proc.on('exit', (code) => {
      this.proc = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP 服务器 "${this.name}" 已退出（code ${code}）`));
      }
      this.pending.clear();
    });

    const exitDuringStart = new Promise((_, reject) => {
      proc.once('exit', (code) =>
        reject(new Error(`MCP 服务器 "${this.name}" 启动即退出（code ${code}）`))
      );
      // spawn 本身失败（命令不存在等）不发 exit，只发 error —— 必须一起竞速，
      // 否则握手会等到超时才报错（而真实原因早就在 error 事件里了）
      proc.once('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
    });

    const handshake = (async () => {
      await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO
      }, START_TIMEOUT_MS);
      // 初始化完成通知：无 id，服务器不回包
      this.notify('notifications/initialized', {});
      const list = await this.request('tools/list', {}, START_TIMEOUT_MS);
      this.tools = Array.isArray(list?.tools) ? list.tools : [];
      this.toolNames = this.tools.map((t) => String(t.name));
    })();

    await Promise.race([handshake, exitDuringStart]);
    this.keepAlive();
  }

  #onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 非 JSON 行（有些服务器往 stdout 打日志）—— 忽略
      }
      if (msg?.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          p.reject(new Error(`MCP 错误 ${msg.error.code}：${msg.error.message ?? '未知'}`));
        } else {
          p.resolve(msg.result);
        }
      }
      // 通知/请求类消息（无 id 或非 pending）静默忽略 —— 我们不做 sampling 等
    }
  }

  request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.proc) throw new Error(`MCP 服务器 "${this.name}" 未启动`);
    const id = nextRequestId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时（${method}，${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(payload);
    });
  }

  notify(method, params) {
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  /** 手动喂狗：有任何成功交互就把空闲回收计时重置。 */
  keepAlive() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_SHUTDOWN_MS);
    this.idleTimer.unref?.();
  }

  stop() {
    clearTimeout(this.idleTimer);
    if (this.proc) {
      try {
        this.proc.kill();
      } catch { /* 已退出 */ }
      this.proc = null;
    }
    clients.delete(this.name);
  }
}

/** 按配置取（并按需启动）一台服务器的连接。 */
async function connect(cfg, name, { timeoutMs = START_TIMEOUT_MS } = {}) {
  const def = serverDef(cfg, name);
  if (!def) throw new Error(`没有名为 "${name}" 的 MCP 服务器配置`);
  let conn = clients.get(name);
  if (!conn || !conn.proc) {
    conn = new McpConnection(name, def);
    clients.set(name, conn);
  }
  if (!conn.tools) {
    await Promise.race([
      conn.start(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`MCP 服务器 "${name}" 握手超时（${timeoutMs}ms）`)), timeoutMs)
      )
    ]);
  }
  conn.keepAlive();
  return conn;
}

/** 进程退出时回收所有 MCP 子进程。 */
export function stopAllMcpClients() {
  for (const conn of [...clients.values()]) conn.stop();
}

/** 按名停掉一台服务器的常驻连接（配置变更后调用，让下次握手用新配置）。 */
export function stopMcpClient(name) {
  const conn = clients.get(name);
  if (conn) conn.stop();
}
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(sig, () => stopAllMcpClients());
}

// ---------------------------------------------------------------- 工具桥接

function sanitizeToolSegment(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'tool';
}

function summarizeCallResult(result, limit) {
  // MCP 的调用结果：{ content: [{type:'text',text}|{type:'resource',...}|...], isError? }
  const content = Array.isArray(result?.content) ? result.content : [];
  const parts = [];
  let hadImage = false;
  let hadResource = false;
  for (const c of content) {
    if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c?.type === 'image') hadImage = true;
    else hadResource = true;
  }
  let text = parts.join('\n').trim();
  if (!text && hadImage) text = '（返回了一张图片 —— 当前会话不支持把 MCP 图片转为输入，可让服务器改返回文本）';
  if (!text && hadResource) text = '（返回了非文本内容，无法在此展示）';
  if (!text) text = '（服务器返回了空内容）';
  if (text.length > limit) text = `${text.slice(0, limit)}\n…（截断，共 ${text.length} 字符）`;
  if (result?.isError) text = `工具执行失败（服务器标记 isError）：\n${text}`;
  return text;
}

/**
 * 从配置构建 MCP 工具集。逐台服务器联系（并行、各自短超时）拉 tools/list；
 * 联系失败的服务器跳过并在结果里留下原因 —— 不让一台挂掉拖死整轮。
 *
 * @returns {Promise<Array<{name,description,parameters,execute}>>}
 */
export async function buildMcpTools(cfg, { timeoutMs = 8000 } = {}) {
  const servers = normalizeMcpServers(cfg?.mcpServers);
  const out = [];
  await Promise.all(
    Object.entries(servers).map(async ([name, def]) => {
      try {
        const conn = await connect(cfg, name, { timeoutMs });
        for (const t of conn.tools ?? []) {
          if (!t?.name) continue;
          const toolName = `mcp__${sanitizeToolSegment(name)}__${sanitizeToolSegment(t.name)}`;
          const schema =
            t.inputSchema && t.inputSchema.type === 'object'
              ? t.inputSchema
              : { type: 'object', properties: {} };
          out.push({
            name: toolName,
            description: `[MCP:${name}] ${t.description || t.name}`,
            parameters: schema,
            async execute(args, ctx = {}) {
              const limit = ctx?.toolOutputLimit ?? 6000;
              try {
                const conn2 = await connect(cfg, name);
                const result = await conn2.request('tools/call', {
                  name: t.name,
                  arguments: args ?? {}
                });
                return summarizeCallResult(result, limit);
              } catch (e) {
                const tail = conn?.stderrTail?.split('\n').filter(Boolean).slice(-3).join('\n');
                return (
                  `MCP 工具调用失败（${name}.${t.name}）：${e?.message || e}` +
                  (tail ? `\n服务器 stderr 尾部：\n${tail}` : '')
                );
              }
            }
          });
        }
      } catch (e) {
        // 单台服务器不可用：跳过。留一条状态查询的口子（mcpStatus）能看到原因。
        out.push({
          name: `mcp__${sanitizeToolSegment(name)}__unavailable`,
          description: `[MCP:${name}] 服务器不可用：${e?.message || e}。请检查配置或服务器进程，不要反复尝试调用。`,
          parameters: { type: 'object', properties: {} },
          async execute() {
            return `[MCP:${name}] 服务器当前不可用：${e?.message || e}`;
          }
        });
      }
    })
  );
  return out;
}

/** 各服务器的实时状态（设置页/排查用，不进模型上下文）。 */
export async function mcpStatus(cfg, { timeoutMs = 8000 } = {}) {
  const servers = normalizeMcpServers(cfg?.mcpServers);
  return Promise.all(
    Object.entries(servers).map(async ([name, def]) => {
      try {
        const conn = await connect(cfg, name, { timeoutMs });
        return {
          name,
          command: def.command,
          args: def.args ?? [],
          status: 'ok',
          tools: conn.toolNames ?? []
        };
      } catch (e) {
        const conn = clients.get(name);
        const tail = conn?.stderrTail?.split('\n').filter(Boolean).slice(-3).join('\n');
        return { name, command: def.command, args: def.args ?? [], status: 'error', error: e?.message || String(e), stderrTail: tail || null, tools: [] };
      }
    })
  );
}
