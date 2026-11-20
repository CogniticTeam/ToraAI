import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { TORA_DIR } from '../config.js';
import { buildMcpTools, stopMcpClient } from '../tools/mcp.js';
import { createPluginIndexes, DesktopPluginError, downloadBytes, npmSpecifier, readNpmPlugin } from './plugin-discovery.js';

export { DesktopPluginError };

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PLUGINS = 32;
const REVIEW_TTL = 15 * 60 * 1000;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
const SKILL_PREFIX = 'desktop-plugin:';

const demo = {
  schemaVersion: 1,
  id: 'workspace-handoff',
  name: 'Workspace Handoff',
  version: '1.0.0',
  author: 'Tora',
  description: 'Turn the conversation into a handoff with decisions, completed work and follow-up tasks.',
  skills: [{
    name: 'handoff',
    description: 'Summarize the current work for a teammate.',
    markdown: 'Write a concise handoff in the user’s language. Record confirmed decisions, completed work and verification, then list open questions and the next concrete action. Mark unverified claims clearly.',
  }],
  commands: [{
    name: 'recap',
    description: 'Insert a prompt for a handoff summary.',
    body: 'Summarize this conversation for a teammate. Include completed work, open questions, and the next action.',
  }],
};

function requireValue(condition, code = 'invalidManifest') {
  if (!condition) throw new DesktopPluginError(code);
}

function objectWithKeys(value, keys) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)));
}

function text(value, max, pattern = null) {
  requireValue(typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0') && (!pattern || pattern.test(value)));
  return value.trim();
}

function entries(value = [], limit, parse) {
  requireValue(Array.isArray(value) && value.length <= limit);
  const result = value.map(parse);
  requireValue(new Set(result.map(entry => entry.name)).size === result.length);
  return result;
}

function parseManifest(raw) {
  objectWithKeys(raw, ['schemaVersion', 'id', 'name', 'version', 'author', 'description', 'skills', 'commands', 'mcpServers']);
  requireValue(raw.schemaVersion === 1, 'unsupportedManifest');
  const skills = entries(raw.skills, 12, skill => {
    objectWithKeys(skill, ['name', 'description', 'markdown']);
    return { name: text(skill.name, 40, SLUG), description: text(skill.description, 500), markdown: text(skill.markdown, 24000) };
  });
  const commands = entries(raw.commands, 12, command => {
    objectWithKeys(command, ['name', 'description', 'body', 'argumentHint']);
    return {
      name: text(command.name, 40, SLUG), description: text(command.description, 500), body: text(command.body, 12000),
      ...(command.argumentHint === undefined ? {} : { argumentHint: text(command.argumentHint, 120) }),
    };
  });
  const mcpServers = entries(raw.mcpServers, 4, server => {
    objectWithKeys(server, ['name', 'command', 'args']);
    requireValue(server.args === undefined || (Array.isArray(server.args) && server.args.length <= 20));
    const args = (server.args ?? []).map(arg => {
      requireValue(typeof arg === 'string' && arg.length <= 2000 && !/[\p{Cc}\p{Cf}]/u.test(arg));
      return arg;
    });
    return { name: text(server.name, 32, SLUG), command: text(server.command, 1024, /^[^\p{Cc}\p{Cf}]+$/u), args };
  });
  requireValue(skills.length + commands.length + mcpServers.length > 0);
  return {
    schemaVersion: 1, id: text(raw.id, 48, SLUG), name: text(raw.name, 100), version: text(raw.version, 80, VERSION),
    author: raw.author === undefined ? null : text(raw.author, 100), description: text(raw.description, 900),
    skills, commands, mcpServers,
  };
}

function manifestFromText(value) {
  requireValue(typeof value === 'string', 'invalidManifest');
  requireValue(Buffer.byteLength(value, 'utf8') <= MAX_MANIFEST_BYTES, 'manifestTooLarge');
  let raw;
  try { raw = JSON.parse(value.replace(/^\uFEFF/, '')); }
  catch { throw new DesktopPluginError('invalidJson'); }
  return parseManifest(raw);
}

function githubManifestUrl(input) {
  requireValue(typeof input === 'string' && input.length <= 2048, 'invalidSource');
  let url;
  try { url = new URL(input); } catch { throw new DesktopPluginError('invalidSource'); }
  requireValue(url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search && !url.hash, 'invalidSource');
  const parts = url.pathname.replace(/^\/|\/$/g, '').split('/');
  requireValue(parts.every(part => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..'), 'invalidSource');
  if (url.hostname === 'github.com') {
    if (parts.length === 2) parts.push('HEAD', 'tora.plugin.json');
    else requireValue(parts.length >= 5 && parts.splice(2, 1)[0] === 'blob', 'invalidSource');
  } else requireValue(url.hostname === 'raw.githubusercontent.com', 'invalidSource');
  requireValue(parts.length >= 4 && parts.at(-1) === 'tora.plugin.json', 'invalidSource');
  return `https://raw.githubusercontent.com/${parts.join('/')}`;
}

async function readRemoteManifest(url, fetcher) {
  return manifestFromText((await downloadBytes(url, fetcher, MAX_MANIFEST_BYTES)).toString('utf8'));
}

const digest = value => createHash('sha256').update(value).digest('hex');
const skillId = (record, skill) => `${SKILL_PREFIX}${record.manifest.id}:${record.revision.slice(0, 16)}:${skill.name}`;
const mcpScope = record => `${record.manifest.id}:${record.activation}`;
const mcpName = (record, server) => `tp_${digest(`${record.manifest.id}:${server.name}`).slice(0, 16)}`;

function stopPluginMcp(record) {
  for (const server of record.manifest.mcpServers) stopMcpClient(mcpName(record, server), { scope: mcpScope(record) });
}

function view({ manifest, source, revision, activation }) {
  const { skills, commands, ...info } = manifest;
  return {
    ...info, source, revision, enabled: Boolean(activation),
    skills: skills.map(({ name, description }) => ({ name, description })),
    commands: commands.map(({ name, description }) => ({ name, description })),
  };
}

export function createDesktopPluginRegistry({ directory = TORA_DIR, fetcher = fetch, publicFetcher } = {}) {
  const file = join(directory, 'desktop-plugins.json');
  const indexes = createPluginIndexes({ directory, fetcher, normalizeGithub: githubManifestUrl, publicFetcher });
  const reviews = new Map();
  let records;

  function all() {
    if (records) return records;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      requireValue(data?.schemaVersion === 1 && Array.isArray(data.plugins) && data.plugins.length <= MAX_PLUGINS);
      const restored = new Map(data.plugins.map(record => {
        const manifest = parseManifest({ ...record.manifest, author: record.manifest?.author ?? undefined });
        const { source } = record;
        requireValue(source?.type === 'catalog' || (source?.type === 'file' && typeof source.label === 'string')
          || (source?.type === 'github' && typeof source.url === 'string' && githubManifestUrl(source.url) === source.url)
          || (source?.type === 'npm' && npmSpecifier(source.spec, source.registry).spec === source.spec && VERSION.test(source.version || '')));
        const revision = digest(JSON.stringify({ manifest, source }));
        requireValue(record.revision === revision && (record.activation === null || typeof record.activation === 'string'));
        return [manifest.id, { ...record, manifest }];
      }));
      requireValue(restored.size === data.plugins.length);
      records = restored;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new DesktopPluginError('registryUnavailable');
      records = new Map();
    }
    return records;
  }

  function save(id, record) {
    const next = new Map(all());
    const old = next.get(id);
    if (record) next.set(id, record);
    else next.delete(id);
    requireValue(next.size <= MAX_PLUGINS, 'pluginLimit');
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, plugins: [...next.values()] }), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
    } catch {
      throw new DesktopPluginError('writeFailed');
    } finally {
      try { rmSync(temporary, { force: true }); } catch { /* Best-effort temporary-file cleanup. */ }
    }
    records = next;
    if (old?.activation && old.activation !== record?.activation) stopPluginMcp(old);
  }

  function checked(id, revision) {
    const record = all().get(id);
    requireValue(record && record.revision === revision, 'pluginChanged');
    return record;
  }

  function active() {
    try { return [...all().values()].filter(record => record.activation); }
    catch { return []; }
  }

  return {
    list: () => [...all().values()].map(view),
    inspect: (id, revision) => view(checked(id, revision)),
    stopMcp: () => active().forEach(stopPluginMcp),
    indexes,

    async preview(input) {
      let manifest, source;
      if (input?.type === 'file') {
        manifest = manifestFromText(input.content);
        const label = typeof input.label === 'string' ? input.label.split(/[/\\]/).at(-1).slice(0, 120) : '';
        source = { type: 'file', label: label || 'tora.plugin.json' };
      } else if (input?.type === 'github') {
        const url = githubManifestUrl(input.url);
        manifest = await readRemoteManifest(url, fetcher);
        source = { type: 'github', url };
      } else if (input?.type === 'npm') {
        const downloaded = await readNpmPlugin(input, fetcher);
        manifest = manifestFromText(downloaded.content);
        source = downloaded.source;
      } else {
        requireValue(input?.type === 'catalog', 'invalidSource');
        manifest = parseManifest(demo);
        source = { type: 'catalog' };
      }
      requireValue(input.expectedId === undefined || input.expectedId === manifest.id, 'sourceChanged');
      const previous = all().get(manifest.id);
      const revision = digest(JSON.stringify({ manifest, source }));
      if (previous?.revision === revision) return { reviewId: null, manifest, source, previous: view(previous) };
      const reviewId = randomUUID();
      const now = Date.now();
      for (const [key, review] of reviews) if (review.expiry <= now) reviews.delete(key);
      if (reviews.size >= 12) reviews.delete(reviews.keys().next().value);
      reviews.set(reviewId, { record: { manifest, source, revision, activation: null }, previous: previous?.revision, expiry: now + REVIEW_TTL });
      return { reviewId, manifest, source, previous: previous ? view(previous) : null };
    },

    install(reviewId) {
      const review = reviews.get(reviewId);
      requireValue(review && review.expiry > Date.now(), 'reviewExpired');
      const { record } = review;
      const { id } = record.manifest;
      requireValue(all().get(id)?.revision === review.previous, 'pluginChanged');
      save(id, record);
      reviews.delete(reviewId);
      return view(record);
    },

    setEnabled(id, revision, enabled) {
      requireValue(typeof enabled === 'boolean', 'invalidRequest');
      const record = checked(id, revision);
      if (Boolean(record.activation) === enabled) return view(record);
      const activeServers = active().reduce((count, plugin) => count + plugin.manifest.mcpServers.length, 0);
      requireValue(!enabled || activeServers + record.manifest.mcpServers.length <= 30, 'mcpLimit');
      const updated = { ...record, activation: enabled ? randomUUID() : null };
      save(id, updated);
      return view(updated);
    },

    remove(id, revision) {
      checked(id, revision);
      save(id, null);
    },

    contributions() {
      const plugins = active();
      return {
        skills: plugins.flatMap(record => record.manifest.skills.map(skill => ({
          id: skillId(record, skill), name: `${record.manifest.id}:${skill.name}`, enabled: true,
          display_name: skill.name, description: skill.description, tags: [record.manifest.name],
          author: record.manifest.author, icon_url: null, url: null, hub_id: null, card_id: null, version: record.manifest.version,
        }))),
        commands: plugins.flatMap(({ manifest }) => manifest.commands.map(command => ({
          name: `${manifest.id}:${command.name}`, description: command.description, body: command.body,
          argument_hint: command.argumentHint, source: 'plugin',
        }))),
      };
    },

    skillContext(ids) {
      const selected = [...new Set(ids.filter(id => typeof id === 'string' && id.startsWith(SKILL_PREFIX)))];
      if (!selected.length) return '';
      requireValue(selected.length <= 12, 'skillLimit');
      const available = new Map(active().flatMap(record => record.manifest.skills.map(skill => [
        skillId(record, skill), `### ${record.manifest.id}:${skill.name}\n\n${skill.markdown}`,
      ])));
      requireValue(selected.every(id => available.has(id)), 'pluginSkillUnavailable');
      return `[Selected plugin skills]\n\n${selected.map(id => available.get(id)).join('\n\n---\n\n')}`;
    },

    async mcpTools(signal) {
      const groups = await Promise.all(active().filter(record => record.manifest.mcpServers.length).map(async record => {
        const { id, name, mcpServers } = record.manifest;
        const current = () => all().get(id)?.activation === record.activation;
        const defs = Object.fromEntries(mcpServers.map(server => [mcpName(record, server), { command: server.command, args: server.args }]));
        const tools = await buildMcpTools({ mcpServers: defs }, { scope: mcpScope(record), signal });
        if (!current()) return [];
        return tools.map(tool => ({
          ...tool,
          name: tool.name.length <= 64 ? tool.name : `${tool.name.slice(0, 51)}_${digest(tool.name).slice(0, 12)}`,
          description: `[Plugin ${name}] ${tool.description}`,
          execute(args, context) {
            if (!current()) return { ok: false, text: `Plugin ${id} is disabled or has changed.`, meta: { failure: { kind: 'plugin-disabled', retryable: false } } };
            return tool.execute(args, context);
          },
        }));
      }));
      return groups.flat();
    },
  };
}
