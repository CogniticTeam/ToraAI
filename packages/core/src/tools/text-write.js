import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { realpathAllowMissing } from '../security.js';

const revision = text => text === null ? null : createHash('sha256').update(text).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function rememberText(versions, path, text) {
  if (versions) versions.set(path, revision(text));
}

function fileStat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function sameFile(before, after) {
  if (!before || !after) return before === after;
  return after.isFile() && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function fileChanged() {
  return Object.assign(new Error('文件已发生变化。请先用 Read 核对最新内容，再保留外部改动继续编辑。'), {
    code: 'FILE_CHANGED',
  });
}

export function loadEditableText(path, versions) {
  const stat = fileStat(path);
  if (stat && !stat.isFile()) throw new Error('只支持编辑普通文本文件');
  let text = null;
  if (stat) {
    try { text = decoder.decode(readFileSync(path)); }
    catch (error) {
      if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') throw Error('只支持编辑 UTF-8 文本文件');
      throw error;
    }
    if (text.includes('\u0000')) throw new Error('只支持编辑文本文件');
    if (!sameFile(stat, fileStat(path))) throw fileChanged();
  }
  if (versions?.has(path) && versions.get(path) !== revision(text)) throw fileChanged();
  return { text, stat };
}

/** A failure before rename leaves the original file alone. */
export function writeTextAtomically(path, text, before, versions) {
  const directory = dirname(path);
  if (realpathAllowMissing(path) !== path) throw fileChanged();
  mkdirSync(directory, { recursive: true });
  const temp = join(directory, `.tora-write-${randomUUID()}.tmp`);
  const fd = openSync(temp, 'wx', before ? 0o600 : 0o666);
  try {
    try {
      writeFileSync(fd, text);
      if (before) fchmodSync(fd, before.mode & 0o777);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (realpathAllowMissing(path) !== path || !sameFile(before, fileStat(path))) throw fileChanged();
    renameSync(temp, path);
    rememberText(versions, path, text);
  } finally { rmSync(temp, { force: true }); }
}

export function textWriteFailure(error, prefix) {
  const text = `${prefix}: ${error.message}`;
  if (error.code !== 'FILE_CHANGED') return text;
  return { ok: false, text, meta: { failure: { kind: 'file-changed', retryable: false } } };
}
