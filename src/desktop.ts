import net from 'node:net';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { DesktopPort, Quota, ThreadView } from './domain.ts';

interface Tool { name: string; namespace: string; inputSchema?: { properties?: Record<string, unknown> } }
interface ToolResult { success: boolean; contentItems: Array<{ type: string; text?: string }> }
type Waiter = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
const frameLimit = 8 * 1024 * 1024;
const allowed = new Set(['get_usage_limits', 'read_thread', 'list_threads', 'send_message_to_thread']);

export class DesktopClient implements DesktopPort {
  callerThreadId: string;
  explicitPipe?: string;
  timeoutMs: number;
  private socket?: net.Socket;
  private buffer = Buffer.alloc(0);
  private sequence = 0;
  private pending = new Map<number, Waiter>();
  private tools = new Map<string, Tool>();
  private opening?: Promise<void>;
  pipe?: string;

  constructor(callerThreadId: string, pipe?: string, timeoutMs = 25000) {
    this.callerThreadId = callerThreadId;
    this.explicitPipe = pipe;
    this.timeoutMs = timeoutMs;
  }
  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.tools.size) return;
    if (this.opening) return this.opening;
    this.opening = this.open();
    try { await this.opening; } finally { this.opening = undefined; }
  }
  private async open() {
    if (this.explicitPipe) this.pipe = this.explicitPipe;
    else {
      if (process.platform !== 'win32') throw new Error('自动发现目前仅支持 Windows');
      const names = readdirSync('\\\\.\\pipe\\').filter((name) => name.startsWith('codex-app-tools-'));
      if (names.length !== 1) throw new Error(`发现 ${names.length} 个桌面工具管道，需要显式 --pipe`);
      this.pipe = `\\\\.\\pipe\\${names[0]}`;
    }
    this.buffer = Buffer.alloc(0);
    const socket = net.createConnection(this.pipe!);
    this.socket = socket;
    socket.on('data', (chunk) => this.receive(socket, chunk));
    socket.on('error', (error) => this.disconnect(socket, error));
    socket.on('close', () => this.disconnect(socket, new Error('桌面 App 连接关闭')));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('桌面连接超时')); }, this.timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    try {
    const catalog = await this.request('tools/list', { threadStartKind: 'all' }) as { tools: Tool[] };
    if (!Array.isArray(catalog.tools)) throw new Error('桌面工具目录不兼容');
    this.tools = new Map(catalog.tools.filter((tool) => allowed.has(tool.name)).map((tool) => [tool.name, tool]));
    for (const name of allowed) if (!this.tools.has(name)) throw new Error(`桌面缺少必要能力：${name}`);
    for (const [name, fields] of [['read_thread', ['threadId']], ['send_message_to_thread', ['threadId', 'prompt']]] as const) {
      const properties = this.tools.get(name)?.inputSchema?.properties;
      if (!fields.every((field) => properties && field in properties)) throw new Error(`桌面参数 schema 不兼容：${name}`);
    }
    } catch (error) {
      this.disconnect(socket, error instanceof Error ? error : new Error(String(error)));
      socket.destroy();
      throw error;
    }
  }
  private receive(socket: net.Socket, chunk: Buffer) {
    if (socket !== this.socket) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > frameLimit) { this.disconnect(socket, new Error('桌面响应帧过大')); socket.destroy(); return; }
      if (this.buffer.length < length + 4) return;
      let response: { id: number; result?: unknown; error?: { code: number; message: string } };
      try { response = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8')); }
      catch { this.disconnect(socket, new Error('无效桌面响应')); socket.destroy(); return; }
      this.buffer = this.buffer.subarray(length + 4);
      const waiter = this.pending.get(response.id);
      if (!waiter) continue;
      this.pending.delete(response.id);
      clearTimeout(waiter.timer);
      if (response.error) waiter.reject(new Error(`桌面工具错误 ${response.error.code}: ${response.error.message}`));
      else waiter.resolve(response.result);
    }
  }
  private request(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error('桌面管道尚未连接'));
    const id = ++this.sequence;
    const body = Buffer.from(JSON.stringify({ id, jsonrpc: '2.0', method, params }));
    if (body.length > frameLimit) return Promise.reject(new Error('请求帧过大'));
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length);
    body.copy(frame, 4);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`桌面请求超时：${method}`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(frame, (error) => {
        if (error) this.disconnect(socket, error);
      });
    });
  }
  private disconnect(socket: net.Socket, error: Error) {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.tools.clear();
    this.buffer = Buffer.alloc(0);
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
  }
  async call<T>(name: string, argumentsValue: Record<string, unknown>, beforeDispatch?: () => void): Promise<T> {
    if (!allowed.has(name)) throw new Error(`不允许的桌面操作：${name}`);
    await this.connect();
    const tool = this.tools.get(name)!;
    beforeDispatch?.();
    const result = await this.request('tools/call', {
      namespace: tool.namespace, tool: tool.name, arguments: argumentsValue,
      callerSource: 'codex', threadId: this.callerThreadId, hostId: 'local',
      turnId: `resume-watch-${randomUUID()}`, callId: `resume-${randomUUID()}`,
    }) as ToolResult;
    if (!result || !Array.isArray(result.contentItems)) throw new Error('桌面返回格式不兼容');
    const texts = result.contentItems.filter((item) => item.type === 'inputText').map((item) => item.text);
    if (!result.success) throw new Error('桌面工具调用未成功');
    if (texts.length !== 1 || typeof texts[0] !== 'string') throw new Error('桌面未返回单条结构化数据');
    return JSON.parse(texts[0]) as T;
  }
  quota() { return this.call<Quota>('get_usage_limits', {}); }
  async readThread(id: string) {
    const view = await this.call<ThreadView>('read_thread', {
      threadId: id, hostId: 'local', turnLimit: 10, includeOutputs: true, maxOutputCharsPerItem: 2000,
    });
    if (view.thread?.id !== id || !Array.isArray(view.turns) || typeof view.thread.status?.type !== 'string') {
      throw new Error('会话响应身份或格式不匹配');
    }
    return view;
  }
  async send(id: string, prompt: string, beforeDispatch?: () => void) {
    // 发送没有幂等承诺，任何不确定响应都交由状态机保守处理，不在连接层自动重试。
    await this.call('send_message_to_thread', { threadId: id, hostId: 'local', prompt }, beforeDispatch);
  }
  close() {
    const socket = this.socket;
    if (socket) { this.disconnect(socket, new Error('验证器已关闭')); socket.destroy(); }
  }
}
