import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList } from 'node:net';
import { Readable } from 'node:stream';

const excludedIPv4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) excludedIPv4.addSubnet(network, prefix);
const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');
const excludedIPv6 = new BlockList();
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  excludedIPv6.addSubnet(network, prefix, 'ipv6');
}

function publicAddress({ address, family }) {
  if (family === 4) return !excludedIPv4.check(address);
  return family === 6 && globalIPv6.check(address, 'ipv6') && !excludedIPv6.check(address, 'ipv6');
}

export function publicURL(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !host.includes('.') || host.startsWith('[') || /^(?:\d+\.){3}\d+$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) throw Error('只允许公开 HTTPS 网页');
  return url;
}

export function createPublicHTTPS({ resolve = lookup, connect = request } = {}) {
  return async function fetchPublic(value, options = {}) {
    const url = publicURL(value);
    const { method = 'GET', signal, body } = options;
    signal?.throwIfAborted();
    const addresses = await resolve(url.hostname, { all: true });
    signal?.throwIfAborted();
    if (!addresses.length || addresses.some(answer => !publicAddress(answer))) {
      throw Error('不允许访问本地或私有网络');
    }
    const target = addresses.find(answer => answer.family === 4) ?? addresses[0];
    const headers = new Headers(options.headers);
    headers.set('accept-encoding', 'identity');
    return new Promise((resolveResponse, reject) => {
      const outgoing = connect(url, {
        method, signal, agent: false, family: target.family, headers: Object.fromEntries(headers),
        // Use the validated address for the connection and the URL's hostname for TLS.
        lookup: (_host, settings, callback) => {
          if (settings.all) callback(null, [target]);
          else callback(null, target.address, target.family);
        },
      }, incoming => {
        try {
          const status = incoming.statusCode ?? 502;
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) for (const item of value) headers.append(name, item);
            else if (value !== undefined) headers.set(name, value);
          }
          const withoutBody = method === 'HEAD' || [204, 205, 304].includes(status);
          if (withoutBody) incoming.resume();
          resolveResponse(new Response(withoutBody ? null : Readable.toWeb(incoming), { status, headers }));
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      });
      outgoing.once('error', reject);
      outgoing.end(body);
    });
  };
}

export const fetchPublicHTTPS = createPublicHTTPS();
