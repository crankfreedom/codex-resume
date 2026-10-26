import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const env = { ...process.env };
// Codex 终端可能继承 Electron 的 Node 模式，桌面壳需要真正的 GUI 模式。
delete env.ELECTRON_RUN_AS_NODE;
const mode = process.argv[2];
if (!['dev', 'preview'].includes(mode)) throw new Error('不支持的启动模式');
const cli = join(dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js');
const child = spawn(process.execPath, [cli, mode], { env, stdio: 'inherit', windowsHide: true });
child.on('exit', code => { process.exitCode = code ?? 1; });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
