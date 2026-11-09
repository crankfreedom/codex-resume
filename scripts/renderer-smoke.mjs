// 所有数据均为可控 IPC 夹具；不连接真实账号、不启动监控或消费重置卡。
import { _electron as electron, expect } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'codex-resume-renderer-'));
const artifacts = resolve('var/renderer-smoke'); mkdirSync(artifacts, { recursive: true });
const snapshot = {
  connection: { state: 'connected', message: '', checkedAt: Date.now() }, runtime: { state: 'running', heartbeatAt: Date.now() },
  quota: { available: true, reason: 'quota_available', checkedAt: Date.now(), windows: [{ usedPercent: 25 }, { usedPercent: 50 }] },
  nextQuotaCheckAt: Date.now() + 600000,
  resetCards: { cards: [], availableCount: 0, details: 'empty', checkedAt: Date.now(), error: null, userAgent: null },
  tasks: [], threads: [{ id: 'fixture-thread', title: '夹具会话', status: 'active', cwd: '模拟目录' }], events: [],
  settings: { pollSeconds: 20, queue: { enabled: false, limit: 7 }, quotaCheck: { intervalSeconds: 30 }, notifications: false,
    closeToTray: true, callerThreadId: '', pipe: '', appearance: { pageTitleSize: 28, sectionTitleSize: 18, bodyFontSize: 16,
      secondaryFontSize: 13, navFontSize: 16, lineHeight: 1.7, fontFamily: 'system', density: 'comfortable', highContrast: false, accent: 'teal' } },
  dataDirectory: '纯渲染夹具，无业务数据',
};
const configuration = join(directory, 'fixture.json'); writeFileSync(configuration, JSON.stringify({ snapshot, userData: join(directory, 'userData') }));
const env = { ...process.env, CODEX_RESUME_RENDERER_FIXTURE: configuration }; delete env.ELECTRON_RUN_AS_NODE;
const instance = await electron.launch({ args: [resolve('scripts/fixtures/renderer.cjs')], env });
const errors = [];
try {
  const page = await instance.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  const region = label => page.locator(`.data-region[aria-label="${label}"]`);
  const nav = name => page.locator('nav').getByRole('button', { name });
  const hold = kind => instance.evaluate((_, kind) => { globalThis.rendererFixture.hold.add(kind); }, kind);
  const finish = (kind, value, error) => instance.evaluate((_, args) => globalThis.rendererFixture.finish(...args), [kind, value, error]);
  const publish = value => instance.evaluate((_, value) => globalThis.rendererFixture.publish(value), value);
  const pending = kind => expect.poll(() => instance.evaluate((_, kind) => globalThis.rendererFixture.pending.filter(row => row.kind === kind).length, kind)).toBe(1);
  await expect(region('5 小时额度')).toHaveAttribute('aria-busy', 'true');
  await expect(region('托管中的会话').getByText('把等待的时间交给这里')).toBeHidden();
  await expect(page.getByText('自动续跑如何工作', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(artifacts, 'overview-loading.png') });
  await nav('? 使用说明').click();
  await expect(region('当前更新设置')).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('heading', { name: 'Codex Resume 使用说明书', exact: true })).toBeVisible();
  // 首屏失败与重试；等待时导航可用，设置晚到后使用真实值。
  await nav('⚙ 应用设置').click(); await expect(region('额度检查配置')).toHaveAttribute('aria-busy', 'true');
  await finish('snapshot', null, '模拟首屏读取失败');
  await expect(region('额度检查配置').getByRole('alert')).toContainText('模拟首屏读取失败');
  await region('额度检查配置').getByRole('button', { name: '重试' }).click(); await pending('snapshot');
  const connecting = structuredClone(snapshot); connecting.connection = { state: 'connecting', message: '', checkedAt: null }; connecting.quota = null; connecting.threads = [];
  await finish('snapshot', connecting); await expect(page.locator('#quota-check-interval')).toHaveValue('30');
  await page.locator('#quota-check-interval').fill('45'); await page.locator('#quota-check-interval').press('Tab');
  await publish(snapshot); await expect(page.locator('#quota-check-interval')).toHaveValue('45');
  // 本机模块先就绪，远程模块各自继续等待。
  await publish(connecting); await nav('◫ 运行总览').click();
  await expect(region('5 小时额度')).toHaveAttribute('aria-busy', 'true');
  await expect(region('托管中的会话')).toHaveAttribute('aria-busy', 'false');
  await nav('▤ 托管任务').click(); await expect(region('Codex 会话列表')).toHaveAttribute('aria-busy', 'true');
  await publish(snapshot); await expect(region('Codex 会话列表')).toHaveAttribute('aria-busy', 'false');
  // 对话框只有模板区域等待；不提交托管。
  await hold('templates'); await page.getByRole('button', { name: '托管会话', exact: true }).click(); await pending('templates');
  await expect(region('可用模板')).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('button', { name: '确认并开始托管' })).toBeDisabled();
  await finish('templates', { templates: [{ id: 'template', name: '夹具模板', body: '夹具默认正文', isDefault: true }] });
  await expect(page.getByRole('dialog').locator('textarea')).toHaveValue('夹具默认正文');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  // 模板响应晚到不能覆盖用户已输入的正文。
  await page.getByRole('button', { name: '托管会话', exact: true }).click(); await pending('templates');
  await page.getByRole('dialog').locator('textarea').fill('用户在等待期间编辑的正文');
  await finish('templates', { templates: [{ id: 'template', name: '夹具模板', body: '不应覆盖用户输入', isDefault: true }] });
  await expect(page.getByRole('dialog').locator('textarea')).toHaveValue('用户在等待期间编辑的正文');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  // 列表失败不遮挡编辑器，重试保留草稿。
  await nav('✎ 提示词模板').click(); await pending('templates');
  await expect(region('提示词模板')).toHaveAttribute('aria-busy', 'true'); await page.getByPlaceholder('模板名称').fill('保留草稿');
  await finish('templates', null, '模拟模板读取失败');
  await expect(region('提示词模板').getByRole('alert')).toContainText('模拟模板读取失败');
  await region('提示词模板').getByRole('button', { name: '重试' }).click(); await pending('templates'); await finish('templates', { templates: [] });
  await expect(page.getByPlaceholder('模板名称')).toHaveValue('保留草稿'); await expect(region('提示词模板')).toContainText('暂无模板');
  // 快速切换查询，旧响应不能覆盖新结果；筛选器等待期间可用。
  await hold('archives'); await hold('events'); await nav('◷ 历史归档').click(); await pending('archives');
  await expect(region('历史查询结果')).toHaveAttribute('aria-busy', 'true');
  await page.getByRole('button', { name: '检索历史日志', exact: true }).click(); await pending('events');
  await expect(page.getByPlaceholder('事件类型（精确匹配）')).toBeVisible();
  await finish('events', { events: [{ id: 9, time: Date.now(), taskId: null, taskName: null, type: '最新夹具事件', details: {} }] });
  await finish('archives', { archives: [] }); await expect(region('历史查询结果')).toContainText('最新夹具事件');
  await expect(region('历史查询结果')).not.toContainText('暂无匹配事件'); await page.screenshot({ path: join(artifacts, 'history-results.png') });
  // 自检只加载对应结果。
  await nav('◫ 运行总览').click(); await hold('selfCheck');
  await page.getByRole('button', { name: '运行只读自检', exact: true }).click(); await pending('selfCheck');
  await expect(region('连接与兼容性自检结果')).toHaveAttribute('aria-busy', 'true');
  await expect(region('5 小时额度')).toHaveAttribute('aria-busy', 'false'); await finish('selfCheck', snapshot);
  // 卡片与预约独立完成；心跳更新无加载闪动。
  await hold('resetCardsRefresh'); await hold('resetAppointments'); await nav('☰ 重置卡').click();
  await pending('resetCardsRefresh'); await pending('resetAppointments');
  await expect(region('真实卡片明细')).toHaveAttribute('aria-busy', 'true'); await page.getByRole('tab', { name: '预约管理', exact: true }).click();
  await expect(region('进行中的预约')).toHaveAttribute('aria-busy', 'true'); await finish('resetAppointments', { resetAppointments: [] });
  await expect(region('进行中的预约')).toHaveAttribute('aria-busy', 'false'); await expect(region('可预约卡片')).toHaveAttribute('aria-busy', 'true');
  await finish('resetCardsRefresh', snapshot); await expect(region('可预约卡片')).toHaveAttribute('aria-busy', 'false');
  // 命令返回快照可能触发一次心跳查询，先收束再主动推送。
  const background = await instance.evaluate(() => globalThis.rendererFixture.pending.some(row => row.kind === 'resetAppointments'));
  if (background) await finish('resetAppointments', { resetAppointments: [] });
  await publish({ ...snapshot, runtime: { state: 'running', heartbeatAt: Date.now() + 1000 } }); await pending('resetAppointments');
  await expect(region('进行中的预约')).toHaveAttribute('aria-busy', 'false'); await finish('resetAppointments', { resetAppointments: [] });
  await page.getByRole('tab', { name: '执行记录', exact: true }).click(); await expect(region('重置卡执行记录')).toContainText('暂无执行记录');
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
  await page.screenshot({ path: join(artifacts, 'reset-records-narrow.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); assert.deepEqual(errors, []);
  const result = { mode: 'simulation', checks: ['initial-module-loading', 'navigation-during-loading', 'snapshot-error-retry', 'late-settings-hydration',
    'draft-survives-push', 'local-remote-independent', 'dialog-template-loading', 'late-template-preserves-prompt', 'manual-loading-with-offline-content', 'template-retry', 'history-latest-response', 'filters-during-loading',
    'inspection-only-loading', 'cards-appointments-independent', 'background-no-flicker', 'narrow-layout'], errors, sends: 0, cardConsumes: 0 };
  writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await instance.close(); }
