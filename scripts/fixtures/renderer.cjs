// 纯渲染夹具：只提供可控 IPC，不启动监控、不连接真实账号或读写业务数据库。
const { app, BrowserWindow, ipcMain } = require('electron');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const initial = JSON.parse(readFileSync(process.env.CODEX_RESUME_RENDERER_FIXTURE, 'utf8'));
app.setPath('userData', initial.userData);
const fixture = globalThis.rendererFixture = {
  snapshot: initial.snapshot, hold: new Set(['snapshot']), pending: [], calls: [],
  data: { templates: [], resetAppointments: [], archives: [], events: [], timeline: [] },
  publish(value) { this.snapshot = value; this.window.webContents.send('resume:update', value); },
  finish(kind, value, error) {
    const index = this.pending.findIndex(item => item.kind === kind);
    if (index < 0) throw new Error('没有待完成的请求：' + kind);
    const item = this.pending.splice(index, 1)[0];
    if (error) item.reject(new Error(error)); else item.resolve(value ?? item.value);
  },
};
function request(kind, payload, value) {
  fixture.calls.push({ kind, payload });
  if (!fixture.hold.has(kind)) return value;
  return new Promise((resolveResult, reject) => fixture.pending.push({ kind, payload, value, resolve: resolveResult, reject }));
}
ipcMain.handle('resume:snapshot', () => request('snapshot', null, fixture.snapshot));
ipcMain.handle('resume:query', (_, query) => request(query.type, query, query.type === 'timeline'
  ? { events: fixture.data.timeline } : { [query.type]: fixture.data[query.type] }));
ipcMain.handle('resume:command', (_, command) => {
  if (!['refreshStatus', 'selfCheck', 'refreshData', 'resetCardsRefresh', 'templateSave', 'templateDelete'].includes(command.type)) {
    throw new Error('渲染测试禁止托管、续跑或消费卡片');
  }
  return request(command.type, command, fixture.snapshot);
});
ipcMain.handle('resume:export', () => null);
ipcMain.handle('resume:directory', () => {});
ipcMain.handle('resume:quit', () => app.quit());
app.whenReady().then(() => {
  fixture.window = new BrowserWindow({ width: 1240, height: 850, show: false,
    webPreferences: { preload: resolve('out/preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  fixture.window.loadFile(resolve('out/renderer/index.html'));
});
app.on('window-all-closed', () => app.quit());
