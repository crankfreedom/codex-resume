import { beforeEach, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createPinia, setActivePinia } from 'pinia';
import { createResource } from '../renderer/src/resource.ts';
import { useLibrary, useLocalData, useMonitor } from '../renderer/src/store.ts';
import { useHistory } from '../renderer/src/history-store.ts';
import { defaultSettings } from '../src/app/contracts.ts';
import type { Bridge, DataQuery, DataResult, Snapshot } from '../src/app/contracts.ts';
import { initialResetCards } from '../src/app/reset-cards.ts';

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return { connection: { state: 'connected', message: '', checkedAt: 1 }, quota: null, nextQuotaCheckAt: null,
    resetCards: { ...initialResetCards, cards: [] }, tasks: [], threads: [], events: [],
    settings: structuredClone(defaultSettings), runtime: { state: 'running', heartbeatAt: 1 }, dataDirectory: 'fixture', ...overrides };
}
let bridge: Bridge;
let publish: (value: Snapshot) => void;
beforeEach(() => {
  setActivePinia(createPinia());
  bridge = { snapshot: async () => snapshot(), command: async () => snapshot(), query: async () => ({}),
    onSnapshot: callback => { publish = callback; return () => {}; },
    exportEvents: async () => null, openDataDirectory: async () => {}, quit: async () => {} };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { resume: bridge } });
  Object.defineProperty(globalThis, 'document', { configurable: true,
    value: { documentElement: { style: { setProperty() {} }, dataset: {} } } });
});

test('资源合并重复请求，首屏加载结束后才标记已读取', async () => {
  const gate = deferred<number[]>(); let calls = 0;
  const resource = createResource(() => { calls++; return gate.promise; });
  const first = resource.load(); assert.equal(resource.load(), first);
  assert.equal(calls, 1); assert.equal(resource.state.loaded, false); assert.equal(resource.state.pending, true);
  gate.resolve([]); assert.equal(await first, true);
  assert.equal(resource.state.loaded, true); assert.equal(resource.state.pending, false); assert.deepEqual(resource.state.data, []);
});

test('资源强制刷新后，旧成功与旧失败均不能覆盖较新结果或结束其 loading', async () => {
  const gates = [deferred<string>(), deferred<string>(), deferred<string>()]; let i = 0;
  const resource = createResource(() => gates[i++]!.promise);
  const old = resource.load(); const newer = resource.load({ force: true });
  gates[0]!.resolve('旧'); await old; assert.equal(resource.state.pending, true);
  const newest = resource.load({ force: true }); gates[2]!.resolve('最新'); await newest;
  gates[1]!.reject(new Error('旧失败')); await newer;
  assert.equal(resource.state.data, '最新'); assert.equal(resource.state.error, ''); assert.equal(resource.state.pending, false);
});

test('同步抛错仍能结束 loading 并重试；后台刷新保留已加载内容', async () => {
  let fail = true;
  const resource = createResource(() => { if (fail) throw new Error('读取失败'); return Promise.resolve([1]); });
  await resource.load(); assert.equal(resource.state.error, '读取失败'); assert.equal(resource.state.pending, false);
  fail = false; await resource.load();
  const background = resource.load({ silent: true });
  assert.equal(resource.state.pending, false); assert.deepEqual(resource.state.data, [1]); await background;
});

test('本机数据就绪后解除任务和设置 loading，远程连接期间额度与会话继续独立加载', async () => {
  bridge.snapshot = async () => snapshot({ runtime: { state: 'starting', heartbeatAt: null } });
  const store = useMonitor(); await store.start(); assert.equal(store.loading.settings, true);
  publish(snapshot({ connection: { state: 'connecting', message: '', checkedAt: null } }));
  assert.equal(store.loading.tasks, false); assert.equal(store.loading.settings, false);
  assert.equal(store.loading.quota, true); assert.equal(store.loading.threads, true);
  publish(snapshot({ connection: { state: 'disconnected', message: '离线', checkedAt: 2 } }));
  assert.equal(store.loading.quota, false); assert.equal(store.loading.threads, false); store.stop();
});

test('首屏旧快照不得覆盖订阅的新快照，重复启动只订阅一次', async () => {
  const gate = deferred<Snapshot>(); let subscriptions = 0; let stopped = 0;
  bridge.snapshot = () => gate.promise;
  bridge.onSnapshot = callback => { subscriptions++; publish = callback; return () => { stopped++; }; };
  const store = useMonitor(); const first = store.start(); const repeated = store.start();
  publish(snapshot({ dataDirectory: '最新' })); gate.resolve(snapshot({ dataDirectory: '旧' })); await Promise.all([first, repeated]);
  assert.equal(store.snapshot?.dataDirectory, '最新'); assert.equal(subscriptions, 1);
  store.stop(); assert.equal(stopped, 1);
});

test('首屏失败结束 loading 并允许重试，重试仍复用已有订阅', async () => {
  let fail = true; let subscriptions = 0;
  bridge.snapshot = async () => { if (fail) throw new Error('快照失败'); return snapshot(); };
  bridge.onSnapshot = callback => { subscriptions++; publish = callback; return () => {}; };
  const store = useMonitor(); await store.start();
  assert.equal(store.initializing, false); assert.equal(store.snapshotError, '快照失败');
  fail = false; await store.start(); assert.equal(store.snapshotError, ''); assert.equal(subscriptions, 1); store.stop();
});

test('并发命令按类型计数，不相互提前结束 busy 或触发无关模块 loading', async () => {
  const gates = [deferred<Snapshot>(), deferred<Snapshot>(), deferred<Snapshot>()]; let i = 0;
  bridge.command = () => gates[i++]!.promise;
  const store = useMonitor(); await store.start();
  const one = store.command({ type: 'selfCheck' }); const two = store.command({ type: 'selfCheck' });
  const other = store.command({ type: 'refreshData' });
  assert.equal(store.loading.inspection, true); assert.equal(store.loading.events, true); assert.equal(store.loading.quota, false);
  gates[0]!.resolve(snapshot()); await one; assert.equal(store.isPending('selfCheck'), true);
  gates[1]!.reject(new Error('自检失败')); await two;
  assert.equal(store.isPending('selfCheck'), false); assert.equal(store.busy, true);
  gates[2]!.resolve(snapshot()); await other; assert.equal(store.busy, false); store.stop();
});

test('模板共用查询结果，写入后强制更新缓存，模板默认值在 store 派生', async () => {
  let calls = 0; let body = '原正文';
  bridge.query = async () => { calls++; return { templates: [{ id: 't', name: '模板', body, isDefault: true }] }; };
  bridge.command = async () => { body = '新正文'; return snapshot(); };
  const library = useLibrary(); await library.templates.load(); assert.equal(library.defaultTemplate?.body, '原正文');
  await useMonitor().command({ type: 'templateSave', value: { id: 't', name: '模板', body: '新正文', isDefault: true } });
  assert.equal(calls, 2); assert.equal(library.rows[0]?.body, '新正文');
});

test('历史筛选与分页保留应用时的条件，主页面与任务详情相互隔离', async () => {
  const queries: DataQuery[] = [];
  bridge.query = async query => { queries.push(structuredClone(query)); return { events: [], nextCursor: 50, boundary: 100 }; };
  const store = useHistory(); const main = store.session('main'); const detail = store.session('detail', 'task-1');
  main.tab = 'events'; main.reason = '原条件'; await main.load(); main.reason = '未应用'; await main.load(true);
  const page = queries[1]; assert.equal(page?.type, 'events');
  if (page?.type === 'events') { assert.equal(page.filter?.reason, '原条件'); assert.equal(page.cursor, 50); assert.equal(page.boundary, 100); }
  await detail.load(); assert.equal(main.tab, 'events'); assert.equal(detail.tab, 'timeline');
  assert.equal(queries[2]?.type, 'timeline'); store.release('detail'); assert.equal(store.sessions.detail, undefined);
});

test('历史快速切换请求以最新结果为准，失败重试保留原查询及分页游标', async () => {
  const gates = [deferred<DataResult>(), deferred<DataResult>()]; const queries: DataQuery[] = []; let i = 0;
  bridge.query = query => { queries.push(query); return i < 2 ? gates[i++]!.promise : Promise.resolve({ events: [] }); };
  const session = useHistory().session('main'); const old = session.load();
  session.tab = 'events'; const newer = session.load(); gates[1]!.resolve({ events: [], nextCursor: 2, boundary: 9 }); await newer;
  gates[0]!.resolve({ archives: [] }); await old;
  assert.equal(session.next, 2); assert.equal(session.resource.state.data?.archives, undefined);
  bridge.query = async query => { queries.push(query); throw new Error('分页失败'); }; await session.load(true);
  bridge.query = async query => { queries.push(query); return { events: [] }; }; await session.retry();
  assert.deepEqual(queries.at(-1), queries.at(-2));
});

test('导出统一管理 pending，重复点击不重复打开系统对话框，失败后可再次导出', async () => {
  const gate = deferred<string | null>(); let calls = 0;
  bridge.exportEvents = () => { calls++; return gate.promise; };
  const store = useLocalData(); const first = store.exportEvents(); assert.equal(store.exporting, true);
  assert.equal(await store.exportEvents(), null); assert.equal(calls, 1);
  gate.reject(new Error('导出失败')); assert.equal(await first, null); assert.equal(store.exporting, false);
  bridge.exportEvents = async () => 'fixture.jsonl'; assert.equal(await store.exportEvents(), 'fixture.jsonl'); assert.equal(store.error, '');
});
