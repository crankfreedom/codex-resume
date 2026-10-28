// 桌面全流程 fixture：所有额度、轮次和发送都由本脚本提供，不使用真实账号。
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { strict as assert } from 'node:assert';
import { _electron as electron, expect } from '@playwright/test';

const target = randomUUID();
const pipe = `\\\\.\\pipe\\codex-app-tools-test-${randomUUID()}`;
const sockets = new Set();
const reset = Math.floor(Date.now() / 1000) + 2;
let used = 100;
let sends = 0;
let quotaCalls = 0;
const view = { thread: { id: target, status: { type: 'idle' } }, turns: [{ id: 'fixture-quota-failure', status: 'failed', error: { code: 'UsageLimitExceeded' } }] };
const server = net.createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const length = buffer.readUInt32LE(0);
      const request = JSON.parse(buffer.subarray(4, length + 4).toString());
      buffer = buffer.subarray(length + 4);
      let result;
      if (request.method === 'tools/list') result = { tools: ['get_usage_limits', 'list_threads', 'read_thread', 'send_message_to_thread'].map(name => ({ name, namespace: 'codex_app', inputSchema: { properties: { threadId: {}, prompt: {} } } })) };
      else {
        const { tool, arguments: args } = request.params;
        let value;
        if (tool === 'get_usage_limits') {
          quotaCalls++;
          value = { accountId: 'FIXTURE-NOT-A-REAL-ACCOUNT', ordinaryUsageAllowed: true, rateLimitsByLimitId: { codex: { primary: { usedPercent: used, resetsAt: reset, windowDurationMins: 300 }, secondary: { usedPercent: 10, resetsAt: reset + 604800, windowDurationMins: 10080 } } } };
        }
        else if (tool === 'list_threads') value = { pinnedThreads: [], threads: [{ id: target, title: '测试夹具：跨额度窗口长任务', kind: 'codex', hostId: 'local', status: 'idle', cwd: '本地模拟，不是真实会话' }] };
        else if (tool === 'read_thread') { assert.equal(args.threadId, target); value = view; }
        else if (tool === 'send_message_to_thread') {
          assert.equal(args.threadId, target); assert.equal(used, 0); sends++;
          view.turns.unshift({ id: `fixture-resumed-${sends}`, status: 'completed', items: [{ type: 'functionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread', output: { text: args.prompt } }, { type: 'agentMessage', text: '夹具任务完成' }] });
          value = { success: true };
        } else throw new Error('fixture 收到未允许的调用');
        result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
      }
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      const frame = Buffer.alloc(body.length + 4); frame.writeUInt32LE(body.length); body.copy(frame, 4); socket.write(frame);
    }
  });
});
await new Promise(resolveListen => server.listen(pipe, resolveListen));
const dataDirectory = mkdtempSync(join(tmpdir(), 'codex-resume-FIXTURE-'));
const env = { ...process.env, CODEX_RESUME_DATA_DIR: dataDirectory }; delete env.ELECTRON_RUN_AS_NODE;
let instance;
const artifacts = resolve('var', 'desktop-smoke'); mkdirSync(artifacts, { recursive: true });
try {
  instance = await electron.launch({ args: [resolve('out/main/index.js')], env });
  const window = await instance.firstWindow();
  await window.getByRole('heading', { name: '运行总览', exact: true }).waitFor();
  await expect.poll(async () => (await window.evaluate(() => window.resume.snapshot())).runtime.state).toBe('running');
  // 仅配置测试实例；显式管道确保不会向当前真实 Codex 投递。
  await window.evaluate(async ({ pipe, target }) => {
    const snapshot = await window.resume.snapshot();
    await window.resume.command({ type: 'settings', value: { ...snapshot.settings, pipe, callerThreadId: target, notifications: false, pollSeconds: 10 } });
    await window.resume.command({ type: 'refresh' });
  }, { pipe, target });
  await expect.poll(async () => (await window.evaluate(() => window.resume.snapshot())).threads[0]?.id, { timeout: 15000 }).toBe(target);
  await window.getByRole('button', { name: '▤ 托管任务' }).click();
  await window.getByRole('button', { name: '托管会话', exact: true }).click();
  await window.locator('.consent-box .el-checkbox').click();
  await window.getByRole('button', { name: '确认并开始托管' }).click();
  await window.getByText('已开始托管；仅在真实额度错误后自动续跑', { exact: true }).waitFor();
  await window.evaluate(() => window.resume.command({ type: 'refresh' }));
  await expect.poll(async () => (await window.evaluate(() => window.resume.snapshot())).tasks[0]?.phase).toBe('waiting_quota');
  assert.equal(sends, 0);
  await window.screenshot({ path: join(artifacts, 'fixture-waiting.png'), animations: 'disabled' });
  await window.getByRole('button', { name: '⚙ 应用设置' }).click();
  const localData = window.locator('.data-card');
  const preview = localData.getByLabel('最近事件数据');
  await expect(preview).toContainText('测试夹具：跨额度窗口长任务');
  const beforeRefresh = quotaCalls;
  used = 0;
  await localData.getByRole('button', { name: '刷新数据', exact: true }).click();
  await window.getByText('本机数据已刷新', { exact: true }).waitFor();
  assert.equal(quotaCalls, beforeRefresh); assert.equal(sends, 0);
  const datePattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  const previewEvents = JSON.parse(await preview.textContent());
  assert.ok(previewEvents.every(event => datePattern.test(event.time)));
  assert.ok(previewEvents.filter(event => event.taskId).every(event => event.taskName === '测试夹具：跨额度窗口长任务'));
  const quotaEvent = previewEvents.find(event => event.type === 'quota_checked');
  assert.match(quotaEvent.details.nextCheckAt, datePattern);
  assert.match(quotaEvent.details.windows[0].resetsAt, datePattern);
  const exportPath = join(dataDirectory, 'exported-events.jsonl');
  await instance.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, exportPath);
  await localData.getByRole('button', { name: '导出最近事件', exact: true }).click();
  await window.getByText('事件已导出', { exact: true }).waitFor();
  const exportedEvents = readFileSync(exportPath, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(exportedEvents, previewEvents.slice().reverse());
  assert.equal(quotaCalls, beforeRefresh); assert.equal(sends, 0);
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
  assert.equal(await window.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await localData.screenshot({ path: join(artifacts, 'fixture-local-data.png'), animations: 'disabled' });
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1240, 850));
  used = 100;
  await window.getByRole('button', { name: '▤ 托管任务' }).click();
  await window.getByRole('button', { name: '暂停托管', exact: true }).click();
  used = 0;
  await window.evaluate(() => window.resume.command({ type: 'refresh' }));
  assert.equal(sends, 0);
  await window.getByRole('button', { name: '继续托管', exact: true }).click();
  await expect.poll(async () => {
    await window.evaluate(() => window.resume.command({ type: 'refresh' }));
    return (await window.evaluate(() => window.resume.snapshot())).tasks[0]?.phase;
  }, { timeout: 20000, intervals: [1000, 2000] }).toBe('completed');
  assert.equal(sends, 1);
  const snapshot = await window.evaluate(() => window.resume.snapshot());
  assert.equal(snapshot.tasks[0].targetThreadId, target);
  assert.equal(snapshot.tasks[0].enabled, false);
  await window.screenshot({ path: join(artifacts, 'fixture-completed.png'), animations: 'disabled' });
  await window.getByRole('button', { name: '移除', exact: true }).click();
  await window.locator('.el-message-box').getByRole('button', { name: '移除', exact: true }).click();
  await expect.poll(async () => (await window.evaluate(() => window.resume.snapshot())).tasks.length).toBe(0);
  await window.getByRole('button', { name: '⚙ 应用设置' }).click();
  await expect(preview).toContainText('task_removed');
  const removedEvents = JSON.parse(await preview.textContent()).filter(event => event.taskId);
  assert.ok(removedEvents.every(event => event.taskName === '测试夹具：跨额度窗口长任务'));
  await window.getByRole('button', { name: '≡ 运行记录' }).click();
  await expect(window.locator('.event-row').filter({ hasText: '已移除托管记录' })).toContainText('测试夹具：跨额度窗口长任务');
  const result = { time: new Date().toISOString(), source: 'fake_named_pipe_fixture', realQuotaRecoveryVerified: false,
    sends, sameThread: true, checks: ['GUI-consent', 'quota-blocked-zero-sends', 'local-data-live-preview', 'local-data-refresh-without-quota-or-send', 'local-data-readable-times', 'JSONL-matches-preview', 'local-data-narrow-layout', 'removed-task-name-retained', 'pause-blocks-dispatch', 'recovery-recheck', 'same-thread-receipt', 'completed-stop'], evidence: snapshot.tasks[0].evidence };
  writeFileSync(join(artifacts, 'fixture-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally {
  await instance?.close(); for (const socket of sockets) socket.destroy();
  await new Promise(resolveClose => server.close(resolveClose));
}
