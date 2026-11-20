// MCP 工坊：把现有 MCP 配置（~/.tora/config.json 的 mcpServers）包装成
// 可视化管理能力 —— 增删改服务器、探测连接、试调工具、预设模板。
//
// 底层复用 tools/mcp.js 的 stdio 和 Streamable HTTP 客户端。
//
// 与 /mcp/servers（全局探测）的区别：工坊按**单台**操作，并提供工具调用。

import { loadConfig, saveConfig } from '../config.js';
import { buildMcpTools, invalidateChangedMcpClients, mcpStatus, normalizeMcpApplication, normalizeMcpServers } from './mcp.js';
import { McpHttpConnection, normalizeMcpEndpoint, normalizeMcpHeaders } from './mcp-http.js';

const GITHUB_SERVER = 'github-app';
const GITHUB_URL = 'https://api.githubcopilot.com/mcp/';

// ---------------------------------------------------------------- 预设模板
// 只是命令/参数提示，点一下填表，不会自动安装。覆盖常见的官方/知名服务器。
const TEMPLATES = [
  {
    id: 'fetch',
    name: 'fetch',
    description: 'HTTP 抓取（官方示例）',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    env: {},
  },
  {
    id: 'filesystem',
    name: 'filesystem',
    description: '本地文件系统读写（官方）',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/dir'],
    env: {},
  },
  {
    id: 'github',
    name: 'github',
    description: 'GitHub 操作（旧版，本机）',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
  },
  {
    id: 'sequential-thinking',
    name: 'sequential-thinking',
    description: '顺序思维链推理',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    env: {},
  },
  {
    id: 'time',
    name: 'time',
    description: '获取当前时间',
    command: 'uvx',
    args: ['mcp-server-time'],
    env: {},
  },
  {
    id: 'brave-search',
    name: 'brave-search',
    description: 'Brave 搜索引擎',
    command: 'npx',
    args: ['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio'],
    env: { BRAVE_API_KEY: '' },
  },
  {
    id: 'memory',
    name: 'memory',
    description: '官方 MCP Memory 服务器',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: {},
  },
  {
    id: 'microsoft-learn',
    name: 'microsoft-learn',
    description: 'Microsoft Learn',
    url: 'https://learn.microsoft.com/api/mcp',
    command: '',
    args: [],
    env: {},
  },
  {
    id: 'custom',
    name: 'custom',
    description: '自定义命令',
    command: '',
    args: [],
    env: {},
  },
];

// ---------------------------------------------------------------- CRUD

export function listServers() {
  const cfg = loadConfig();
  const servers = normalizeMcpServers(cfg.mcpServers);
  return Object.entries(servers).map(([name, def]) => serverView(name, def));
}

function serverView(name, { command, args, env, url, headers, enabled, application }) {
  return {
    name, command: command ?? '', args: args ?? [], envKeys: Object.keys(env ?? {}), enabled: enabled !== false, application: application ?? null,
    ...(url ? { url, headerKeys: Object.keys(headers ?? {}), ...(name === GITHUB_SERVER && url === GITHUB_URL && headers?.authorization ? { provider: 'github' } : {}) } : {}),
  };
}

function validateName(name) {
  const key = typeof name === 'string' ? name.trim() : '';
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error('名称只能包含字母、数字、下划线、连字符');
  return key;
}

function findServer(servers, key) {
  if (!Object.hasOwn(servers, key)) throw Object.assign(new Error(`服务器 "${key}" 不存在`), { status: 404 });
  return servers[key];
}

function checkedDefinition(key, def) {
  if (def.enabled !== undefined && typeof def.enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
  if (def.application != null && !normalizeMcpApplication(def.application)) throw new Error('应用名称、说明或网址无效');
  const normalized = Object.values(normalizeMcpServers({ [key]: def }))[0];
  if (!normalized) throw new Error('MCP 启动命令、地址或请求头无效');
  return normalized;
}

function writeMcpServers(before, after) {
  saveConfig({ mcpServers: after });
  invalidateChangedMcpClients(before, after);
}

export function addServer(name, def) {
  const key = validateName(name);
  const normalized = checkedDefinition(key, def);
  const before = normalizeMcpServers(loadConfig().mcpServers);
  if (Object.hasOwn(before, key)) throw new Error(`服务器 "${key}" 已存在`);
  if (Object.keys(before).length >= 30) throw new Error('MCP 服务器数量已达上限');
  writeMcpServers(before, { ...before, [key]: normalized });
  return serverView(key, normalized);
}

export function updateServer(name, patch) {
  const key = validateName(name);
  const before = normalizeMcpServers(loadConfig().mcpServers);
  const existing = findServer(before, key);
  const { envPatch, headerPatch, ...updates } = patch ?? {};
  const merged = { ...existing, ...updates };
  if (updates.url !== undefined) {
    delete merged.command;
    delete merged.args;
    delete merged.env;
    if (normalizeMcpEndpoint(updates.url) !== existing.url) merged.headers = updates.headers ?? {};
  } else if (updates.command !== undefined) {
    delete merged.url;
    delete merged.headers;
  }
  if (headerPatch !== undefined) {
    const headers = normalizeMcpHeaders(headerPatch);
    if (!merged.url || !headers) throw new Error('MCP 请求头无效');
    merged.headers = { ...merged.headers, ...headers };
  }
  if (envPatch && typeof envPatch === 'object' && !Array.isArray(envPatch)) {
    merged.env = { ...merged.env, ...envPatch };
    if (Object.keys(merged.env).length > 20) throw new Error('MCP 环境变量数量已达上限');
  }
  const normalized = checkedDefinition(key, merged);
  writeMcpServers(before, { ...before, [key]: normalized });
  return serverView(key, normalized);
}

export function removeServer(name) {
  const key = validateName(name);
  const before = normalizeMcpServers(loadConfig().mcpServers);
  findServer(before, key);
  const next = { ...before };
  delete next[key];
  writeMcpServers(before, next);
}

export function importServers(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 128 * 1024) throw new Error('MCP JSON 超过大小限制');
  let raw;
  try { raw = JSON.parse(content.replace(/^\uFEFF/, '')); }
  catch { throw new Error('请输入有效的 MCP JSON'); }
  const servers = raw?.mcpServers ?? raw?.servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('需要 mcpServers 或 servers 配置');
  const entries = Object.entries(servers);
  const before = normalizeMcpServers(loadConfig().mcpServers);
  if (!entries.length || entries.length + Object.keys(before).length > 30) throw new Error('MCP 服务器数量超出范围');
  const occupied = new Set(Object.keys(before));
  const imported = entries.map(([name, definition]) => {
    const key = validateName(name);
    if (occupied.has(key)) throw Object.assign(new Error(`服务器 "${key}" 已存在`), { status: 409 });
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error(`服务器 "${key}" 配置无效`);
    const { args, env } = definition;
    if ((args !== undefined && (!Array.isArray(args) || args.length > 20 || args.some(arg => typeof arg !== 'string'))) ||
        (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > 20 || Object.values(env).some(value => typeof value !== 'string')))) {
      throw new Error(`服务器 "${key}" 的参数或环境变量无效`);
    }
    occupied.add(key);
    return [key, checkedDefinition(key, { ...definition, enabled: false })];
  });
  writeMcpServers(before, { ...before, ...Object.fromEntries(imported) });
  return imported.map(([name, def]) => serverView(name, def));
}

export async function connectGithub(token, allowed = () => true) {
  if (typeof token !== 'string' || !/^[\x21-\x7e]{10,2048}$/.test(token)) throw new Error('GitHub 访问令牌格式无效');
  const before = normalizeMcpServers(loadConfig().mcpServers);
  const old = before[GITHUB_SERVER];
  if (old && old.url !== GITHUB_URL) throw Object.assign(new Error('已存在同名 MCP 服务器'), { status: 409 });
  if (!old && Object.keys(before).length >= 30) throw new Error('MCP 服务器数量已达上限');
  const def = {
    url: GITHUB_URL, headers: { authorization: `Bearer ${token}` }, enabled: true,
    application: { name: 'GitHub', description: '', website: 'https://github.com/' },
  };
  const probe = new McpHttpConnection(GITHUB_SERVER, def, () => {});
  try { await probe.start(); }
  finally { probe.stop(); }
  if (!allowed()) throw Object.assign(new Error('授权状态已变更'), { status: 403 });
  const current = normalizeMcpServers(loadConfig().mcpServers);
  if (JSON.stringify(current[GITHUB_SERVER]) !== JSON.stringify(old)) throw Object.assign(new Error('GitHub 配置已变更，请重试'), { status: 409 });
  if (!old && Object.keys(current).length >= 30) throw new Error('MCP 服务器数量已达上限');
  writeMcpServers(current, { ...current, [GITHUB_SERVER]: def });
  return serverView(GITHUB_SERVER, def);
}

export function disconnectGithub() {
  const def = normalizeMcpServers(loadConfig().mcpServers)[GITHUB_SERVER];
  if (def?.url === GITHUB_URL && def.headers?.authorization) removeServer(GITHUB_SERVER);
}

// ---------------------------------------------------------------- 探测 & 调用

/** 探测单台服务器：握手 + tools/list，返回状态与工具列表。 */
export async function probeServer(name) {
  const key = validateName(name);
  const def = findServer(normalizeMcpServers(loadConfig().mcpServers), key);
  const [result] = await mcpStatus({ mcpServers: { [key]: def } }, { timeoutMs: 10000 });
  return result;
}

/** 试调一台服务器的某个工具：返回执行结果文本。 */
export async function callTool(name, tool, args) {
  const key = validateName(name);
  const def = findServer(normalizeMcpServers(loadConfig().mcpServers), key);
  if (def.enabled === false) throw new Error(`MCP 服务器 "${key}" 已停用`);
  // 只构建这一台的工具，避免触及其它服务器
  const tools = await buildMcpTools({ mcpServers: { [key]: def } });
  const target = tools.find((t) => t.name === `mcp__${key}__${tool}`);
  if (!target) throw new Error(`工具 "${tool}" 不存在（先探测一下）`);
  return await target.execute(args ?? {}, { toolOutputLimit: 8000 });
}

export function listTemplates() {
  return TEMPLATES;
}
