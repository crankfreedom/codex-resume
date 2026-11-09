import { shallowReactive } from 'vue';

export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

// 同一资源合并重复读取；强制刷新以最后发起的请求为准。
export function createResource<T>(fetcher: () => Promise<T>) {
  const state = shallowReactive<{ data: T | null; pending: boolean; loaded: boolean; error: string }>({
    data: null, pending: false, loaded: false, error: '',
  });
  let sequence = 0;
  let inFlight: Promise<boolean> | undefined;
  function load(options: { force?: boolean; silent?: boolean } = {}): Promise<boolean> {
    if (inFlight && !options.force) return inFlight;
    const request = ++sequence;
    state.pending = !options.silent || !state.loaded;
    state.error = '';
    let result: Promise<T>;
    try { result = Promise.resolve(fetcher()); } catch (error) { result = Promise.reject(error); }
    inFlight = (async () => {
      try {
        const data = await result;
        if (request !== sequence) return false;
        state.data = data; state.loaded = true;
        return true;
      } catch (error) {
        if (request === sequence) state.error = errorMessage(error);
        return false;
      } finally {
        if (request === sequence) { state.pending = false; inFlight = undefined; }
      }
    })();
    return inFlight;
  }
  return { state, load };
}
