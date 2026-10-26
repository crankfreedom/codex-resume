import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DesktopClient } from './desktop.ts';
import { createJob, ResumeEngine } from './engine.ts';
import { FileJournal } from './store.ts';
import { fingerprint, quotaGate, realClock } from './domain.ts';
import { HybridDesktop, SimulatedDesktop, VirtualClock } from './scenarios.ts';
import type { DesktopPort, Job } from './domain.ts';

const parsed = parseArgs({ allowPositionals: true, options: {
  caller: { type: 'string' }, target: { type: 'string' }, pipe: { type: 'string' },
  job: { type: 'string' }, 'prompt-file': { type: 'string' },
  'poll-ms': { type: 'string', default: '30000' }, 'max-ms': { type: 'string', default: '21600000' },
  'delay-ms': { type: 'string', default: '15000' },
  'follow-session': { type: 'boolean', default: false },
} });
const command = parsed.positionals[0] ?? 'help';
const options = parsed.values;
const required = (name: 'caller' | 'target' | 'job') => {
  const value = options[name];
  if (!value) throw new Error(`缺少 --${name}`);
  return value;
};
function duration(value: string | undefined, name: string, minimum = 1000) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum) throw new Error(`无效 ${name}`);
  return result;
}
function pathForJob() { return resolve(options.job ?? `var/${command}-${randomUUID()}.json`); }
const signal = new AbortController();
process.once('SIGINT', () => signal.abort());
process.once('SIGTERM', () => signal.abort());

async function execute(job: Job, port: DesktopPort, journal: FileJournal, maxMs: number, pollMs: number) {
  const release = journal.lock(job.targetThreadId);
  try {
    journal.event('watch_started', { mode: job.mode, pid: process.pid, targetThreadId: job.targetThreadId });
    const engine = new ResumeEngine(job, port, realClock, journal);
    await engine.run({ pollMs, maxMs, signal: signal.signal });
    journal.event('runner_exit', { phase: job.phase, reason: job.reason, job: journal.path });
    if (job.phase === 'suspended' || job.phase === 'send_uncertain') process.exitCode = 2;
  } finally { release(); }
}

async function main() {
  if (command === 'help') {
    console.log(`codex-resume：无界面验证器（Node.js 24+）
  inspect --caller ID                       只读查询桌面额度和任务
  simulate [--job PATH]                     虚拟时钟完整流程，不调用桌面
  hybrid --caller ID --target ID            注入受限信号，真实等待、发送和回执
  arm --caller ID --target ID --job PATH     登记真实额度中断监控，不立即启动
  run --job PATH                            按持久化任务监控与续跑
  status --job PATH                         查看状态，不触发发送
  reconcile --job PATH                      仅核对不确定发送的回执，不补发
  unlock --job PATH                         仅清理确认已退出进程的遗留锁
可选：--pipe PATH --poll-ms 30000 --max-ms 21600000
arm 可选：--follow-session（正常结束后继续观察同一聊天，不发送消息）
hybrid 可选：--delay-ms 15000；真实 arm 可选：--prompt-file PATH
默认续跑仅回复唯一标记；业务续跑必须显式提供自己的提示词文件。`);
    return;
  }
  if (['status', 'unlock'].includes(command)) {
    const journal = new FileJournal(required('job'));
    if (command === 'unlock') journal.unlock();
    else console.log(JSON.stringify(journal.load(), null, 2));
    return;
  }
  if (command === 'simulate') {
    const clock = new VirtualClock();
    const port = new SimulatedDesktop(clock);
    const path = pathForJob();
    if (existsSync(path)) throw new Error('任务文件已存在，拒绝覆盖');
    const journal = new FileJournal(path);
    const job = await createJob(port, { callerThreadId: 'simulation-caller', targetThreadId: 'simulation-thread', mode: 'simulation', now: clock.now() });
    journal.create(job);
    const release = journal.lock(job.targetThreadId);
    try {
      await new ResumeEngine(job, port, clock, journal).run({ pollMs: 1000, maxMs: 120000 });
      if (job.phase !== 'completed' || port.sends !== 1 || port.sentAt! < port.resetAt) throw new Error('模拟流程未通过');
      journal.event('simulation_verified', { virtualElapsedMs: clock.now() - job.createdAt, sends: port.sends, job: path });
    } finally { release(); }
    return;
  }
  if (['run', 'reconcile'].includes(command)) {
    const journal = new FileJournal(required('job'));
    const job = journal.load();
    if (job.mode !== 'live') throw new Error('持久化恢复仅允许 live 模式；hybrid/simulation 请重新创建显式测试');
    const client = new DesktopClient(job.callerThreadId, options.pipe);
    try {
      if (fingerprint(await client.quota()) !== job.accountFingerprint) throw new Error('账号已切换，拒绝恢复监控');
      if (command === 'reconcile') {
        const release = journal.lock(job.targetThreadId);
        try { await new ResumeEngine(job, client, realClock, journal).reconcile(); } finally { release(); }
      } else await execute(job, client, journal, duration(options['max-ms'], 'max-ms'), duration(options['poll-ms'], 'poll-ms'));
    } finally { client.close(); }
    return;
  }
  if (!['inspect', 'arm', 'hybrid'].includes(command)) throw new Error(`未知命令：${command}`);
  const client = new DesktopClient(required('caller'), options.pipe);
  try {
    if (command === 'inspect') {
      const quota = await client.quota();
      const threads = await client.call<{ threads: Array<{ id: string; title: string; kind: string; status: string }> }>('list_threads', { limit: 50 });
      console.log(JSON.stringify({ pipe: client.pipe, accountFingerprint: fingerprint(quota),
        quota: quotaGate(quota, 'codex', Date.now()), threads: threads.threads.filter((thread) => thread.kind === 'codex'),
      }, null, 2));
      return;
    }
    const target = required('target');
    const path = pathForJob();
    if (existsSync(path)) throw new Error('任务文件已存在，拒绝覆盖');
    let port: DesktopPort = client;
    if (command === 'hybrid') {
      if (target === options.caller) throw new Error('混合测试不允许使用当前发起会话作为目标');
      const view = await client.readThread(target);
      if (!['idle', 'notLoaded'].includes(view.thread.status.type) || view.turns[0]?.status !== 'completed') throw new Error('混合测试目标必须已完成且空闲');
      port = new HybridDesktop(client, target, view.turns[0].id, Date.now() + duration(options['delay-ms'], 'delay-ms', 5000), realClock);
    }
    if (command === 'hybrid' && options['prompt-file']) throw new Error('混合验证只允许无工具的标记回执');
    const job = await createJob(port, {
      callerThreadId: options.caller!, targetThreadId: target, mode: command === 'hybrid' ? 'hybrid' : 'live', now: Date.now(),
      ...(options['prompt-file'] ? { prompt: readFileSync(resolve(options['prompt-file']), 'utf8') } : {}),
    });
    const journal = new FileJournal(path);
    if (options['follow-session']) {
      if (command !== 'arm') throw new Error('--follow-session 仅用于真实模式登记');
      job.followSession = true;
    }
    journal.create(job);
    journal.event('armed', { mode: job.mode, targetThreadId: target, job: path });
    if (command === 'hybrid') await execute(job, port, journal, duration(options['max-ms'], 'max-ms'), duration(options['poll-ms'], 'poll-ms'));
  } finally { client.close(); }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ type: 'fatal', message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
