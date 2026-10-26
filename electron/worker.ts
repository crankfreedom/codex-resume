import { MonitorService } from '../src/app/service.ts';
import type { Command } from '../src/app/contracts.ts';

const parent = process.parentPort;
if (!parent) throw new Error('监控进程必须由 Electron 启动');
const directory = process.env.CODEX_RESUME_DATA_DIR;
if (!directory) throw new Error('缺少数据目录');
const service = new MonitorService(directory);
let stopping = false;
function publish() { parent!.postMessage({ type: 'snapshot', value: service.snapshot() }); }
parent.on('message', async event => {
  const message = event.data as { id?: string; command?: Command; type?: string };
  if (message.type === 'stop') {
    stopping = true; clearInterval(timer); service.requestStop();
    await service.stop(); parent!.postMessage({ type: 'stopped' }); process.exit(0);
  }
  if (!message.id || !message.command || stopping) return;
  try {
    await service.command(message.command);
    parent!.postMessage({ type: 'result', id: message.id, value: service.snapshot() });
  } catch (error) { parent!.postMessage({ type: 'error', id: message.id, message: (error as Error).message }); }
  publish();
});
const timer = setInterval(() => {
  // tick 自带互斥，heartbeat 不受长请求阻塞。
  void service.tick().finally(publish);
  publish();
}, 2000);
publish(); void service.tick(true).finally(publish);
