import { defineConfig } from 'electron-vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

export default defineConfig({
  main: { build: { rolldownOptions: { input: {
    index: resolve('electron/main.ts'), worker: resolve('electron/worker.ts'),
  } } } },
  preload: { build: { rolldownOptions: {
    input: resolve('electron/preload.ts'), output: { format: 'cjs', entryFileNames: 'index.cjs' },
  } } },
  renderer: { root: resolve('renderer'), plugins: [vue()], build: { rolldownOptions: { input: resolve('renderer/index.html') } } },
});
