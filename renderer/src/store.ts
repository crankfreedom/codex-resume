import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import type { Bridge, Command, Snapshot } from '../../src/app/contracts.ts';
import { defaultAppearance } from '../../src/app/appearance.ts';
import type { Appearance } from '../../src/app/appearance.ts';
import { applyAppearance } from './appearance.ts';
declare global { interface Window { resume: Bridge } }

export const useMonitor = defineStore('monitor', () => {
  const snapshot = ref<Snapshot | null>(null);
  const busy = ref(false);
  const error = ref('');
  const previewAppearance = ref<Appearance | null>(null);
  const appearance = computed(() => previewAppearance.value ?? snapshot.value?.settings.appearance ?? defaultAppearance);
  watch(appearance, value => applyAppearance(value), { immediate: true, deep: true });
  let unsubscribe: (() => void) | undefined;
  async function start() {
    unsubscribe = window.resume.onSnapshot(value => { snapshot.value = value; });
    try { snapshot.value = await window.resume.snapshot(); } catch (e) { error.value = (e as Error).message; }
  }
  async function command(value: Command) {
    busy.value = true; error.value = '';
    try {
      // Vue 的嵌套响应式配置不能直接通过 Electron structured clone。
      const plain = JSON.parse(JSON.stringify(value)) as Command;
      snapshot.value = await window.resume.command(plain); return true;
    }
    catch (e) { error.value = (e as Error).message; return false; }
    finally { busy.value = false; }
  }
  function stop() { unsubscribe?.(); }
  return { snapshot, busy, error, previewAppearance, start, command, stop };
});
