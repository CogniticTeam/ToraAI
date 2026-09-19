// MCP 工坊：把现有 MCP 配置（~/.vega/config.json 的 mcpServers）包装成
// 可视化管理能力 —— 增删改服务器、探测连接、试调工具、预设模板。
//
// 底层复用 tools/mcp.js（零依赖 stdio 客户端）。本模块只做配置读写与编排。
//
// 与 /mcp/servers（全局探测）的区别：工坊按**单台**操作，并提供工具调用。

import { loadConfig, saveConfig } from '../config.js';
import { buildMcpTools, mcpStatus, normalizeMcpServers, stopMcpClient } from './mcp.js';

// ---------------------------------------------------------------- 预设模板
// 只是命令/参数提示，点一下填表，不会自动安装。覆盖常见的官方/知名服务器。
const TEMPLATES = [
  {
    id: 'fetch',
    name: 'fetch',
    description: 'HTTP 抓取（官方示例）',
    command: 'npx',
    args: ['-y', 'mcp-server-fetch'],
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
    description: 'GitHub 操作（官方）',
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
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-time'],
    env: {},
  },
  {
    id: 'brave-search',
    name: 'brave-search',
    description: 'Brave 搜索引擎',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
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
  return Object.entries(servers).map(([name, def]) => ({
    name,
    command: def.command,
    args: def.args ?? [],
    envKeys: Object.keys(def.env ?? {}),
  }));
}

function validateName(name) {
  const key = String(name).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error('名称只能包含字母、数字、下划线、连字符');
  return key;
}

function writeMcpServers(map) {
  saveConfig({ mcpServers: map });
}

export function addServer(name, def) {
  const key = validateName(name);
  const normalized = normalizeMcpServers({ [key]: def })[key];
  if (!normalized) throw new Error('command 不能为空');
  const cfg = loadConfig();
  const cur = normalizeMcpServers(cfg.mcpServers);
  if (cur[key]) throw new Error(`服务器 "${key}" 已存在`);
  cur[key] = normalized;
  writeMcpServers(cur);
  return { name: key, ...normalized };
}

export function updateServer(name, patch) {
  const key = validateName(name);
  const cfg = loadConfig();
  const cur = normalizeMcpServers(cfg.mcpServers);
  if (!cur[key]) throw new Error(`服务器 "${key}" 不存在`);
  const merged = { ...cur[key], ...patch };
  const normalized = normalizeMcpServers({ [key]: merged })[key];
  if (!normalized) throw new Error('command 不能为空');
  cur[key] = normalized;
  writeMcpServers(cur);
  stopMcpClient(key); // 配置变了，旧连接作废
  return { name: key, ...normalized };
}

export function removeServer(name) {
  const key = validateName(name);
  const cfg = loadConfig();
  const cur = normalizeMcpServers(cfg.mcpServers);
  if (!cur[key]) throw new Error(`服务器 "${key}" 不存在`);
  delete cur[key];
  writeMcpServers(cur);
  stopMcpClient(key);
}

// ---------------------------------------------------------------- 探测 & 调用

/** 探测单台服务器：握手 + tools/list，返回状态与工具列表。 */
export async function probeServer(name) {
  const key = validateName(name);
  const cfg = loadConfig();
  const cur = normalizeMcpServers(cfg.mcpServers);
  if (!cur[key]) throw new Error(`服务器 "${key}" 不存在`);
  const all = await mcpStatus(cfg, { timeoutMs: 10000 });
  return all.find((s) => s.name === key) ?? null;
}

/** 试调一台服务器的某个工具：返回执行结果文本。 */
export async function callTool(name, tool, args) {
  const key = validateName(name);
  const cfg = loadConfig();
  const cur = normalizeMcpServers(cfg.mcpServers);
  if (!cur[key]) throw new Error(`服务器 "${key}" 不存在`);
  // 只构建这一台的工具，避免触及其它服务器
  const tools = await buildMcpTools({ mcpServers: { [key]: cur[key] } });
  const target = tools.find((t) => t.name === `mcp__${key}__${tool}`);
  if (!target) throw new Error(`工具 "${tool}" 不存在（先探测一下）`);
  return await target.execute(args ?? {}, { toolOutputLimit: 8000 });
}

export function listTemplates() {
  return TEMPLATES;
}
