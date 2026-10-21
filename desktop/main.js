// AI Tree 桌面客户端：托盘常驻 + 可拖动卡片 + 按需创建的完整窗口。
// 安全基线：所有远程页面 nodeIntegration=false / contextIsolation=true / sandbox=true，
// 不忽略证书错误，不放开 webSecurity，不把凭据交给渲染进程。
const { app, BrowserWindow, Menu, Tray, ipcMain, screen, shell, dialog, nativeImage, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { normalizeBase, sameOrigin, isExactFile } = require('./security');

const CARD_W = 360;
const CARD_H = 220;
const CARD_H_COLLAPSED = 44;
const PARTITION = 'persist:aitree';

// —— 诊断日志：启动/失败路径全部落盘，失败现场可回溯 ——
// 位置 <userData>/logs/main.log，超过 512KB 轮转为 main.log.old。
let logFile = null;
function initLog() {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'main.log');
  } catch { logFile = null; }
}
function log(...parts) {
  const line = '[' + new Date().toISOString() + '] ' + parts
    .map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ') + '\n';
  try {
    if (logFile) {
      try { if (fs.statSync(logFile).size > 512 * 1024) fs.renameSync(logFile, logFile + '.old'); } catch {}
      fs.appendFileSync(logFile, line);
    }
  } catch {}
  try { process.stdout.write(line); } catch {}
}
initLog();
log('process start', {
  version: app.getVersion(),
  electron: process.versions.electron,
  execPath: process.execPath,
  argv: process.argv.slice(1),
});
process.on('uncaughtException', err => {
  log('uncaughtException', String((err && err.stack) || err));
});
process.on('unhandledRejection', reason => {
  log('unhandledRejection', String((reason && reason.stack) || reason));
});
app.on('render-process-gone', (_event, webContents, details) => {
  let url = '';
  try { url = webContents.getURL(); } catch {}
  log('render-process-gone', { url, ...details });
});
app.on('child-process-gone', (_event, details) => log('child-process-gone', details));

let tray = null;
let cardWin = null;
let mainWin = null;
let settingsWin = null;
let quitting = false;
let quitStartedAt = 0;
let firstCloseTold = false;
let cardVisible = true;
let alwaysOnTop = true;
let pendingSecondInstance = false;
// 框架 ready（app.isReady()）并不等于本应用初始化完成：
// whenReady 回调里还要建托盘、设置 session 权限、放开窗口。
// second-instance 只保证在框架 ready 之后触发，可能早于这些步骤。
let initDone = false;

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
// normalizeBase 已抽到 security.js（与测试共用同一实现）。

const baseUrl = () => normalizeBase(readConfig().serverUrl);
// 精确 origin 比较：不使用字符串前缀，避免同前缀域名/不同端口被误放行。
const isServerUrl = (target) => sameOrigin(target, baseUrl());

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

// 导航被后续导航取代（例如 4xx 后立刻切到本地错误页）会得到 ERR_ABORTED(-3)，
// 属正常流程，不计为加载失败。
function isAborted(err) {
  const message = String((err && err.message) || err || '');
  return (err && err.code === 'ERR_ABORTED') || message.includes('ERR_ABORTED');
}
function logLoadFailure(label, err) {
  if (isAborted(err)) return;
  log(label, String((err && err.stack) || err));
}

function guardWebContents(contents) {
  // 新窗口一律拒绝；外链交给系统浏览器，且只允许 http(s)。
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    // 只放行与配置服务器 origin 完全一致的导航（含错误页"重试"）。
    if (!isServerUrl(url)) {
      log('navigation blocked', { url: String(url).slice(0, 300) });
      event.preventDefault();
    }
  });
  contents.on('will-attach-webview', event => event.preventDefault());
}

// 页面加载失败分两类：网络/证书错误走 did-fail-load；
// 服务器可达但返回 4xx/5xx 走 did-navigate 的 httpResponseCode。
function attachLoadErrors(win, kind) {
  const contents = win.webContents;
  contents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === 0 || code === -3) return; // -3 是主动中止（重导航），不算失败
    log(kind + ' did-fail-load', { code, desc, url });
    showLocalError(win, kind, code, desc);
  });
  contents.on('did-navigate', (_e, url, httpResponseCode) => {
    if (!httpResponseCode || httpResponseCode < 400) return;
    log(kind + ' http status error', { code: httpResponseCode, url });
    showLocalError(win, kind, httpResponseCode, 'HTTP ' + httpResponseCode);
  });
}

// 服务器不可达 / 加载失败时，显示本地错误页（不忽略证书错误，保留正常校验）。
// “重试”由错误页直接导航回目标 URL；will-navigate 白名单保证只能回到我们的 base。
function showLocalError(win, kind, code, desc) {
  if (!win || win.isDestroyed()) return;
  const target = kind === 'card' ? baseUrl() + '/card.html' : baseUrl() + '/';
  if (!target) return; // 没有有效地址时由设置窗口接管
  const query = '?kind=' + encodeURIComponent(kind)
    + '&code=' + encodeURIComponent(String(code))
    + '&desc=' + encodeURIComponent(String(desc || ''))
    + '&target=' + encodeURIComponent(target);
  log('show local error page', { kind, code, desc });
  win.loadFile(path.join(__dirname, 'error.html'), { search: query })
    .catch(err => logLoadFailure('error page load failed', err));
  try { win.showInactive(); } catch {}
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
  attachLoadErrors(cardWin, 'card');
  cardWin.loadURL(baseUrl() + '/card.html')
    .catch(err => logLoadFailure('card loadURL rejected', err));
  cardWin.once('ready-to-show', () => { if (cardVisible && !cardWin.isDestroyed() && !cardWin.isVisible()) cardWin.showInactive(); });
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
  if (quitting) { log('showCard ignored (quitting)'); return; }
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
  if (quitting) { log('openMain ignored (quitting)'); return; }
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
  attachLoadErrors(mainWin, 'main');
  mainWin.loadURL(baseUrl() + '/')
    .catch(err => logLoadFailure('main loadURL rejected', err));
  mainWin.once('ready-to-show', () => { if (!mainWin.isDestroyed() && !mainWin.isVisible()) mainWin.show(); });
  mainWin.on('closed', () => { mainWin = null; });
  return mainWin;
}

function openSettings() {
  if (quitting) return;
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

function quitFromTray() {
  log('tray quit clicked', { initDone, card: !!cardWin, main: !!mainWin });
  quitting = true;
  quitStartedAt = Date.now();
  app.quit();
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
      { label: '退出 AI Tree', click: quitFromTray },
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

// —— IPC：只接受“本应用窗口 + 顶层 frame + 可信 origin”的调用 ——
// 三项缺一不可：避免同前缀域名、不同端口、iframe（非主 frame）借道调用。
function frameInfo(event) {
  let frame = null;
  let url = '';
  try {
    frame = event.senderFrame;
    url = frame && frame.url ? frame.url : '';
  } catch { frame = null; url = ''; }
  return {
    top: !!frame && frame.parent === null, // iframe 等子 frame 直接拒绝
    url,
    contents: event.sender,
  };
}

function isWindowSender(event, win) {
  return !!win && !win.isDestroyed() && !!event.sender && event.sender.id === win.webContents.id;
}

function fromCard(event) {
  const info = frameInfo(event);
  return info.top && isWindowSender(event, cardWin) && isServerUrl(info.url);
}

function fromMain(event) {
  const info = frameInfo(event);
  return info.top && isWindowSender(event, mainWin) && isServerUrl(info.url);
}

function fromSettings(event) {
  const info = frameInfo(event);
  return info.top && isWindowSender(event, settingsWin)
    && isExactFile(info.url, path.join(__dirname, 'settings.html'));
}

// 本地错误页只保留“收起卡片”这一项能力：必须是卡片窗口本身，且 URL 恰好是 error.html。
// 不按 file:// 前缀放行，避免卡片窗口里任何本地页面都能调用。
function fromCardErrorPage(event) {
  const info = frameInfo(event);
  return info.top && isWindowSender(event, cardWin)
    && isExactFile(info.url, path.join(__dirname, 'error.html'));
}

function rejectIpc(channel, event) {
  const info = frameInfo(event);
  log('ipc rejected', { channel, top: info.top, url: String(info.url).slice(0, 200) });
}

ipcMain.on('card:set-collapsed', (event, collapsed) => {
  if (!fromCard(event)) return rejectIpc('card:set-collapsed', event);
  if (typeof collapsed !== 'boolean') return;
  if (!cardWin || cardWin.isDestroyed()) return;
  const bounds = cardWin.getBounds();
  const height = collapsed ? CARD_H_COLLAPSED : CARD_H;
  if (bounds.height !== height) cardWin.setBounds({ ...bounds, height });
});

ipcMain.on('card:hide', event => {
  if (!fromCard(event) && !fromCardErrorPage(event)) return rejectIpc('card:hide', event);
  hideCard();
  tellFirstClose();
});

ipcMain.on('shell:open-tree', event => {
  if (!fromCard(event) && !fromMain(event)) return rejectIpc('shell:open-tree', event);
  openMain();
});

ipcMain.on('settings:get', event => {
  if (!fromSettings(event)) return rejectIpc('settings:get', event);
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
// 单实例锁：进程正常退出时锁由系统释放；但"退出后立刻双击"可能撞上旧进程
// 尚未退完的极短窗口。抢不到锁时短暂重试，仍失败才按第二实例退出。
// 重试期间若旧实例仍存活，它会收到 second-instance（等价于用户再点一次，幂等）。
async function acquireSingleInstanceLock(timeoutMs = 3000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    if (app.requestSingleInstanceLock()) {
      log('single instance lock acquired', { attempt });
      return true;
    }
    if (Date.now() >= deadline) {
      log('single instance lock not acquired', { attempt, waitedMs: timeoutMs });
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

function registerLifecycle() {
  app.on('second-instance', () => {
    // Electron 文档保证 second-instance 一定在框架 ready 之后触发（44.9.0 同样如此）。
    // 但“框架 ready”不等于“本应用初始化完成”：session 权限、托盘、配置读取
    // 都在 whenReady 回调里。所以按 initDone 排队，避免在半初始化状态下建窗口。
    log('second-instance', { ready: app.isReady(), initDone, quitting });
    if (!initDone) { pendingSecondInstance = true; return; }
    // 正在退出：绝不重建窗口，否则 app.quit() 会被新窗口取消，
    // 留下"托盘没了、锁还在"的僵尸进程，之后双击永远没反应。
    if (quitting) return;
    try {
      showCard();
      if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); }
    } catch (err) {
      log('second-instance handler failed', String((err && err.stack) || err));
    }
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

    // 仅用于自动化验收：用 --self-test-tray-menu 启动时把真实托盘菜单弹出，
    // 菜单项仍由外部真实 UI 点击（不是代码直接调用退出）。正常启动不会进入这里。
    if (process.argv.includes('--self-test-tray-menu')) {
      setTimeout(() => {
        try {
          log('self-test: popup tray menu');
          if (tray) tray.popUpContextMenu();
        } catch (err) {
          log('self-test popup failed', String((err && err.stack) || err));
        }
      }, 1500);
    }

    initDone = true;
    // 初始化期间收到过的双击：现在窗口体系就绪，补一次显示。
    if (pendingSecondInstance && !quitting) {
      pendingSecondInstance = false;
      log('flush pendingSecondInstance');
      showCard();
    }
  });

  app.on('before-quit', () => {
    if (!quitStartedAt) quitStartedAt = Date.now();
    log('before-quit', { quitting, elapsedMs: Date.now() - quitStartedAt });
    quitting = true;
    // 直接销毁窗口与托盘，避免 close 拦截拖住退出；session 仍会由 Electron 正常收尾。
    for (const win of [cardWin, mainWin, settingsWin]) {
      if (win && !win.isDestroyed()) { win.removeAllListeners('close'); win.destroy(); }
    }
    cardWin = mainWin = settingsWin = null;
    if (tray) { tray.destroy(); tray = null; }
  });

  // 不再 preventDefault + app.exit(0)：强制退出会跳过 session 落盘。
  // 只记录耗时，若退出被阻塞可以在这里看到。
  app.on('will-quit', () => {
    log('will-quit', { elapsedMs: quitStartedAt ? Date.now() - quitStartedAt : null });
  });
  app.on('quit', (_event, exitCode) => log('quit', { exitCode, elapsedMs: quitStartedAt ? Date.now() - quitStartedAt : null }));

  // 托盘常驻：所有窗口关掉也不退出（Electron 只要注册了该事件就不会自动退出）。
  app.on('window-all-closed', () => {});
}

(async () => {
  const gotLock = await acquireSingleInstanceLock();
  if (!gotLock) {
    // 已有存活实例：本次启动只负责把参数交给它，然后退出。
    app.quit();
    return;
  }
  registerLifecycle();
})();
