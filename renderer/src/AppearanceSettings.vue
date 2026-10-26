<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { appearancePresets, defaultAppearance, fontSizeOptions, normalizeAppearance } from '../../src/app/appearance.ts';
import type { Appearance } from '../../src/app/appearance.ts';
import { useMonitor } from './store.ts';

const store = useMonitor();
const saved = computed(() => store.snapshot?.settings.appearance ?? defaultAppearance);
const draft = ref<Appearance>({ ...saved.value });
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(saved.value));
watch(() => JSON.stringify(saved.value), () => { draft.value = { ...saved.value }; });
watch(draft, value => { store.previewAppearance = normalizeAppearance(value); }, { deep: true });
onBeforeUnmount(() => { store.previewAppearance = null; });
function restore() { draft.value = { ...saved.value }; }
function defaults() { draft.value = { ...defaultAppearance }; }
function preset(value: Appearance) { draft.value = { ...value }; }
async function save() {
  if (!store.snapshot) return;
  const value = normalizeAppearance(draft.value);
  if (await store.command({ type: 'settings', value: { ...store.snapshot.settings, appearance: value } })) {
    draft.value = { ...value }; store.previewAppearance = null;
    ElMessage.success('外观已保存，所有页面已应用');
  }
}
</script>

<template>
  <section class="card appearance-card" aria-label="字号与页面外观设置">
    <div class="appearance-heading"><div><h2>字号与页面外观</h2><p>按阅读习惯调整。当前页面即时预览，保存后应用到所有页面并在重启后保留。</p></div><span class="appearance-dirty" v-if="dirty">有未保存的调整</span></div>
    <div class="appearance-presets"><span>阅读预设</span><el-button v-for="item in appearancePresets" :key="item.id" @click="preset(item.value)">{{ item.label }}</el-button></div>
    <div class="appearance-columns">
      <div class="appearance-options">
        <div v-for="option in fontSizeOptions" :key="option.key" class="appearance-option">
          <div><label :for="`appearance-${option.key}`">{{ option.label }}</label><small>{{ option.description }}</small></div>
          <div class="appearance-number"><el-input-number :id="`appearance-${option.key}`" v-model="draft[option.key]" :min="option.min" :max="option.max" :step="1" :value-on-clear="defaultAppearance[option.key]" /><span>px</span></div>
        </div>
        <div class="appearance-option"><div><label for="appearance-lineHeight">文字行高</label><small>正文与说明列表的行间距</small></div><div class="appearance-number"><el-input-number id="appearance-lineHeight" v-model="draft.lineHeight" :min="1.4" :max="2.2" :step="0.1" :precision="1" :value-on-clear="defaultAppearance.lineHeight" /><span>倍</span></div></div>
        <div class="appearance-option"><div><label for="appearance-fontFamily">界面字体</label><small>使用本机已安装的字体</small></div><el-select id="appearance-fontFamily" v-model="draft.fontFamily" aria-label="界面字体"><el-option label="系统默认" value="system" /><el-option label="微软雅黑" value="yahei" /></el-select></div>
        <div class="appearance-option"><div><label for="appearance-density">界面密度</label><small>调整卡片、列表和控件留白</small></div><el-select id="appearance-density" v-model="draft.density" aria-label="界面密度"><el-option label="舒适" value="comfortable" /><el-option label="紧凑" value="compact" /></el-select></div>
        <div class="appearance-option"><div><label for="appearance-accent">主题色</label><small>用于主按钮、选中导航与焦点</small></div><el-select id="appearance-accent" v-model="draft.accent" aria-label="主题色"><el-option label="青绿" value="teal" /><el-option label="蓝色" value="blue" /><el-option label="紫色" value="violet" /></el-select></div>
        <div class="appearance-option"><div><strong id="appearance-contrast-label">增强文字对比度</strong><small>加深正文与辅助文字，方便阅读</small></div><el-switch v-model="draft.highContrast" aria-labelledby="appearance-contrast-label" /></div>
      </div>
      <aside class="appearance-preview" aria-label="外观实时预览">
        <div class="preview-caption">实时预览</div><h3 class="preview-page-title">让阅读更轻松</h3>
        <h4>等待额度恢复</h4><p>这段正文展示当前字号和行高。保存后，总览、任务、日志、设置、使用说明和对话框会一起更新。</p>
        <div class="preview-secondary">辅助说明 · 最近检查 10:30:00</div>
        <div class="preview-actions"><el-button type="primary">主要按钮</el-button><el-button>普通按钮</el-button></div>
        <div class="preview-size-values">页面标题 {{ draft.pageTitleSize }}px<br>分区标题 {{ draft.sectionTitleSize }}px<br>正文 {{ draft.bodyFontSize }}px · 辅助 {{ draft.secondaryFontSize }}px<br>导航 {{ draft.navFontSize }}px · 行高 {{ draft.lineHeight }} 倍</div>
        <p class="preview-help">“标准阅读”已比旧版默认字体更大。需要更醒目时可选择“大字阅读”，再逐项微调。</p>
      </aside>
    </div>
    <div class="appearance-footer"><p>离开设置页会撤销未保存的预览；“恢复默认”也需要保存才会长期生效。字号按页面 CSS 像素设置，实际显示还受 Windows 缩放影响。</p><div><el-button :disabled="!dirty" @click="restore">撤销预览</el-button><el-button @click="defaults">恢复默认</el-button><el-button type="primary" :loading="store.busy" :disabled="!dirty || !store.snapshot" @click="save">保存外观</el-button></div></div>
  </section>
</template>

<style scoped>
.appearance-card { padding: var(--card-padding); margin-bottom: var(--section-gap); }
.appearance-heading { display: flex; gap: 16px; justify-content: space-between; align-items: start; }
.appearance-heading h2 { font-size: var(--font-section); margin: 0; }
.appearance-heading p, .appearance-footer p { color: var(--text-secondary); font-size: var(--font-secondary); line-height: var(--content-line-height); margin: 9px 0 0; }
.appearance-dirty { font-size: var(--font-secondary); color: var(--accent-ink); background: var(--accent-soft); padding: 4px 9px; border-radius: 5px; flex-shrink: 0; }
.appearance-presets { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 22px 0 10px; }
.appearance-presets > span { color: var(--text-secondary); font-size: var(--font-secondary); margin-right: 5px; }
.appearance-presets .el-button { margin: 0; }
.appearance-columns { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(250px, 1fr); gap: 28px; align-items: start; }
.appearance-option { display: flex; align-items: center; gap: 16px; padding: var(--row-padding) 0; border-bottom: 1px solid #e9eff0; }
.appearance-option > div:first-child { flex: 1; min-width: 0; }
.appearance-option label, .appearance-option strong { display: block; font-size: var(--font-body); font-weight: 500; }
.appearance-option small { display: block; font-size: var(--font-secondary); color: var(--text-secondary); margin-top: 6px; line-height: var(--content-line-height); }
.appearance-number { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.appearance-number > span { font-size: var(--font-secondary); color: var(--text-secondary); }
.appearance-number .el-input-number { width: 138px; }
.appearance-option .el-select { width: 162px; flex-shrink: 0; }
.appearance-preview { position: sticky; top: 18px; padding: 23px; background: var(--accent-soft); border: 1px solid var(--accent-border); border-radius: 9px; margin-top: 18px; min-width: 0; }
.preview-caption { color: var(--accent-ink); font-size: var(--font-secondary); margin-bottom: 20px; }
.preview-page-title { color: #263e47; font-size: var(--font-page-title); line-height: 1.3; margin: 0 0 24px; overflow-wrap: anywhere; }
.appearance-preview h4 { font-size: var(--font-section); margin: 0 0 12px; color: #304b53; }
.appearance-preview p { font-size: var(--font-body); line-height: var(--content-line-height); color: var(--text-body); }
.preview-secondary, .preview-size-values { font-size: var(--font-secondary); line-height: var(--content-line-height); color: var(--text-secondary); }
.preview-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 20px 0; }.preview-actions .el-button { margin: 0; }
.preview-size-values { padding-top: 18px; border-top: 1px solid var(--accent-border); }
.appearance-preview .preview-help { font-size: var(--font-secondary); color: var(--text-secondary); margin: 18px 0 0; }
.appearance-footer { background: #fff; border-top: 1px solid #e9eff0; margin-top: 22px; padding-top: 17px; padding-bottom: 3px; }
.appearance-footer p { margin: 0 0 14px; }.appearance-footer > div { display: flex; flex-wrap: wrap; gap: 10px; }.appearance-footer .el-button { margin: 0; }
@media (max-width: 1200px) { .appearance-columns { grid-template-columns: minmax(0, 1fr); gap: 16px; }.appearance-preview { position: static; margin-top: 0; }.appearance-heading { flex-wrap: wrap; } }
@media (max-width: 1100px) { .appearance-option { flex-wrap: wrap; }.appearance-option > div:first-child { min-width: min(100%, 220px); } }
</style>
