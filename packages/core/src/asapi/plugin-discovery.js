import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { fetchPublicHTTPS, publicURL } from './catalog-public-https.js';

export class DesktopPluginError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const registries = {
  npm: { origin: 'https://registry.npmjs.org', hosts: new Set(['registry.npmjs.org']) },
  mirror: { origin: 'https://registry.npmmirror.com', hosts: new Set(['registry.npmmirror.com', 'cdn.npmmirror.com']) },
};
const trustedIndexHosts = new Set(['raw.githubusercontent.com', 'cdn.jsdelivr.net', 'unpkg.com']);

export async function downloadBytes(url, fetcher, limit, redirectHosts) {
  const signal = AbortSignal.timeout(12000);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetcher(url, { redirect: redirectHosts ? 'manual' : 'error', credentials: 'omit', signal });
      if (!response.ok && redirectHosts && [301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');
        if (!location) break;
        const next = new URL(location, url);
        if (!validDownloadHost(next, redirectHosts)) break;
        url = next.href;
        continue;
      }
      if (!response.ok || !response.body) {
        void response.body?.cancel().catch(() => {});
        break;
      }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) throw new DesktopPluginError('manifestTooLarge');
          chunks.push(value);
        }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return Buffer.concat(chunks, size);
    }
  } catch (error) {
    if (error instanceof DesktopPluginError) throw error;
  }
  throw new DesktopPluginError('sourceUnavailable');
}

function validDownloadHost(url, hosts) {
  return url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash && hosts.has(url.hostname);
}

export function npmSpecifier(value, registry = 'npm') {
  const match = typeof value === 'string' && value.length <= 250 && /^((?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*)(?:@([a-zA-Z0-9][a-zA-Z0-9._+-]*))?$/.exec(value.trim());
  if (!match || !Object.hasOwn(registries, registry)) throw new DesktopPluginError('invalidSource');
  return { spec: value.trim(), packageName: match[1], tag: match[2] ?? 'latest', registry };
}

function verifyPackage(bytes, info) {
  const match = typeof info?.integrity === 'string' && /^(sha512|sha384|sha256)-([a-zA-Z0-9+/]+=*)(?:\s|$)/.exec(info.integrity);
  if (match) return createHash(match[1]).update(bytes).digest('base64') === match[2];
  return typeof info?.shasum === 'string' && /^[a-f0-9]{40}$/i.test(info.shasum)
    && createHash('sha1').update(bytes).digest('hex') === info.shasum.toLowerCase();
}

function manifestFromTarball(bytes) {
  let archive;
  try { archive = gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }); }
  catch { throw new DesktopPluginError('invalidManifest'); }
  let content;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const name = archive.toString('utf8', offset, offset + 100).split('\0', 1)[0];
    if (!name) break;
    const sizeText = archive.toString('ascii', offset + 124, offset + 136).replace(/\0/g, '').trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new DesktopPluginError('invalidManifest');
    const size = Number.parseInt(sizeText, 8);
    const body = offset + 512;
    if (body + size > archive.length) throw new DesktopPluginError('invalidManifest');
    const type = archive[offset + 156];
    if (name === 'package/tora.plugin.json') {
      if (content !== undefined || (type !== 0 && type !== 48)) throw new DesktopPluginError('invalidManifest');
      if (size > 256 * 1024) throw new DesktopPluginError('manifestTooLarge');
      content = archive.toString('utf8', body, body + size);
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  if (content === undefined) throw new DesktopPluginError('missingPackageManifest');
  return content;
}

export async function readNpmPlugin({ spec, registry }, fetcher) {
  const request = npmSpecifier(spec, registry);
  const selected = registries[request.registry];
  const metadata = await downloadBytes(`${selected.origin}/${encodeURIComponent(request.packageName)}/${encodeURIComponent(request.tag)}`, fetcher, 1024 * 1024);
  let info, tarball;
  try {
    info = JSON.parse(metadata.toString('utf8'));
    tarball = new URL(info.dist.tarball);
  } catch { throw new DesktopPluginError('sourceUnavailable'); }
  if (info.name !== request.packageName || typeof info.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(info.version)
    || !validDownloadHost(tarball, selected.hosts)) throw new DesktopPluginError('sourceUnavailable');
  const bytes = await downloadBytes(tarball.href, fetcher, 12 * 1024 * 1024, selected.hosts);
  if (!verifyPackage(bytes, info.dist)) throw new DesktopPluginError('packageIntegrity');
  return { content: manifestFromTarball(bytes), source: { type: 'npm', spec: request.spec, registry: request.registry, version: info.version } };
}

function indexURL(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) throw new Error();
    const url = publicURL(value);
    if (url.hash || url.search) throw new Error();
    return url;
  } catch { throw new DesktopPluginError('invalidIndex'); }
}

function stringField(value, limit, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw new DesktopPluginError('invalidIndex');
  return value.trim();
}

function validateIndex(bytes, normalizeGithub) {
  let raw;
  try { raw = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new DesktopPluginError('invalidIndex'); }
  if (raw?.schemaVersion !== 1 || !Array.isArray(raw.plugins) || raw.plugins.length > 200) throw new DesktopPluginError('invalidIndex');
  const ids = new Set();
  const plugins = raw.plugins.map(entry => {
    const id = stringField(entry?.id, 48, true);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ids.has(id)) throw new DesktopPluginError('invalidIndex');
    ids.add(id);
    const item = entry.source;
    let source;
    if (item?.type === 'github') source = { type: 'github', url: normalizeGithub(item.url) };
    else if (item?.type === 'npm') {
      const npm = npmSpecifier(item.spec, item.registry);
      source = { type: 'npm', spec: npm.spec, registry: npm.registry };
    } else throw new DesktopPluginError('invalidIndex');
    return { id, source, name: stringField(entry.name, 100, true), description: stringField(entry.description, 900), category: stringField(entry.category, 80), version: stringField(entry.version, 80) };
  });
  return { name: stringField(raw.name, 100, true), plugins };
}

export function createPluginIndexes({ directory, fetcher, normalizeGithub, publicFetcher = fetchPublicHTTPS }) {
  const path = join(directory, 'desktop-plugin-indexes.json');

  function list() {
    try {
      const entries = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(entries) || entries.length > 12) throw new Error();
      return entries.map(entry => ({ url: indexURL(entry.url).href, name: stringField(entry.name, 100, true) }));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new DesktopPluginError('registryUnavailable');
    }
  }

  function save(entries) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    } catch { throw new DesktopPluginError('writeFailed'); }
    finally { try { rmSync(temporary, { force: true }); } catch { /* Best-effort cleanup. */ } }
  }

  async function read(url) {
    const bytes = await downloadBytes(url.href, trustedIndexHosts.has(url.hostname) ? fetcher : publicFetcher, 512 * 1024);
    return validateIndex(bytes, normalizeGithub);
  }

  return {
    list,
    async add(value, allowed = () => true) {
      const url = indexURL(value);
      const index = await read(url);
      if (!allowed()) throw new DesktopPluginError('unavailable');
      const entries = list().filter(entry => entry.url !== url.href);
      if (entries.length >= 12) throw new DesktopPluginError('pluginLimit');
      const entry = { url: url.href, name: index.name };
      save([...entries, entry]);
      return entry;
    },
    async catalog(value) {
      const url = indexURL(value);
      if (!list().some(entry => entry.url === url.href)) throw new DesktopPluginError('invalidIndex');
      return read(url);
    },
    remove(value) {
      const url = indexURL(value);
      save(list().filter(entry => entry.url !== url.href));
    },
  };
}
