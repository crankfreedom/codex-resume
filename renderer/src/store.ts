import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import type { Bridge, Command, EventFilter, Snapshot } from '../../src/app/contracts.ts';
import { defaultAppearance } from '../../src/app/appearance.ts';
import type { Appearance } from '../../src/app/appearance.ts';
import { applyAppearance } from './appearance.ts';
import { createResource, errorMessage } from './resource.ts';

declare global { interface Window { resume: Bridge } }

export const useMonitor = defineStore('monitor', () => {
  const snapshot = ref<Snapshot | null>(null);
  const snapshotPending = ref(false);
  const snapshotError = ref('');
  const pending = ref<Partial<Record<Command['type'], number>>>({});
  const error = ref('');
  const previewAppearance = ref<Appearance | null>(null);
  const appearance = computed(() => previewAppearance.value ?? snapshot.value?.settings.appearance ?? defaultAppearance);
  const busy = computed(() => Object.values(pending.value).some(count => (count ?? 0) > 0));
  const initializing = computed(() => !snapshotError.value && (!snapshot.value || snapshot.value.runtime.state === 'starting'));
  const tasks = computed(() => snapshot.value?.tasks ?? []);
  const threads = computed(() => snapshot.value?.threads ?? []);
  const events = computed(() => snapshot.value?.events ?? []);
  const active = computed(() => tasks.value.filter(task => task.enabled));
  const waiting = computed(() => active.value.filter(task => task.phase === 'waiting_quota'));
  const attention = computed(() => tasks.value.filter(task => ['suspended', 'send_uncertain'].includes(task.phase)));
  const displayQuota = computed(() => {
    const value = snapshot.value;
    return value?.inspection?.quota && value.inspection.quota.checkedAt > (value.quota?.checkedAt ?? 0)
      ? value.inspection.quota : value?.quota;
  });
  function isPending(...types: Command['type'][]) { return types.some(type => (pending.value[type] ?? 0) > 0); }
  const loading = computed(() => ({
    quota: initializing.value || (!displayQuota.value && snapshot.value?.connection.state === 'connecting') || isPending('refresh', 'refreshStatus', 'resetReconcile'),
    tasks: initializing.value || isPending('refresh', 'refreshData'),
    threads: initializing.value || (snapshot.value?.connection.state === 'connecting' && !threads.value.length) || isPending('refresh', 'refreshStatus'),
    events: initializing.value || isPending('refreshData'),
    settings: initializing.value,
    inspection: initializing.value || isPending('selfCheck', 'refreshStatus'),
    resetCards: initializing.value || isPending('resetCardsRefresh', 'resetReconcile'),
  }));
  watch(appearance, value => applyAppearance(value), { immediate: true, deep: true });
  let unsubscribe: (() => void) | undefined;
  let snapshotRequest: Promise<void> | undefined;
  let revision = 0;
  let generation = 0;
  function accept(value: Snapshot) { revision++; snapshot.value = value; snapshotError.value = ''; }
  function start(): Promise<void> {
    if (snapshotRequest) return snapshotRequest;
    if (!unsubscribe) unsubscribe = window.resume.onSnapshot(accept);
    const startedAt = revision;
    const session = generation;
    snapshotPending.value = true; snapshotError.value = '';
    snapshotRequest = (async () => {
      try {
        const value = await window.resume.snapshot();
        if (generation === session && revision === startedAt) accept(value);
      } catch (error) {
        if (generation === session && revision === startedAt) snapshotError.value = errorMessage(error);
      } finally {
        if (generation === session) { snapshotPending.value = false; snapshotRequest = undefined; }
      }
    })();
    return snapshotRequest;
  }
  async function command(value: Command) {
    pending.value[value.type] = (pending.value[value.type] ?? 0) + 1; error.value = '';
    try {
      // Vue 的嵌套响应式配置不能直接通过 Electron structured clone。
      const plain = JSON.parse(JSON.stringify(value)) as Command;
      const startedAt = revision;
      const result = await window.resume.command(plain);
      if (revision === startedAt) accept(result);
      const library = useLibrary();
      if (value.type === 'templateSave' || value.type === 'templateDelete') await library.templates.load({ force: true });
      if (['resetSchedule', 'resetCancel', 'resetReconcile'].includes(value.type)) await library.appointments.load({ force: true });
      return true;
    } catch (e) { error.value = errorMessage(e); return false; }
    finally { pending.value[value.type] = Math.max(0, (pending.value[value.type] ?? 1) - 1); }
  }
  function stop() { unsubscribe?.(); unsubscribe = undefined; generation++; snapshotRequest = undefined; snapshotPending.value = false; }
  return { snapshot, snapshotPending, snapshotError, busy, error, previewAppearance, tasks, threads, events,
    active, waiting, attention, displayQuota, initializing, loading, isPending, start, command, stop };
});

export const useLibrary = defineStore('library', () => {
  const templates = createResource(async () => (await window.resume.query({ type: 'templates' })).templates ?? []);
  const appointments = createResource(async () => (await window.resume.query({ type: 'resetAppointments' })).resetAppointments ?? []);
  const rows = computed(() => templates.state.data ?? []);
  const defaultTemplate = computed(() => rows.value.find(row => row.isDefault));
  const monitor = useMonitor();
  const availableCards = computed(() => monitor.snapshot?.resetCards.cards.filter(card => card.status === 'available') ?? []);
  const pendingAppointments = computed(() => (appointments.state.data ?? []).filter(row => ['pending', 'running', 'uncertain'].includes(row.status)));
  const appointmentRecords = computed(() => (appointments.state.data ?? []).filter(row => row.status !== 'pending'));
  return { templates, appointments, rows, defaultTemplate, availableCards, pendingAppointments, appointmentRecords };
});

export const useLocalData = defineStore('localData', () => {
  const exporting = ref(false);
  const error = ref('');
  async function exportEvents(filter?: EventFilter) {
    if (exporting.value) return null;
    exporting.value = true; error.value = '';
    try { return await window.resume.exportEvents(filter ? JSON.parse(JSON.stringify(filter)) : undefined); }
    catch (e) { error.value = errorMessage(e); return null; }
    finally { exporting.value = false; }
  }
  async function openDirectory() {
    try { await window.resume.openDataDirectory(); } catch (e) { error.value = errorMessage(e); }
  }
  async function quit() {
    try { await window.resume.quit(); } catch (e) { error.value = errorMessage(e); }
  }
  return { exporting, error, exportEvents, openDirectory, quit };
});
