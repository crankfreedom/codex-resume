import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const threadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 仅读会话索引尾部，不访问账号凭据或历史消息。
export function discoverCaller(): string {
  const path = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'session_index.jsonl');
  const size = statSync(path).size;
  const start = Math.max(0, size - 128 * 1024);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(path, 'r');
  try { readSync(fd, buffer, 0, buffer.length, start); } finally { closeSync(fd); }
  const lines = buffer.toString('utf8').split('\n');
  if (start) lines.shift();
  for (const line of lines.reverse()) {
    try {
      const row = JSON.parse(line) as { id?: string };
      if (row.id && threadIdPattern.test(row.id)) return row.id;
    } catch { /* 部分尾行跳过 */ }
  }
  throw new Error('未找到本机 Codex 会话索引，请先在 Codex 打开一个会话，或在设置中指定调用会话 ID。');
}
