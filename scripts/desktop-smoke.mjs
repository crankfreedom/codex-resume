import { _electron as electron, expect } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const dataDirectory = mkdtempSync(join(tmpdir(), 'codex-resume-desktop-'));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const artifacts = resolve('var', 'desktop-smoke', version);
mkdirSync(artifacts, { recursive: true });
const executablePath = process.env.CODEX_RESUME_TEST_EXE;
const launchEnv = { ...process.env, CODEX_RESUME_DATA_DIR: dataDirectory };
delete launchEnv.ELECTRON_RUN_AS_NODE;
const instance = await electron.launch({
  ...(executablePath ? { executablePath, args: [] } : { args: [resolve('out/main/index.js')] }),
  env: launchEnv, timeout: 60000,
});
const childProcess = instance.process();
const errors = [];
childProcess.stderr.on('data', chunk => {
  const value = String(chunk);
  if (value.includes('[monitor]')) process.stdout.write(value);
});
try {
  const window = await instance.firstWindow();
  window.on('pageerror', error => errors.push(error.message));
  await window.getByRole('heading', { name: '运行总览', exact: true }).waitFor();
  const logo = window.getByRole('img', { name: 'Codex Resume Logo', exact: true });
  await expect.poll(() => logo.evaluate(element => element.complete && element.naturalWidth > 0)).toBe(true);
  const sourceLogo = readFileSync(resolve('resources/icons/logo.png'));
  const expectedHash = createHash('sha256').update(sourceLogo).digest('hex');
  const logoEvidence = await instance.evaluate(({ app, nativeImage }) => {
    const { readFileSync } = process.getBuiltinModule('node:fs');
    const { resolve, join } = process.getBuiltinModule('node:path');
    const { createHash } = process.getBuiltinModule('node:crypto');
    const path = app.isPackaged ? join(app.getAppPath(), 'resources/icons/logo.png') : resolve('resources/icons/logo.png');
    const bytes = readFileSync(path);
    const native = nativeImage.createFromBuffer(bytes);
    return { hash: createHash('sha256').update(bytes).digest('hex'), size: native.getSize(), empty: native.isEmpty() };
  });
  assert.equal(logoEvidence.hash, expectedHash); assert.equal(logoEvidence.empty, false);
  assert.equal(await logo.evaluate(element => element.naturalWidth), logoEvidence.size.width);
  await expect.poll(async () => {
    const value = await window.evaluate(() => window.resume.snapshot());
    return value.runtime.state === 'running' && value.connection.state !== 'connecting';
  }, { timeout: 60000, intervals: [500, 1000, 2000] }).toBe(true);
  let snapshot = await window.evaluate(() => window.resume.snapshot());
  assert.equal(snapshot.runtime.state, 'running');
  assert.equal(snapshot.connection.state, 'connected', snapshot.connection.message);
  assert.ok(snapshot.threads.length > 0, '真实连接冒烟要求读取到本机会话');
  assert.equal(snapshot.quota?.windows.length, 2);
  console.log(JSON.stringify({ connection: snapshot.connection, threads: snapshot.threads.length, windows: snapshot.quota?.windows.length }));
  await window.getByText(snapshot.connection.state === 'connected' ? 'Codex 已连接' : 'Codex 未连接', { exact: true }).waitFor();
  assert.equal(snapshot.tasks.length, 0);
  assert.ok(!JSON.stringify(snapshot).includes('accountId'));
  await window.screenshot({ path: join(artifacts, 'overview.png'), animations: 'disabled' });
  await window.getByRole('button', { name: '? 使用说明', exact: true }).click();
  await window.getByRole('heading', { name: 'Codex Resume 使用说明书', exact: true }).waitFor();
  const directoryTab = window.getByRole('button', { name: '展开查找说明', exact: true });
  const directoryPanel = window.locator('.manual-directory');
  const manualQuery = window.getByLabel('查找说明', { exact: true });
  const articleBounds = await window.locator('.manual-article').boundingBox();
  await expect(directoryTab).toHaveAttribute('aria-expanded', 'false');
  await expect(directoryPanel).toBeHidden();
  assert.equal(await window.locator('.manual-layout').evaluate(element => {
    const article = element.querySelector('.manual-article').getBoundingClientRect();
    const layout = element.getBoundingClientRect();
    return article.x === layout.x && article.width === layout.width;
  }), true, '收起目录后正文应占满阅读区');
  await window.screenshot({ path: join(artifacts, 'manual.png'), animations: 'disabled' });
  // 键盘可从正文回到左侧标签，再进入搜索；Escape 收起浮层。
  await window.locator('.manual-reader').focus();
  await window.keyboard.press('Shift+Tab');
  await expect(directoryTab).toBeFocused();
  await expect(directoryPanel).toBeVisible();
  await window.keyboard.press('Tab');
  await expect(manualQuery).toBeFocused();
  await window.keyboard.press('Escape');
  await expect(directoryPanel).toBeHidden();
  await directoryTab.hover();
  await expect(directoryPanel).toBeVisible();
  await expect(directoryTab).toHaveAttribute('aria-expanded', 'true');
  assert.equal(await window.getByRole('navigation', { name: '说明书目录' }).getByRole('button').count(), 13);
  assert.deepEqual(await window.locator('.manual-article').boundingBox(), articleBounds, '浮层展开不能挤占或移动正文');
  await manualQuery.hover();
  await expect(directoryPanel).toBeVisible();
  assert.equal(await directoryPanel.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + 20));
  }), true, '目录必须浮在正文上方');
  await window.screenshot({ path: join(artifacts, 'manual-directory-open.png'), animations: 'disabled' });
  await manualQuery.fill('刷新');
  await window.getByRole('navigation', { name: '说明书目录' }).getByRole('button', { name: /数据何时更新/ }).click();
  await window.getByRole('heading', { name: '数据何时更新', exact: true }).waitFor();
  await window.getByText('刷新也可能推进自动续跑', { exact: true }).scrollIntoViewIfNeeded();
  await window.mouse.move(articleBounds.x + articleBounds.width - 20, articleBounds.y + 20);
  await expect(directoryPanel).toBeHidden();
  await window.screenshot({ path: join(artifacts, 'manual-timing.png'), animations: 'disabled' });
  await directoryTab.hover();
  await manualQuery.fill('隐私');
  await window.getByRole('heading', { name: '本地数据与隐私范围', exact: true }).waitFor();
  await manualQuery.fill('不存在的说明关键词xyz');
  await window.getByRole('heading', { name: '没有找到匹配章节', exact: true }).waitFor();
  await window.getByRole('button', { name: '清空搜索', exact: true }).click();
  await expect(directoryPanel).toBeHidden();
  await directoryTab.hover();
  await expect(directoryPanel).toBeVisible();
  await expect(window.getByRole('navigation', { name: '说明书目录' }).getByRole('button')).toHaveCount(13);
  await window.mouse.move(articleBounds.x + articleBounds.width - 20, articleBounds.y + 20);
  await expect(directoryPanel).toBeHidden();
  await window.getByRole('button', { name: '下一章 →', exact: true }).click();
  await window.getByRole('heading', { name: '自动续跑的完整条件', exact: true }).waitFor();
  // 最窄支持窗口中目录与正文均能滚动，页面本身不出现水平溢出。
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
  await window.screenshot({ path: join(artifacts, 'manual-narrow.png'), animations: 'disabled' });
  assert.equal(await window.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  // 缩窗可能保留滚动偏移；测量前回到页首，避免 hover 自动滚动被误判为正文重排。
  await window.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  const narrowBounds = await window.locator('.manual-article').boundingBox();
  await directoryTab.hover();
  await expect(directoryPanel).toBeVisible();
  assert.deepEqual(await window.locator('.manual-article').boundingBox(), narrowBounds);
  assert.equal(await directoryPanel.evaluate(element => element.getBoundingClientRect().right <= window.innerWidth), true);
  const directoryScroll = await window.locator('.manual-toc').evaluate(element => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  assert.ok(directoryScroll > 0, '窄窗口的浮层目录仍可独立滚动');
  await window.screenshot({ path: join(artifacts, 'manual-narrow-directory-open.png'), animations: 'disabled' });
  await window.mouse.move(narrowBounds.x + narrowBounds.width - 20, narrowBounds.y + 20);
  await expect(directoryPanel).toBeHidden();
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1240, 850));
  await window.getByRole('button', { name: '▤ 托管任务' }).click();
  await window.getByRole('heading', { name: '从 Codex 选择会话' }).waitFor();
  await window.screenshot({ path: join(artifacts, 'tasks.png') });
  // 打开真实托管对话框，但不提交，不触碰任何 Codex 会话。
  if (snapshot.threads.length) {
    await window.getByRole('button', { name: '托管会话', exact: true }).first().click();
    await window.getByRole('dialog').waitFor();
    assert.equal(await window.getByRole('button', { name: '确认并开始托管' }).isEnabled(), false);
    await window.screenshot({ path: join(artifacts, 'consent.png'), animations: 'disabled' });
    await window.getByRole('button', { name: '取消', exact: true }).click();
  }
  await window.getByRole('button', { name: '⚙ 应用设置' }).click();
  await window.getByRole('heading', { name: '字号与页面外观', exact: true }).waitFor();
  await window.getByRole('button', { name: '大字阅读', exact: true }).click();
  await expect.poll(() => window.locator('h1').evaluate(element => getComputedStyle(element).fontSize)).toBe('32px');
  await window.getByRole('button', { name: '◫ 运行总览', exact: true }).click();
  await expect.poll(() => window.locator('h1').evaluate(element => getComputedStyle(element).fontSize)).toBe('28px');
  await window.getByRole('button', { name: '⚙ 应用设置' }).click();
  const values = { pageTitleSize: '34', sectionTitleSize: '22', bodyFontSize: '20', secondaryFontSize: '15', navFontSize: '18', lineHeight: '1.9' };
  for (const [key, value] of Object.entries(values)) {
    await window.locator(`#appearance-${key}`).fill(value);
    await window.locator(`#appearance-${key}`).press('Tab');
  }
  await window.locator('.appearance-option').filter({ has: window.locator('#appearance-accent') }).locator('.el-select__wrapper').click();
  await window.getByRole('option', { name: '蓝色', exact: true }).click();
  await window.locator('.appearance-option').filter({ has: window.locator('#appearance-density') }).locator('.el-select__wrapper').click();
  await window.getByRole('option', { name: '紧凑', exact: true }).click();
  await window.getByRole('button', { name: '保存外观', exact: true }).click();
  await window.getByText('外观已保存，所有页面已应用', { exact: true }).waitFor();
  await window.evaluate(() => window.scrollTo({ top: 0 }));
  await window.screenshot({ path: join(artifacts, 'appearance.png'), animations: 'disabled', fullPage: true });
  snapshot = await window.evaluate(() => window.resume.snapshot());
  assert.equal(snapshot.settings.appearance.bodyFontSize, 20);
  assert.equal(snapshot.settings.appearance.accent, 'blue');
  await window.getByRole('button', { name: '◫ 运行总览', exact: true }).click();
  await expect.poll(() => window.locator('h1').evaluate(element => getComputedStyle(element).fontSize)).toBe('34px');
  assert.equal(await window.getByRole('button', { name: '↻ 刷新', exact: true }).evaluate(element => getComputedStyle(element).fontSize), '20px');
  await window.screenshot({ path: join(artifacts, 'appearance-overview.png'), animations: 'disabled' });
  await window.getByRole('button', { name: '? 使用说明', exact: true }).click();
  assert.equal(await window.locator('.manual-block p').first().evaluate(element => getComputedStyle(element).fontSize), '20px');
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
  assert.equal(await window.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await window.screenshot({ path: join(artifacts, 'appearance-manual-narrow.png'), animations: 'disabled' });
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1240, 850));
  await window.getByRole('button', { name: '⚙ 应用设置' }).click();
  await window.getByRole('heading', { name: '监控与桌面' }).waitFor();
  const quotaSettings = window.locator('.quota-check-settings');
  await expect(quotaSettings.getByRole('radio')).toHaveCount(0);
  await expect(quotaSettings.getByRole('switch')).toHaveCount(0);
  await expect(window.locator('#quota-recovery-delay')).toHaveCount(0);
  await expect(window.locator('#quota-check-interval')).toHaveValue('600');
  await expect(quotaSettings.getByText('定期查询额度，默认每 10 分钟检查一次。', { exact: false })).toBeVisible();
  await window.locator('#quota-check-interval').fill('30');
  await window.locator('#quota-check-interval').press('Tab');
  const switchControl = window.locator('.settings-card').filter({ has: window.getByRole('heading', { name: '监控与桌面', exact: true }) }).locator('.el-switch').first();
  await switchControl.click();
  await window.getByRole('button', { name: '保存设置' }).click();
  await window.getByText('设置已保存', { exact: true }).waitFor();
  snapshot = await window.evaluate(() => window.resume.snapshot());
  assert.equal(snapshot.settings.notifications, false);
  assert.equal(snapshot.settings.appearance.bodyFontSize, 20);
  assert.deepEqual(snapshot.settings.quotaCheck, { intervalSeconds: 30 });
  await quotaSettings.screenshot({ path: join(artifacts, 'quota-settings.png'), animations: 'disabled' });
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
  assert.equal(await window.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1240, 850));
  const workerPid = snapshot.runtime.pid;
  assert.ok(workerPid && workerPid !== childProcess.pid);
  process.kill(workerPid);
  await expect.poll(async () => {
    const value = await window.evaluate(() => window.resume.snapshot());
    return value.runtime.state === 'running' && value.runtime.pid !== workerPid && value.connection.state === 'connected';
  }, { timeout: 60000 }).toBe(true);
  snapshot = await window.evaluate(() => window.resume.snapshot());
  assert.equal(snapshot.settings.notifications, false);
  assert.equal(snapshot.settings.appearance.bodyFontSize, 20);
  assert.equal(snapshot.settings.appearance.density, 'compact');
  assert.deepEqual(snapshot.settings.quotaCheck, { intervalSeconds: 30 });
  await expect(window.locator('#quota-check-interval')).toHaveValue('30');
  await expect.poll(() => window.locator('h1').evaluate(element => getComputedStyle(element).fontSize)).toBe('34px');
  await window.screenshot({ path: join(artifacts, 'settings.png') });
  await window.getByRole('button', { name: '≡ 运行记录' }).click();
  await window.getByRole('heading', { name: '最近事件', exact: false }).waitFor();
  await window.screenshot({ path: join(artifacts, 'events.png') });
  // 浏览器窗口关闭后，托盘与 worker 必须保活。
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await instance.evaluate(({ app }) => app.emit('activate'));
  assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  snapshot = await window.evaluate(() => window.resume.snapshot());
  assert.equal(snapshot.runtime.state, 'running');
  assert.equal(snapshot.tasks.length, 0);
  assert.deepEqual(errors, []);
  const result = { time: new Date().toISOString(), version, packaged: Boolean(executablePath), connection: snapshot.connection.state,
    logo: logoEvidence,
    threadCount: snapshot.threads.length, quotaWindows: snapshot.quota?.windows.length ?? 0,
    checks: ['renderer', 'shared-logo-decoded', 'logo-source-hash', 'utility-process', 'sqlite', 'context-bridge', 'navigation', 'manual-menu', 'manual-hover-overlay-without-reflow', 'manual-directory-keyboard', 'manual-search-and-empty-state', 'manual-chapter-navigation', 'manual-narrow-layout', 'explicit-consent', 'appearance-preview-and-cancel', 'appearance-saved-across-pages', 'appearance-theme-and-density', 'appearance-persists-on-worker-restart', 'quota-periodic-default-600-and-persistence', 'settings', 'worker-crash-restart', 'tray-close', 'zero-task-sends'], errors };
  writeFileSync(join(artifacts, executablePath ? 'packaged-result.json' : 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await window.evaluate(() => window.resume.quit());
  await new Promise((resolveExit, reject) => {
    if (childProcess.exitCode != null) return resolveExit();
    const timer = setTimeout(() => reject(new Error('退出超时')), 40000);
    childProcess.once('exit', () => { clearTimeout(timer); resolveExit(); });
  });
} finally {
  if (childProcess.exitCode == null) await instance.close();
}
