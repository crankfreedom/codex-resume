<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { Snapshot } from '../../src/app/contracts.ts';
import { version } from '../../package.json';
import { manualChapters, searchManual } from './manual.ts';
import logoUrl from '../../resources/icons/logo.png?url';

const props = defineProps<{ snapshot: Snapshot | null }>();
const query = ref('');
const selectedId = ref('start');
const directoryOpen = ref(false);
const reader = ref<HTMLElement | null>(null);
const chapters = computed(() => searchManual(query.value));
const chapter = computed(() => chapters.value.find(item => item.id === selectedId.value) ?? chapters.value[0]);
const currentIndex = computed(() => chapters.value.findIndex(item => item.id === chapter.value?.id));
const checkedTime = computed(() => {
  const value = props.snapshot?.quota?.checkedAt;
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无可用额度快照';
});
const number = (id: string) => String(manualChapters.findIndex(item => item.id === id) + 1).padStart(2, '0');
function select(id?: string) { if (id) selectedId.value = id; }
function leaveDirectory(event: FocusEvent) {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) directoryOpen.value = false;
}
watch(() => chapter.value?.id, async () => {
  await nextTick();
  reader.value?.scrollTo({ top: 0 });
});
</script>

<template>
  <section class="manual-page" aria-label="应用使用说明书">
    <div class="card manual-intro">
      <img class="manual-book" :src="logoUrl" alt="" aria-hidden="true">
      <div class="manual-intro-main">
        <div class="manual-kicker">随应用提供 · 离线可查阅</div>
        <h2>Codex Resume 使用说明书</h2>
        <p>从第一次托管，到额度恢复后的原会话续跑。共 {{ manualChapters.length }} 章，按当前实现逐项说明。</p>
      </div>
      <div class="manual-edition">v{{ version }}<span>核对日期 2026-10-26</span></div>
    </div>

    <div class="manual-live" aria-label="当前更新设置">
      <span>任务检查间隔 <strong>{{ snapshot ? `${snapshot.settings.pollSeconds} 秒` : '读取中' }}</strong></span>
      <span>额度查询策略 <strong>{{ snapshot ? snapshot.settings.quotaCheck.mode === 'recovery' ? '按预计恢复时间' : '固定时间间隔' : '读取中' }}</strong></span>
      <span>本地状态快照 <strong>约 2 秒</strong></span>
      <span>总览额度最近读取 <strong>{{ checkedTime }}</strong></span>
      <span>下次额度查询 <strong>{{ snapshot?.nextQuotaCheckAt ? new Date(snapshot.nextQuotaCheckAt).toLocaleString('zh-CN', { hour12: false }) : '等待首次查询' }}</strong></span>
    </div>

    <div class="manual-layout">
      <div class="manual-directory-dock" :class="{ 'is-open': directoryOpen }"
        @mouseenter="directoryOpen = true" @mouseleave="directoryOpen = false"
        @focusin="directoryOpen = true" @focusout="leaveDirectory" @keydown.esc="directoryOpen = false">
        <button class="manual-directory-tab" type="button" aria-label="展开查找说明" aria-controls="manual-directory"
          :aria-expanded="directoryOpen" title="悬浮展开目录与搜索" @click="directoryOpen = true">查找说明</button>
        <aside id="manual-directory" class="card manual-directory" :inert="!directoryOpen" aria-label="查找说明与章节目录">
          <div class="manual-search">
            <label for="manual-query">查找说明</label>
            <el-input id="manual-query" v-model="query" placeholder="登录、刷新、额度、回执…" clearable />
            <p aria-live="polite">{{ query.trim() ? `找到 ${chapters.length} 个相关章节` : '目录 / 选择章节阅读' }}</p>
          </div>
          <nav class="manual-toc" aria-label="说明书目录">
            <button v-for="item in chapters" :key="item.id" :class="{ active: chapter?.id === item.id }"
              :aria-current="chapter?.id === item.id ? 'page' : undefined" @click="select(item.id)">
              <span>{{ number(item.id) }}</span><div>{{ item.title }}<small>{{ item.summary }}</small></div>
            </button>
          </nav>
          <div class="manual-directory-foot">阅读与搜索不发起操作命令。<br>已开启的后台托管仍会继续。</div>
        </aside>
      </div>

      <article v-if="chapter" class="card manual-article" aria-label="说明书正文">
        <div ref="reader" class="manual-reader" tabindex="0" aria-label="可滚动的章节正文">
          <div class="manual-chapter-label">CHAPTER {{ number(chapter.id) }} / {{ manualChapters.length }}</div>
          <h2>{{ chapter.title }}</h2>
          <p class="manual-summary">{{ chapter.summary }}</p>
          <section v-for="block in chapter.blocks" :key="block.title" class="manual-block">
            <h3>{{ block.title }}</h3>
            <p v-for="paragraph in block.paragraphs" :key="paragraph">{{ paragraph }}</p>
            <ol v-if="block.steps"><li v-for="step in block.steps" :key="step">{{ step }}</li></ol>
            <ul v-if="block.bullets"><li v-for="item in block.bullets" :key="item">{{ item }}</li></ul>
            <div v-if="block.table" class="manual-table-wrap" tabindex="0" :aria-label="`${block.title}表格`">
              <table><thead><tr><th v-for="heading in block.table.headers" :key="heading" scope="col">{{ heading }}</th></tr></thead>
                <tbody><tr v-for="(row, index) in block.table.rows" :key="index"><td v-for="(cell, col) in row" :key="col">{{ cell }}</td></tr></tbody>
              </table>
            </div>
            <div v-if="block.callout" class="manual-callout" :class="block.callout.tone ?? 'info'">
              <strong>{{ block.callout.title }}</strong><p>{{ block.callout.text }}</p>
            </div>
          </section>
        </div>
        <footer class="manual-pager">
          <button :disabled="currentIndex <= 0" @click="select(chapters[currentIndex - 1]?.id)">← 上一章</button>
          <span>{{ currentIndex + 1 }} / {{ chapters.length }}{{ query.trim() ? ' 个匹配章节' : ' 章' }}</span>
          <button :disabled="currentIndex >= chapters.length - 1" @click="select(chapters[currentIndex + 1]?.id)">下一章 →</button>
        </footer>
      </article>
      <div v-else class="card manual-no-results" role="status">
        <div class="empty-icon">?</div><h2>没有找到匹配章节</h2>
        <p>试试“登录”“更新”“暂停”或“回执”，也可以清空关键词查看全部目录。</p>
        <el-button @click="query = ''">清空搜索</el-button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.manual-intro { display: flex; align-items: center; gap: 18px; padding: 23px 26px; }
.manual-book { width: 52px; height: 52px; display: block; object-fit: contain; flex-shrink: 0; }
.manual-intro-main { flex: 1; }
.manual-kicker { font-size:var(--font-secondary); color: #80a394; letter-spacing: 1px; margin-bottom: 8px; }
.manual-intro h2 { font-size:var(--font-section); font-weight: 600; }
.manual-intro p { color:var(--text-secondary); font-size:var(--font-secondary); margin: 9px 0 0; line-height:var(--content-line-height); }
.manual-edition { text-align: right; color: #5b897a; font-size:var(--font-body); }
.manual-edition span { display: block; color:var(--text-secondary); font-size:var(--font-secondary); margin-top: 8px; }
.manual-live { display: flex; flex-wrap: wrap; gap: 12px 23px; margin: 18px 3px; color:var(--text-secondary); font-size:var(--font-secondary); line-height:var(--content-line-height); }
.manual-live strong { margin-left: 6px; color: #5a7874; font-weight: 500; }
.manual-layout { position: relative; min-width: 0; }
.manual-directory-dock { position: absolute; top: 0; left: 0; z-index: 10; width: min(320px, 100%); height: 100%; pointer-events: none; }
.manual-directory-tab { position: absolute; top: 22px; right: 100%; width: 24px; padding: 14px 3px; border: 1px solid var(--accent-border); border-right: 0; border-radius: 7px 0 0 7px; background: var(--accent-soft); color: var(--accent-ink); font-size: var(--font-secondary); line-height: 1.3; letter-spacing: 3px; writing-mode: vertical-rl; pointer-events: auto; }
.manual-directory-tab:hover, .manual-directory-dock.is-open .manual-directory-tab { background: var(--accent); color: #fff; }
.manual-directory { display: flex; flex-direction: column; max-height: 100%; overflow: hidden; box-shadow: 8px 8px 28px #1d324626; opacity: 0; visibility: hidden; transform: translateX(-12px); transition: opacity 160ms ease, transform 160ms ease, visibility 160ms; }
.manual-directory-dock.is-open .manual-directory { opacity: 1; visibility: visible; transform: translateX(0); pointer-events: auto; }
.manual-search { padding: 18px 17px 0; }
.manual-search, .manual-directory-foot { flex-shrink: 0; }
.manual-search label { display: block; font-size:var(--font-secondary); font-weight: 600; margin-bottom: 10px; }
.manual-search p { font-size:var(--font-secondary); color:var(--text-secondary); margin: 12px 0; }
.manual-toc { display: block; flex: 1; min-height: 0; padding: 0 8px 8px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #d4dfdc transparent; }
.manual-toc button { width: 100%; gap: 11px; color: #536a72; align-items: flex-start; padding: 11px 9px; border: 1px solid transparent; margin-bottom: 3px; font-size:var(--font-secondary); }
.manual-toc button > span { font-size:var(--font-secondary); width: 17px; padding-top: 2px; color: #91aaa4; flex-shrink: 0; }
.manual-toc button > div { min-width: 0; line-height:var(--content-line-height); }
.manual-toc small { display: block; font-size:var(--font-secondary); line-height:var(--content-line-height); margin-top: 5px; color:var(--text-secondary); }
.manual-toc button:hover { background: #f4f8f6; }
.manual-toc button.active { background: #edf6f1; border-color: #e0eee5; color: #237c68; }
.manual-toc button.active > span { color: #499f83; }
.manual-directory-foot { padding: 12px 17px 15px; border-top: 1px solid #edf2ef; color:var(--text-secondary); line-height:var(--content-line-height); font-size:var(--font-secondary); }
.manual-reader { padding: 28px 30px; height: max(240px, calc(100vh - 405px)); overflow-y: auto; scrollbar-width: thin; scrollbar-color: #d1ded9 transparent; }
.manual-chapter-label { color: #88a69a; font-size:var(--font-secondary); letter-spacing: 1.5px; margin-bottom: 12px; }
.manual-reader > h2 { font-size:calc(var(--font-section) + 4px); font-weight: 600; letter-spacing: -.4px; }
.manual-summary { color:var(--text-secondary); font-size:var(--font-secondary); line-height:var(--content-line-height); padding-bottom: 23px; border-bottom: 1px solid #edf1f0; margin: 10px 0 0; }
.manual-block { margin-top: 26px; }
.manual-block h3 { font-size:var(--font-section); font-weight: 600; margin: 0 0 13px; color: #304c4c; }
.manual-block p, .manual-block li { font-size:var(--font-body); line-height:var(--content-line-height); color:var(--text-secondary); overflow-wrap: anywhere; }
.manual-block p { margin: 10px 0; }
.manual-block ol, .manual-block ul { padding-left: 21px; margin: 12px 0; }
.manual-block li { padding-left: 5px; margin-bottom: 10px; }
.manual-block li::marker { color: #4b927d; font-weight: 600; }
.manual-table-wrap { width: 100%; overflow: auto; margin: 14px 0; border: 1px solid #e5eeea; border-radius: 7px; }
.manual-table-wrap table { border-collapse: collapse; width: 100%; min-width: 440px; text-align: left; font-size:var(--font-secondary); line-height:var(--content-line-height); }
.manual-table-wrap th { font-weight: 500; color: #507566; background: #f1f7f3; padding: 10px 12px; white-space: nowrap; }
.manual-table-wrap td { border-top: 1px solid #eaf0ed; padding: 11px 12px; vertical-align: top; color:var(--text-secondary); overflow-wrap: anywhere; }
.manual-table-wrap td:first-child { color: #3f685d; min-width: 95px; }
.manual-callout { border-left: 3px solid #8ebfac; padding: 14px 16px; background: #f2f8f4; border-radius: 0 6px 6px 0; margin-top: 17px; }
.manual-callout strong { font-size:var(--font-secondary); color: #4b7c69; }
.manual-callout p { margin: 6px 0 0; font-size:var(--font-secondary); }
.manual-callout.important { background: #fff8eb; border-color: #d3ab68; }
.manual-callout.important strong { color: #9b783c; }
.manual-callout.important p { color: #9b8b6d; }
.manual-pager { padding: 15px 23px; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #edf2ef; gap: 10px; }
.manual-pager button { border: 0; border-radius: 5px; background: #f0f7f3; padding: 7px 10px; color: #458670; font-size:var(--font-secondary); }
.manual-pager button:disabled { color: #bbc9c1; background: #f7f9f7; cursor: default; }
.manual-pager span { font-size:var(--font-secondary); color:var(--text-secondary); }
.manual-no-results { padding: 76px 30px; text-align: center; min-height: 400px; }
.manual-no-results h2 { font-size:var(--font-body); }.manual-no-results p { font-size:var(--font-secondary); line-height:var(--content-line-height); color:var(--text-secondary); margin: 16px 0 22px; }
.manual-directory-tab:focus-visible, .manual-toc button:focus-visible, .manual-pager button:focus-visible, .manual-reader:focus-visible, .manual-table-wrap:focus-visible { outline: 2px solid #84b8a3; outline-offset: -2px; }
.manual-intro { flex-wrap: wrap; padding: var(--card-padding); }
.manual-intro-main { min-width: min(100%, 240px); }
.manual-intro h2 { font-size: var(--font-section); }
.manual-reader > h2 { font-size: calc(var(--font-section) + 4px); }
.manual-block h3 { font-size: var(--font-section); }
.manual-block p, .manual-block li, .manual-table-wrap table { font-size: var(--font-body); color: var(--text-body); }
.manual-table-wrap th, .manual-table-wrap td { line-height: var(--content-line-height); }
.manual-table-wrap td { color: var(--text-body); }
.manual-toc button { font-size: var(--font-nav); }
.manual-toc button.active { background: var(--accent-soft); border-color: var(--accent-border); color: var(--accent-ink); }
.manual-kicker, .manual-chapter-label, .manual-edition, .manual-toc button.active > span { color: var(--accent-ink); }
.manual-live { line-height: var(--content-line-height); }
.manual-pager { flex-wrap: wrap; }
.manual-pager button { background: var(--accent-soft); color: var(--accent-ink); font-size: var(--font-secondary); }
.manual-reader { height: max(260px, calc(100vh - 455px)); }
@media (prefers-reduced-motion: reduce) {
  .manual-directory { transition: none; }
}
@media (max-width: 1100px) {
  .manual-reader { padding: 23px 21px; }
  .manual-edition { display: none; }
  .manual-intro { padding: 20px; }
  .manual-live { gap: 8px 16px; }
}
</style>
