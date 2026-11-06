import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import readline from 'node:readline';
import type { ResetConsumeOutcome, ResetCreditPort, ResetRateLimits } from './reset-cards.ts';

class AppServerError extends Error {}
interface RpcResponse { id?: number; result?: unknown; error?: { code?: number; message?: string } }

export function locateCodexExecutable(): string {
  const explicit = process.env.CODEX_RESUME_CODEX_EXE;
  if (explicit) {
    const path = resolve(explicit);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error('CODEX_RESUME_CODEX_EXE 指向的 Codex CLI 不存在');
    return path;
  }
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error('无法定位本机 Codex CLI，请设置 CODEX_RESUME_CODEX_EXE');
  const bin = join(local, 'OpenAI', 'Codex', 'bin');
  if (!existsSync(bin)) throw new Error('未找到 Codex 桌面随附 CLI，请设置 CODEX_RESUME_CODEX_EXE');
  const candidates = readdirSync(bin, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory()) return [];
    const path = join(bin, entry.name, 'codex.exe');
    return existsSync(path) && statSync(path).isFile() ? [{ path, modified: statSync(path).mtimeMs }] : [];
  }).sort((a, b) => b.modified - a.modified);
  if (!candidates.length) throw new Error('未找到 Codex 桌面随附 CLI，请设置 CODEX_RESUME_CODEX_EXE');
  return candidates[0]!.path;
}

export class AppServerResetClient implements ResetCreditPort {
  private executable: string;
  private timeoutMs: number;
  constructor(executable = locateCodexExecutable(), timeoutMs = 30_000) {
    this.executable = executable; this.timeoutMs = timeoutMs;
  }
  private async request(method: string, params: Record<string, unknown>): Promise<{ result: unknown; userAgent: string | null }> {
    const child = spawn(this.executable, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const lines = readline.createInterface({ input: child.stdout });
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
    let stderr = '';
    let requestSent = false;
    let sequence = 0;
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
    lines.on('line', line => {
      if (line.length > 8 * 1024 * 1024) return;
      let message: RpcResponse;
      try { message = JSON.parse(line) as RpcResponse; } catch { return; }
      if (typeof message.id !== 'number') return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id); clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new AppServerError(`App Server 错误 ${message.error.code ?? ''}: ${message.error.message ?? '未知错误'}`));
      else waiter.resolve(message.result);
    });
    const call = (id: number, name: string, value: Record<string, unknown>) => new Promise<unknown>((resolveCall, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new AppServerError(`App Server 请求超时：${name}`)); }, this.timeoutMs);
      pending.set(id, { resolve: resolveCall, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method: name, params: value })}\n`, error => {
        if (error) { clearTimeout(timer); pending.delete(id); reject(new AppServerError(`App Server 写入失败：${error.message}`)); }
      });
    });
    try {
      await new Promise<void>((resolveStart, reject) => {
        const timer = setTimeout(() => reject(new AppServerError('App Server 启动超时')), this.timeoutMs);
        child.once('spawn', () => { clearTimeout(timer); resolveStart(); });
        child.once('error', error => { clearTimeout(timer); reject(new AppServerError(`App Server 无法启动：${error.message}`)); });
      });
      const initialized = await call(++sequence, 'initialize', {
        clientInfo: { name: 'codex_resume', title: 'Codex Resume', version: process.env.CODEX_RESUME_VERSION ?? '0.2.4' },
        capabilities: { experimentalApi: true },
      }) as { userAgent?: string };
      child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
      requestSent = method === 'account/rateLimitResetCredit/consume';
      const result = await call(++sequence, method, params);
      return { result, userAgent: typeof initialized.userAgent === 'string' ? initialized.userAgent : null };
    } catch (error) {
      if (requestSent && error instanceof Error) {
        const wrapped = new AppServerError(`兑换响应不确定：${error.message}`);
        wrapped.name = 'ResetConsumeUncertain';
        throw wrapped;
      }
      if (error instanceof AppServerError) throw error;
      throw new AppServerError(`${error instanceof Error ? error.message : String(error)}${stderr ? `；${stderr.slice(-300)}` : ''}`);
    } finally {
      for (const waiter of pending.values()) clearTimeout(waiter.timer);
      pending.clear(); lines.close(); child.stdin.end(); child.kill();
    }
  }
  async read() {
    const { result, userAgent } = await this.request('account/rateLimits/read', { excludeResetCreditDetails: false });
    if (!result || typeof result !== 'object') throw new AppServerError('App Server 额度响应格式不兼容');
    return { quota: result as ResetRateLimits, userAgent };
  }
  async consume(creditId: string, idempotencyKey: string): Promise<ResetConsumeOutcome> {
    const { result } = await this.request('account/rateLimitResetCredit/consume', { creditId, idempotencyKey });
    const outcome = (result as { outcome?: unknown })?.outcome;
    if (!['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'].includes(String(outcome))) {
      const error = new AppServerError('App Server 兑换响应格式不兼容');
      error.name = 'ResetConsumeUncertain';
      throw error;
    }
    return outcome as ResetConsumeOutcome;
  }
}
