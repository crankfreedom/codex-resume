import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import type { DataQuery, EventFilter } from '../../src/app/contracts.ts';
import { lifecycle } from '../../src/app/timeline.ts';
import { createResource } from './resource.ts';

function createHistory(taskId?: string) {
  const tab = ref(taskId ? 'timeline' : 'archives');
  const task = ref(taskId ?? '');
  const type = ref(''); const reason = ref(''); const from = ref(''); const to = ref('');
  const selectedTitle = ref('');
  const appliedFilter = ref<EventFilter>({});
  let query: DataQuery = { type: 'archives', limit: 50 };
  const resource = createResource(() => window.resume.query(JSON.parse(JSON.stringify(query)) as DataQuery));
  const archives = computed(() => resource.state.data?.archives ?? []);
  const events = computed(() => resource.state.data?.events ?? []);
  const attempts = computed(() => resource.state.data?.attempts ?? []);
  const revisions = computed(() => resource.state.data?.revisions ?? []);
  const next = computed(() => resource.state.data?.nextCursor);
  const phases = computed(() => lifecycle(events.value, attempts.value));
  function filter(): EventFilter {
    return { taskId: task.value || undefined, type: type.value || undefined, reason: reason.value || undefined,
      from: from.value ? new Date(from.value).getTime() : undefined, to: to.value ? new Date(to.value).getTime() : undefined };
  }
  function load(older = false) {
    if (older && (next.value === undefined || resource.state.pending)) return Promise.resolve(false);
    if (!older) appliedFilter.value = filter();
    const paging = { limit: 50, cursor: older ? next.value : undefined, boundary: older ? resource.state.data?.boundary : undefined };
    query = tab.value === 'archives' ? { type: 'archives', ...paging } : tab.value === 'timeline'
      ? { type: 'timeline', taskId: task.value, ...paging } : { type: 'events', filter: appliedFilter.value, ...paging };
    return resource.load({ force: true });
  }
  function clearFilters() { type.value = ''; reason.value = ''; from.value = ''; to.value = ''; }
  function logs(id: string) { clearFilters(); task.value = id; tab.value = 'events'; return load(); }
  function timeline(id: string, title = '') { clearFilters(); task.value = id; selectedTitle.value = title; tab.value = 'timeline'; return load(); }
  function retry() { return resource.load({ force: true }); }
  return reactive({ tab, task, type, reason, from, to, selectedTitle, appliedFilter, resource, archives, events,
    attempts, revisions, next, phases, filter, load, logs, timeline, retry });
}

export const useHistory = defineStore('history', () => {
  const sessions = reactive<Record<string, ReturnType<typeof createHistory>>>({});
  function session(key: string, taskId?: string) { return sessions[key] ??= createHistory(taskId); }
  function release(key: string) { delete sessions[key]; }
  return { sessions, session, release };
});
