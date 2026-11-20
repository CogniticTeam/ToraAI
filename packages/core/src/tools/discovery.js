import { toolRequiresWorkspace } from './registry.js';

const CORE_TOOLS = new Set([
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'AskUserQuestion', 'ToolSearch', 'ToolOutput',
]);
const SEARCH_LIMIT = 4;

/** A run keeps one stable tool prefix and appends selected definitions in place. */
export function createToolDiscovery({ tools, registry, loadIntegrations, context, isReact }) {
  const local = tools.map((tool, index) => ({ tool, definition: registry.definitions[index] }));
  const available = tool => Boolean(context.cwd) || !toolRequiresWorkspace(tool);
  const advertised = new Set();
  const definitions = [];
  let integrationLoad;

  function reveal(entry) {
    if (advertised.has(entry.tool.name)) return;
    advertised.add(entry.tool.name);
    definitions.push(entry.definition);
  }

  async function integrations() {
    integrationLoad ??= Promise.resolve().then(loadIntegrations).then(items => {
      const entries = [];
      for (const tool of (items ?? []).slice().sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        if (!registry.has(tool.name)) entries.push({ tool, definition: registry.register(tool) });
      }
      return entries;
    });
    return integrationLoad;
  }

  const search = {
    name: 'ToolSearch',
    requiresWorkspace: false,
    description: '按名称或关键词发现按需工具，例如 Browser、WebPreview、Task、Memory、Git。搜索启用的 MCP 或自定义工具时使用 scope=integrations。返回可调用的工具，不执行它们。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 120, description: '工具名、工具族、服务器名或简短关键词。用 * 列出首批。' },
        scope: { type: 'string', enum: ['local', 'integrations'], description: '默认 local。integrations 搜索已启用的 MCP 和已信任的自定义工具。' },
      },
      required: ['query'],
    },
    async execute({ query, scope = 'local' }) {
      const term = query.trim().toLowerCase();
      if (!term) return '请输入工具名称或关键词。';
      const candidates = scope === 'integrations' ? await integrations() : local;
      if (context.signal?.aborted) return { ok: false, text: '已中止工具搜索。' };

      const ranked = candidates.map(entry => {
        const name = entry.tool.name.toLowerCase();
        const description = String(entry.tool.description || '').toLowerCase();
        const rank = name === term ? 3 : name.includes(term) ? 2 : term === '*' || description.includes(term) ? 1 : 0;
        return { entry, rank };
      }).filter(({ entry, rank }) => rank > 0 && available(entry.tool))
        .sort((a, b) => b.rank - a.rank || Number(advertised.has(a.entry.tool.name)) - Number(advertised.has(b.entry.tool.name)));
      const matches = ranked[0]?.rank === 3 ? ranked.slice(0, 1) : ranked;
      const found = matches.slice(0, SEARCH_LIMIT);
      if (!found.length) {
        return `没有找到匹配的可用工具。${context.cwd ? '' : '需要访问工作区的工具须先选择工作目录。'}`;
      }
      for (const { entry } of found) reveal(entry);
      const rows = found.map(({ entry: { tool } }) => {
        const schema = isReact() ? `\n参数：${JSON.stringify(tool.parameters ?? {})}` : '';
        return `${tool.name} — ${String(tool.description || '').slice(0, 180)}${schema}`;
      });
      if (matches.length > found.length) rows.push(`另有 ${matches.length - found.length} 项匹配。可以用更具体的名称搜索。`);
      return rows.join('\n');
    },
  };
  // Reserve the discovery name before loading extensions so they cannot shadow it.
  local.push({ tool: search, definition: registry.register(search) });
  for (const entry of local) {
    if (CORE_TOOLS.has(entry.tool.name) && available(entry.tool)) reveal(entry);
  }
  const initialNames = definitions.map(definition => definition.function.name);

  return { definitions, initialNames };
}
