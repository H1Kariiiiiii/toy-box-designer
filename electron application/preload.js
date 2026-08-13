/**
 * preload：通过 contextBridge 向渲染进程暴露安全的 API
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),
  generateImage: (opts) => ipcRenderer.invoke('image:generate', opts),
  saveFile: (opts) => ipcRenderer.invoke('file:save', opts),
  gsStatus: () => ipcRenderer.invoke('gs:status'),
  exportPdfX: (opts) => ipcRenderer.invoke('pdf:export', opts),
  listSchemes: () => ipcRenderer.invoke('scheme:list'),
  saveScheme: (s) => ipcRenderer.invoke('scheme:save', s),
  updateScheme: (id, s) => ipcRenderer.invoke('scheme:update', id, s),
  deleteScheme: (id) => ipcRenderer.invoke('scheme:delete', id),
  readImage: (p) => ipcRenderer.invoke('file:readImage', p),
  exportScheme: (id, forcePath) => ipcRenderer.invoke('scheme:export', id, forcePath),
  importScheme: (forcePath) => ipcRenderer.invoke('scheme:import', forcePath),
  visionCheck: (opts) => ipcRenderer.invoke('vision:check', opts),
  testApi: (opts) => ipcRenderer.invoke('api:test', opts),
  cacheInfo: () => ipcRenderer.invoke('cache:info'),
  cleanCache: (olderThanDays) => ipcRenderer.invoke('cache:clean', olderThanDays),
});
