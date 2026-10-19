// 设置窗口预加载：只暴露读取/保存服务器地址两件事。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('koSettings', {
  load: () => ipcRenderer.sendSync('settings:get'),
  save: (url) => ipcRenderer.invoke('settings:save', String(url || '')),
});
