// Text sidecars keep large tool results out of the model history and session JSON.
import {
  closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TORA_DIR } from '../config.js';
import { realpathAllowMissing } from '../security.js';

const ENTRY_BYTES = 1024 * 1024;
const SESSION_BYTES = 32 * ENTRY_BYTES;
const ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

function directory(sessionId, create = false) {
  if (typeof sessionId !== 'string' || !/^[\w-]{1,128}$/.test(sessionId)) throw new Error('非法会话 ID');
  if (create) mkdirSync(TORA_DIR, { recursive: true, mode: 0o700 });
  const root = join(realpathSync(TORA_DIR), 'asapi', 'tool-outputs');
  const dir = join(root, sessionId);
  if (realpathAllowMissing(dir) !== dir) throw new Error('工具输出目录不能重定向');
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function readOutput(sessionId, id) {
  if (typeof id !== 'string' || !ID.test(id)) return null;
  let fd;
  try {
    const path = join(directory(sessionId), id);
    if (realpathSync(path) !== path) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > ENTRY_BYTES) return null;
    return readFileSync(fd, 'utf8');
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function sessionToolOutputs(sessionId) {
  let usedBytes;
  return {
    read: id => readOutput(sessionId, id),
    save(text) {
      const bytes = Buffer.byteLength(text);
      if (bytes > ENTRY_BYTES) return null;
      const dir = directory(sessionId, true);
      usedBytes ??= readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => (
        entry.isFile() && ID.test(entry.name) ? sum + statSync(join(dir, entry.name)).size : sum
      ), 0);
      if (usedBytes + bytes > SESSION_BYTES) return null;
      const id = randomUUID();
      writeFileSync(join(dir, id), text, { flag: 'wx', mode: 0o600 });
      usedBytes += bytes;
      return id;
    },
  };
}

export function copySessionToolOutputs(sourceId, targetId, refs) {
  for (const id of refs) {
    const text = readOutput(sourceId, id);
    if (text === null) continue;
    // Copy only referenced, validated text with a private mode on the new file.
    writeFileSync(join(directory(targetId, true), id), text, { flag: 'wx', mode: 0o600 });
  }
}

export function deleteSessionToolOutputs(sessionId) {
  let dir;
  try { dir = directory(sessionId); } catch { return; }
  rmSync(dir, { recursive: true, force: true });
}

export function clearSessionToolOutputs() {
  const root = join(realpathAllowMissing(TORA_DIR), 'asapi', 'tool-outputs');
  if (realpathAllowMissing(root) === root) rmSync(root, { recursive: true, force: true });
}
