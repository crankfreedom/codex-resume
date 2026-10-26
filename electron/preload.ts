import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge, Snapshot, Command } from '../src/app/contracts.ts';

const bridge: Bridge = {
  snapshot: () => ipcRenderer.invoke('resume:snapshot'),
  command: (command: Command) => ipcRenderer.invoke('resume:command', command),
  onSnapshot(callback) {
    const listener = (_: unknown, value: Snapshot) => callback(value);
    ipcRenderer.on('resume:update', listener);
    return () => ipcRenderer.removeListener('resume:update', listener);
  },
  exportEvents: () => ipcRenderer.invoke('resume:export'),
  openDataDirectory: () => ipcRenderer.invoke('resume:directory'),
  quit: () => ipcRenderer.invoke('resume:quit'),
};
contextBridge.exposeInMainWorld('resume', bridge);
