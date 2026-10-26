import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray, utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { defaultSettings } from '../src/app/contracts.ts';
import type { Command, Snapshot } from '../src/app/contracts.ts';
import logoPath from '../resources/icons/logo.png?asset';

const directory = dirname(fileURLToPath(import.meta.url));
if (process.env.CODEX_RESUME_DATA_DIR) app.setPath('userData', process.env.CODEX_RESUME_DATA_DIR);
else app.setPath('userData', join(app.getPath('appData'), 'codex-resume'));
const dataDirectory = app.getPath('userData');
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let worker: UtilityProcess | null = null;
let quitting = false;
let stopRequested = false;
let restartCount = 0;
let snapshot: Snapshot = {
  connection: { state: 'connecting', message: '监控进程启动中', checkedAt: null }, quota: null, nextQuotaCheckAt: null,
  threads: [], tasks: [], events: [], settings: defaultSettings, dataDirectory,
  runtime: { state: 'starting', heartbeatAt: null },
};
const requests = new Map<string, { resolve(value: Snapshot): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
const sourceIcon = nativeImage.createFromBuffer(readFileSync(logoPath));
if (sourceIcon.isEmpty()) throw new Error('应用图标资源无法读取，请重新构建或安装应用');
const icon = sourceIcon.resize({ width: 256, height: 256, quality: 'best' });
const trayIcon = sourceIcon.resize({ width: 32, height: 32, quality: 'best' });
function broadcast() { if (window && !window.isDestroyed()) window.webContents.send('resume:update', snapshot); }
function showWindow() {
  if (window) { window.show(); window.focus(); return; }
  window = new BrowserWindow({
    width: 1240, height: 850, minWidth: 1000, minHeight: 700, title: 'Codex Resume',
    backgroundColor: '#f5f7fa', autoHideMenuBar: true, icon,
    webPreferences: { preload: join(directory, '../preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => {
    if (!quitting && snapshot.settings.closeToTray && tray) { event.preventDefault(); window?.hide(); }
  });
  window.on('closed', () => { window = null; });
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(directory, '../renderer/index.html'));
}
let lastEventId: number | null = null;
function notify(next: Snapshot) {
  const previous = lastEventId;
  lastEventId = Math.max(lastEventId ?? 0, ...next.events.map(e => e.id));
  if (previous == null || !next.settings.notifications || !Notification.isSupported()) return;
  for (const e of next.events.filter(e => e.id > previous)) {
    const text: Record<string, string> = {
      quota_stop_detected: '任务因额度耗尽停止，正在等待恢复。',
      resume_submitted: '额度可用，已在原会话提交续跑。', completed: '续跑轮次已完成。',
      suspended: '托管已停止，请检查任务详情。', send_uncertain: '发送结果需要人工核对，已停止自动补发。',
    };
    if (text[e.type]) new Notification({ title: 'Codex Resume', body: text[e.type]!, icon }).show();
  }
}
function startWorker() {
  if (quitting) return;
  snapshot.runtime = { state: 'starting', heartbeatAt: null }; broadcast();
  worker = utilityProcess.fork(join(directory, 'worker.js'), [], {
    serviceName: 'Codex Resume Monitor', stdio: 'pipe',
    env: { ...process.env, CODEX_RESUME_DATA_DIR: dataDirectory },
  });
  worker.on('message', (message: { type: string; id?: string; value?: Snapshot; message?: string }) => {
    if (message.type === 'snapshot' && message.value) {
      notify(message.value); snapshot = message.value; snapshot.runtime.heartbeatAt = Date.now(); broadcast();
    } else if (message.id) {
      const request = requests.get(message.id); if (!request) return;
      clearTimeout(request.timer); requests.delete(message.id);
      if (message.type === 'result' && message.value) { snapshot = message.value; request.resolve(snapshot); broadcast(); }
      else request.reject(new Error(message.message ?? '监控操作失败'));
    }
  });
  worker.stderr?.on('data', chunk => console.error('[monitor]', String(chunk).trim()));
  worker.on('exit', code => {
    worker = null;
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error('监控进程已退出')); }
    requests.clear();
    snapshot.runtime = { ...snapshot.runtime, state: 'stopped', message: `监控进程退出 (${code})` };
    snapshot.connection = { ...snapshot.connection, state: 'disconnected', message: '监控进程离线' }; broadcast();
    if (stopRequested) { app.quit(); return; }
    if (!quitting && restartCount++ < 3) setTimeout(startWorker, 3000);
  });
}
function command(value: Command) {
  if (!worker) return Promise.reject(new Error('监控进程尚未就绪'));
  const id = randomUUID();
  return new Promise<Snapshot>((resolve, reject) => {
    const timer = setTimeout(() => { requests.delete(id); reject(new Error('操作超时，请查看任务状态；发送操作不会自动重试。')); }, 90000);
    requests.set(id, { resolve, reject, timer }); worker!.postMessage({ id, command: value });
  });
}
function requestQuit() { quitting = true; app.quit(); }
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => { if (!tray || !snapshot.settings.closeToTray) requestQuit(); });
  app.on('before-quit', event => {
    quitting = true;
    if (worker) {
      event.preventDefault();
      if (!stopRequested) {
        stopRequested = true; worker.postMessage({ type: 'stop' });
        // 超时退出仍保留数据库中的发送意图，下次启动只对账。
        setTimeout(() => worker?.kill(), 35000).unref();
      }
    }
  });
  void app.whenReady().then(() => {
    app.setAppUserModelId('local.codex-resume.desktop');
    Menu.setApplicationMenu(null);
    tray = new Tray(trayIcon);
    tray.setToolTip('Codex Resume · 本地续跑助手');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 Codex Resume', click: showWindow },
      { type: 'separator' }, { label: '退出并停止监控', click: requestQuit },
    ]));
    tray.on('double-click', showWindow);
    const trusted = (event: Electron.IpcMainInvokeEvent) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('来源无效');
    };
    ipcMain.handle('resume:snapshot', event => { trusted(event); return snapshot; });
    ipcMain.handle('resume:command', (event, value: Command) => {
      trusted(event);
      if (!value || !['refresh', 'add', 'toggle', 'remove', 'reconcile', 'settings'].includes(value.type)) throw new Error('操作无效');
      return command(value);
    });
    ipcMain.handle('resume:directory', async event => { trusted(event); await shell.openPath(dataDirectory); });
    ipcMain.handle('resume:export', async event => {
      trusted(event);
      const result = await dialog.showSaveDialog(window!, { title: '导出最近事件', defaultPath: 'codex-resume-events.jsonl', filters: [{ name: 'JSONL', extensions: ['jsonl'] }] });
      if (result.canceled || !result.filePath) return null;
      await writeFile(result.filePath, snapshot.events.slice().reverse().map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      return result.filePath;
    });
    ipcMain.handle('resume:quit', event => { trusted(event); setTimeout(requestQuit, 0); });
    showWindow(); startWorker();
  });
}
