// 卡片预加载：只暴露固定的几个方法，没有通用 IPC、没有文件读取、没有任意 URL 打开。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('koDesktop', {
  setCollapsed: (collapsed) => {
    if (typeof collapsed === 'boolean') ipcRenderer.send('card:set-collapsed', collapsed);
  },
  hideCard: () => ipcRenderer.send('card:hide'),
  openTree: () => ipcRenderer.send('shell:open-tree'),
  onVisibility: (handler) => {
    if (typeof handler !== 'function') return;
    ipcRenderer.on('card:visibility', (_event, visible) => handler(Boolean(visible)));
  },
});
