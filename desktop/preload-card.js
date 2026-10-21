// 卡片预加载：只暴露固定的几个方法，没有通用 IPC、没有文件读取、没有任意 URL 打开。
// 本地错误页（file://）只保留“收起卡片”一项能力，其余方法在错误页上不生效。
const { contextBridge, ipcRenderer } = require('electron');

const onServerPage = () => location.protocol === 'https:' || location.protocol === 'http:';

contextBridge.exposeInMainWorld('koDesktop', {
  setCollapsed: (collapsed) => {
    if (!onServerPage() || typeof collapsed !== 'boolean') return;
    ipcRenderer.send('card:set-collapsed', collapsed);
  },
  hideCard: () => ipcRenderer.send('card:hide'),
  retry: (kind) => ipcRenderer.send('shell:retry', String(kind || 'card').slice(0, 20)),
  openTree: () => {
    if (!onServerPage()) return;
    ipcRenderer.send('shell:open-tree');
  },
  onVisibility: (handler) => {
    if (typeof handler !== 'function') return;
    ipcRenderer.on('card:visibility', (_event, visible) => handler(Boolean(visible)));
  },
});
