// AI Tree 桌面客户端：托盘常驻 + 可拖动卡片 + 按需创建的完整窗口。
// 安全基线：所有远程页面 nodeIntegration=false / contextIsolation=true / sandbox=true，
// 不忽略证书错误，不放开 webSecurity，不把凭据交给渲染进程。
const { app, BrowserWindow, Menu, Tray, ipcMain, screen, shell, dialog, nativeImage, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const CARD_W = 360;
const CARD_H = 220;
const CARD_H_COLLAPSED = 44;
const PARTITION = 'persist:aitree';

let tray = null;
let cardWin = null;
let mainWin = null;
let settingsWin = null;
let quitting = false;
let firstCloseTold = false;
let cardVisible = true;
let alwaysOnTop = true;

const configPath = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try {
    // 容忍带 BOM 的文件（Windows 记事本等编辑器会加）。
    const raw = fs.readFileSync(configPath(), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 1), { mode: 0o600 });
  return next;
}

// 只接受 https；回环地址允许 http（开发/隧道用）。
function normalizeBase(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
  let url;
  try { url = new URL(value); } catch { return ''; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback) return '';
  return url.origin;
}

const baseUrl = () => normalizeBase(readConfig().serverUrl);
const startsWithBase = (target) => {
  const base = baseUrl();
  if (!base || typeof target !== 'string') return false;
  try {
    const url = new URL(target);
    return url.origin === base;
  } catch { return false; }
};

// 窗口不可见时保证回到可见工作区（换屏、改缩放、拔掉扩展屏都会发生）。
function visibleBounds(saved) {
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return null;
  const area = screen.getDisplayMatching({ x: saved.x, y: saved.y, width: CARD_W, height: CARD_H }).workArea;
  const x = Math.min(Math.max(saved.x, area.x), area.x + area.width - CARD_W);
  const y = Math.min(Math.max(saved.y, area.y), area.y + area.height - CARD_H_COLLAPSED);
  const onScreen = screen.getAllDisplays().some(display => {
    const work = display.workArea;
    return x + CARD_W > work.x && x < work.x + work.width && y + CARD_H_COLLAPSED > work.y && y < work.y + work.height;
  });
  if (!onScreen) return null;
  // 必须保证"展开态"整窗可见，不能只保证收起态：
  // 曾实测卡片停在 y=1396（非主屏 workArea 未扣任务栏），收起可见但标题栏
  // 完全被任务栏盖住，无法拖动也无法点击。展开放不下就回到默认位置。
  const fitsExpanded = y >= area.y && y + CARD_H <= area.y + area.height;
  return fitsExpanded ? { x, y } : null;
}

function defaultCardBounds() {
  const work = screen.getPrimaryDisplay().workArea;
  return { x: work.x + work.width - CARD_W - 24, y: work.y + 24, width: CARD_W, height: CARD_H };
}

function secureWebPreferences(preload) {
  return {
    ...(preload ? { preload } : {}),
    partition: PARTITION,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    spellcheck: false,
  };
}

function guardWebContents(contents) {
  // 新窗口一律拒绝；外链交给系统浏览器，且只允许 http(s)。
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    const base = baseUrl();
    let origin = '';
    try { origin = new URL(url).origin; } catch { origin = ''; }
    if (!base || origin !== base) event.preventDefault();
  });
  contents.on('will-attach-webview', event => event.preventDefault());
}

function createCard() {
  if (cardWin && !cardWin.isDestroyed()) return cardWin;
  const saved = visibleBounds(readConfig().cardBounds) || defaultCardBounds();
  cardWin = new BrowserWindow({
    ...saved,
    width: CARD_W,
    height: saved.height || CARD_H,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop,
    show: false,
    backgroundColor: '#f7f9f1',
    title: 'AI Tree',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: secureWebPreferences(path.join(__dirname, 'preload-card.js')),
  });
  guardWebContents(cardWin.webContents);
  cardWin.loadURL(baseUrl() + '/card.html');
  cardWin.once('ready-to-show', () => { if (cardVisible) cardWin.showInactive(); });
  // 页面加载完成后再补一次可见性，避免早于 preload 监听时丢掉首帧轮询。
  cardWin.webContents.once('did-finish-load', () => {
    if (cardWin && !cardWin.isDestroyed()) cardWin.webContents.send('card:visibility', cardVisible);
  });

  let saveTimer = null;
  const persist = () => {
    if (!cardWin || cardWin.isDestroyed()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!cardWin || cardWin.isDestroyed()) return;
      const bounds = cardWin.getBounds();
      writeConfig({ cardBounds: { x: bounds.x, y: bounds.y } });
    }, 400);
  };
  // 'moved' 只在交互式拖动结束时触发；程序化移动（换屏校正等）走 'move'。
  cardWin.on('moved', persist);
  cardWin.on('move', persist);

  const tell = visible => {
    if (cardWin && !cardWin.isDestroyed()) cardWin.webContents.send('card:visibility', visible);
  };
  cardWin.on('show', () => tell(true));
  cardWin.on('hide', () => tell(false));
  cardWin.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    hideCard();
  });
  return cardWin;
}

function showCard() {
  const win = createCard();
  cardVisible = true;
  if (!win.isVisible()) win.showInactive();
  win.setAlwaysOnTop(alwaysOnTop);
  win.webContents.send('card:visibility', true);
}

function hideCard() {
  cardVisible = false;
  if (cardWin && !cardWin.isDestroyed()) {
    cardWin.webContents.send('card:visibility', false);
    cardWin.hide();
  }
}

function toggleCard() {
  if (cardWin && !cardWin.isDestroyed() && cardWin.isVisible()) hideCard();
  else showCard();
}

function openMain() {
  if (mainWin && !mainWin.isDestroyed()) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
    return mainWin;
  }
  mainWin = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 640,
    show: false, backgroundColor: '#f3f5ee', title: 'AI Tree',
    icon: path.join(__dirname, 'icon.png'),
    // 完整窗口是纯远程页面，不需要 preload：不给它任何本地能力。
    webPreferences: secureWebPreferences(null),
  });
  guardWebContents(mainWin.webContents);
  mainWin.loadURL(baseUrl() + '/');
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.on('closed', () => { mainWin = null; });
  return mainWin;
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return settingsWin; }
  settingsWin = new BrowserWindow({
    width: 520, height: 340, resizable: false, minimizable: false, maximizable: false,
    title: 'AI Tree · 连接你的服务器', backgroundColor: '#fbfcf7',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
  return settingsWin;
}

function buildTray() {
  const image = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  tray = new Tray(image);
  tray.setToolTip('AI Tree');
  const refreshMenu = () => {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示卡片', click: showCard },
      { label: '打开能力树', click: openMain },
      { type: 'separator' },
      {
        label: '窗口置顶', type: 'checkbox', checked: alwaysOnTop,
        click: item => {
          alwaysOnTop = item.checked;
          if (cardWin && !cardWin.isDestroyed()) cardWin.setAlwaysOnTop(alwaysOnTop);
          writeConfig({ alwaysOnTop });
        },
      },
      { label: '服务器地址…', click: openSettings },
      { type: 'separator' },
      { label: '退出 AI Tree', click: () => { quitting = true; app.quit(); } },
    ]));
  };
  refreshMenu();
  tray.on('click', toggleCard);
  // setContextMenu 已在右键时自动弹出，这里只刷新勾选状态，避免弹两次。
  tray.on('right-click', refreshMenu);
}

function tellFirstClose() {
  if (firstCloseTold) return;
  firstCloseTold = true;
  if (tray) tray.displayBalloon?.({ title: 'AI Tree 仍在运行', content: '已收起到托盘，可从托盘菜单退出。' });
}

// —— IPC：只接受来自我们自己的窗口、顶层 frame 的参数 ——
function senderInfo(event) {
  const frame = event.senderFrame;
  const top = frame && frame.parent === null;
  const url = frame ? frame.url : '';
  return { top, url, webContents: event.sender };
}

function fromCard(event) {
  const info = senderInfo(event);
  return info.top && cardWin && !cardWin.isDestroyed() && info.webContents.id === cardWin.webContents.id
    && startsWithBase(info.url);
}

function fromMain(event) {
  const info = senderInfo(event);
  return info.top && mainWin && !mainWin.isDestroyed() && info.webContents.id === mainWin.webContents.id
    && startsWithBase(info.url);
}

function fromSettings(event) {
  const info = senderInfo(event);
  return info.top && settingsWin && !settingsWin.isDestroyed()
    && info.webContents.id === settingsWin.webContents.id && info.url.startsWith('file://');
}

ipcMain.on('card:set-collapsed', (event, collapsed) => {
  if (!fromCard(event) || typeof collapsed !== 'boolean') return;
  if (!cardWin || cardWin.isDestroyed()) return;
  const bounds = cardWin.getBounds();
  const height = collapsed ? CARD_H_COLLAPSED : CARD_H;
  if (bounds.height !== height) cardWin.setBounds({ ...bounds, height });
});

ipcMain.on('card:hide', event => {
  if (!fromCard(event)) return;
  hideCard();
  tellFirstClose();
});

ipcMain.on('shell:open-tree', event => {
  if (!fromCard(event) && !fromMain(event)) return;
  openMain();
});

ipcMain.on('settings:get', event => {
  if (!fromSettings(event)) return;
  event.returnValue = { serverUrl: readConfig().serverUrl || '', configPath: configPath() };
});

ipcMain.handle('settings:save', (event, raw) => {
  if (!fromSettings(event)) return { ok: false, reason: '来源不受信任' };
  const base = normalizeBase(raw);
  if (!base) return { ok: false, reason: '地址必须是以 https:// 开头的完整地址（本机回环可用 http://）' };
  writeConfig({ serverUrl: base });
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  if (cardWin && !cardWin.isDestroyed()) { cardWin.destroy(); cardWin = null; }
  if (mainWin && !mainWin.isDestroyed()) { mainWin.destroy(); mainWin = null; }
  showCard();
  openMain();
  return { ok: true, base };
});

// —— 生命周期 ——
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showCard();
    if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); }
  });

  app.whenReady().then(() => {
    // 设备权限一律拒绝：卡片与窗口都不需要摄像头、麦克风、通知等。
    session.fromPartition(PARTITION).setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.fromPartition(PARTITION).setPermissionCheckHandler(() => false);

    alwaysOnTop = readConfig().alwaysOnTop !== false;
    buildTray();

    if (!baseUrl()) {
      openSettings();
    } else {
      showCard();
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    for (const win of [cardWin, mainWin, settingsWin]) {
      if (win && !win.isDestroyed()) { win.removeAllListeners('close'); win.destroy(); }
    }
    cardWin = mainWin = settingsWin = null;
    if (tray) { tray.destroy(); tray = null; }
  });

  // 托盘常驻：所有窗口关掉也不退出（Electron 只要注册了该事件就不会自动退出）。
  app.on('window-all-closed', () => {});
}
