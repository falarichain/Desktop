const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('falariDesktop', {
  platform: process.platform,
  version: process.versions.electron,
  miningStatus: () => ipcRenderer.invoke('mining:status'),
  startMining: (config) => ipcRenderer.invoke('mining:start', config),
  stopMining: () => ipcRenderer.invoke('mining:stop'),
  getDiskFreeSpace: (dirPath) => ipcRenderer.invoke('disk:freeSpace', dirPath),
  safeStorageAvailable: () => ipcRenderer.invoke('safeStorage:available'),
  encryptSecret: (plaintext) => ipcRenderer.invoke('safeStorage:encrypt', plaintext),
  decryptSecret: (base64) => ipcRenderer.invoke('safeStorage:decrypt', base64),
  onMiningLog: (callback) => {
    const handler = (_event, line) => callback(line);
    ipcRenderer.on('mining-log', handler);
    return () => ipcRenderer.removeListener('mining-log', handler);
  },
  onMiningStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('mining-status', handler);
    return () => ipcRenderer.removeListener('mining-status', handler);
  },
});
