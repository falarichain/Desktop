const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('falariDesktop', {
  platform: process.platform,
  version: process.versions.electron,
});
