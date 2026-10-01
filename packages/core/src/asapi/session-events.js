// Append-only recovery journal for ASAPI sessions. The existing JSON record remains
// a compatibility snapshot; newer journal entries win when rebuilding a session.
import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TORA_DIR } from '../config.js';

const SESSIONS_DIR = join(TORA_DIR, 'asapi', 'sessions');
const VERSION = 1;

export function sessionEventPath(sessionId) {
  if (!/^[\w-]+$/.test(sessionId)) throw new Error('非法会话 ID');
  return join(SESSIONS_DIR, `${sessionId}.events.jsonl`);
}

export function appendSessionEvent(sessionId, type, data) {
  const path = sessionEventPath(sessionId);
  mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  const event = { version: VERSION, id: randomUUID(), at: new Date().toISOString(), type, data };
  const fd = openSync(path, 'a+', 0o600);
  let nextOffset;
  try {
    const size = fstatSync(fd).size;
    if (size) {
      let end = size;
      let committedEnd = 0;
      while (end > 0) {
        const start = Math.max(0, end - 8192);
        const chunk = Buffer.allocUnsafe(end - start);
        readSync(fd, chunk, 0, chunk.length, start);
        const newline = chunk.lastIndexOf(10);
        if (newline >= 0) { committedEnd = start + newline + 1; break; }
        end = start;
      }
      if (committedEnd !== size) ftruncateSync(fd, committedEnd);
    }
    const line = Buffer.from(`${JSON.stringify(event)}\n`);
    let written = 0;
    while (written < line.length) written += writeSync(fd, line, written, line.length - written);
    fsyncSync(fd);
    nextOffset = fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
  return { ...event, nextOffset };
}

export function readSessionEvents(sessionId, afterOffset = 0) {
  const path = sessionEventPath(sessionId);
  if (!existsSync(path)) return { events: [], nextOffset: 0 };
  const fd = openSync(path, 'r');
  let contents;
  let start;
  try {
    const size = fstatSync(fd).size;
    start = afterOffset >= 0 && afterOffset <= size ? afterOffset : 0;
    contents = Buffer.allocUnsafe(size - start);
    let read = 0;
    while (read < contents.length) {
      const count = readSync(fd, contents, read, contents.length - read, start + read);
      if (!count) throw new Error('会话事件日志读取不完整');
      read += count;
    }
  } finally {
    closeSync(fd);
  }
  // A killed process may leave a partial last write. Only newline-terminated
  // records are committed; a malformed committed line is an explicit error.
  const committedBytes = contents.lastIndexOf(10) + 1;
  const nextOffset = start + committedBytes;
  const committed = contents.subarray(0, committedBytes).toString('utf8');
  const events = committed.split('\n').filter(Boolean).map((line) => {
    const event = JSON.parse(line);
    if (event.version !== VERSION || !event.type || !event.data) throw new Error('会话事件日志格式不受支持');
    return event;
  });
  return { events, nextOffset };
}

function upsertDisplay(record, message) {
  if (!message?.id) return;
  const index = record.display.findIndex((item) => item.id === message.id);
  if (index < 0) record.display.push(message);
  else record.display[index] = message;
}

export function projectSessionEvents(record, events) {
  record.display ??= [];
  record.internal ??= [];
  for (const event of events) {
    const { type, data } = event;
    if (type === 'run-started') {
      if (Array.isArray(data.internal)) record.internal = data.internal;
      upsertDisplay(record, data.user);
    } else if (type === 'internal-snapshot') {
      if (Array.isArray(data.internal)) record.internal = data.internal;
    } else if (type === 'reply-progress' || type === 'reply-finished') {
      if (Array.isArray(data.internal)) record.internal = data.internal;
      upsertDisplay(record, data.reply);
    }
  }
  return record;
}
