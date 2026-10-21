// 本地优先 MVP 验收矩阵（0.2.0 打包程序）。
// 覆盖：S1 首次启动 / S2 本地闭环（查看·任务·Skill 提交·待审确认）/
//       S3 重启持久化 / S4 回环等价断网 / S5 备份恢复 / S6 真实托盘退出。
// 用法：
//   KO_EXE=<exe> KO_PYTHON=<python> KO_SKILL_PY=<venv python> node test/local-mvp.cjs
// 全部使用 KO_USERDATA 隔离数据目录，不触碰真实 %APPDATA%\AI Tree。
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const EXE = process.env.KO_EXE;
const PY = process.env.KO_PYTHON;
const SKILL_PY = process.env.KO_SKILL_PY || PY;
const EXE_DIR = path.dirname(EXE);
const CDP_PORT = 9225;
const ROUNDS = Number(process.env.KO_ROUNDS || 1);
const OUT_DIR = process.env.KO_OUT_DIR || path.join(__dirname, 'out-local');
fs.mkdirSync(OUT_DIR, { recursive: true });

if (!EXE || !fs.existsSync(EXE)) { console.error('KO_EXE 无效'); process.exit(2); }

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, status: ok ? 'pass' : 'fail', detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}
// 环境受阻：既不算通过也不算失败，必须在报告里如实标注，禁止用来凑通过率。
function blocked(name, reason, detail) {
  results.push({ name, ok: false, status: 'blocked', reason, detail });
  console.log('BLOCKED ' + name + ' :: ' + reason + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function exePids() {
  const cmd = "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '"
    + EXE.replace(/'/g, "''") + "' } | ForEach-Object { [string]$_.ProcessId }";
  let out = '';
  try { out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' }); }
  catch (e) { out = e.stdout || ''; }
  return out.split(/\r?\n/).map(s => Number(s.trim())).filter(n => n > 0);
}

function runtimePyPids() {
  // 内置运行时的 python.exe（打包目录内），只动这个绝对路径下的进程
  const rt = path.join(EXE_DIR, 'resources', 'runtime', 'python.exe');
  const cmd = "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '"
    + rt.replace(/'/g, "''") + "' } | ForEach-Object { [string]$_.ProcessId }";
  let out = '';
  try { out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' }); }
  catch (e) { out = e.stdout || ''; }
  return out.split(/\r?\n/).map(s => Number(s.trim())).filter(n => n > 0);
}

function killTree(pids) {
  for (const pid of pids) {
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch {}
  }
}

async function killAll() {
  killTree(exePids());
  for (let i = 0; i < 40 && exePids().length > 0; i++) await sleep(250);
  killTree(runtimePyPids());
  for (let i = 0; i < 20 && runtimePyPids().length > 0; i++) await sleep(250);
  return exePids().length === 0 && runtimePyPids().length === 0;
}

let USERDATA_DIR = null;
function launch(extra = []) {
  const env = { ...process.env, KO_USERDATA: USERDATA_DIR };
  delete env.HTTP_PROXY; delete env.HTTPS_PROXY; delete env.http_proxy; delete env.https_proxy;
  const child = spawn(EXE, ['--remote-debugging-port=' + CDP_PORT, ...extra], {
    cwd: EXE_DIR, env, detached: true, stdio: 'ignore',
  });
  child.unref();
  return child;
}

function healthOnce(origin) {
  return new Promise(resolve => {
    const req = http.get(origin + '/api/health', { timeout: 2000 }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function connect() {
  const { chromium } = require('playwright-core');
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try { return await chromium.connectOverCDP('http://127.0.0.1:' + CDP_PORT); }
    catch { await sleep(700); }
  }
  throw new Error('CDP 连接超时（90s）');
}

function pageOf(browser, match) {
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      if (page.url().includes(match)) return page;
    }
  }
  return null;
}

// 主窗口 URL 是 origin + '/'（StaticFiles html 模式不改地址栏），必须整页匹配
function mainPageOf(browser, origin) {
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      try {
        const u = new URL(page.url());
        if (u.origin === origin && (u.pathname === '/' || u.pathname === '/index.html')) return page;
      } catch {}
    }
  }
  return null;
}

async function openMainFromCard(browser, origin) {
  if (!browser) return null;
  const existing = mainPageOf(browser, origin);
  if (existing) return existing;
  const card = pageOf(browser, '/card.html');
  if (!card) return null;
  await card.click('[data-act="tree"]').catch(() => {});
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const p = mainPageOf(browser, origin);
    if (p) return p;
    await sleep(500);
  }
  return null;
}

async function waitPage(browser, match, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = pageOf(browser, match);
    if (p) return p;
    await sleep(500);
  }
  return null;
}

// —— 包 ——
function pkg(id, key, title) {
  return {
    format: 'ko.learning-update', formatVersion: 1,
    submissionId: id, createdAt: new Date().toISOString(),
    sourceType: 'agent_skill', scope: '本地优先 MVP 验收：' + id,
    agent: { name: 'e2e-local' },
    fragments: [{ title: '本地验收资料', kind: 'user_original',
      text: '这是本地优先 MVP 验收使用的虚构资料原文，长度超过十个字符，用于生成待审更新包。' }],
    items: [{ key, title, layer: 1,
      summary: '用于验证本机提交、待审与确认闭环的验收节点。',
      concepts: [['本地优先', '数据保存在本机，联网是可选项']],
      tasks: ['在桌面端确认本节点已进入知识树'] }],
  };
}

// —— 主流程 ——
(async () => {
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const userData = path.join(OUT_DIR, 'userdata-' + stamp);
  USERDATA_DIR = userData;
  const dataDir = path.join(userData, 'local');
  const localDb = path.join(dataDir, 'ko.db');
  const authFile = path.join(dataDir, 'local-auth.json');
  const serverFile = path.join(dataDir, 'server.json');
  const skillHome = path.join(OUT_DIR, 'ko-sync-home-' + stamp);

  let browser = null;
  let card = null;
  let main = null;
  let origin = '';

  try {
    // ============ 前置清场 ============
    // 上一轮残留的实例会占住 18213：新实例的本地服务绑不上端口，
    // 而健康检查会打到旧服务，导致“看起来启动成功、数据却是上一轮的”。
    const cleaned = await killAll();
    check('前置：无残留 AI Tree / 内置运行时进程', cleaned, { exe: exePids().length, py: runtimePyPids().length });

    // ============ S1 首次启动 ============
    console.log('=== S1 首次启动 ===');
    check('S1 启动前无本地数据库', !fs.existsSync(localDb));
    launch();
    browser = await connect();
    card = await waitPage(browser, '/card.html', 90000);
    check('S1 卡片页面加载', !!card, card && card.url());
    if (card) {
      origin = new URL(card.url()).origin;
      check('S1 服务只监听回环', /^http:\/\/127\.0\.0\.1:\d+$/.test(origin), origin);
      const health = await healthOnce(origin);
      check('S1 /api/health 200', health);
    }
    for (let i = 0; i < 40 && !fs.existsSync(localDb); i++) await sleep(300);
    check('S1 ko.db 建立在使用者数据目录', fs.existsSync(localDb), localDb);
    check('S1 local-auth.json 建立', fs.existsSync(authFile));
    check('S1 server.json 建立（Skill 可发现）', fs.existsSync(serverFile), fs.existsSync(serverFile) && JSON.parse(fs.readFileSync(serverFile, 'utf8')).origin === origin ? origin : undefined);

    main = await openMainFromCard(browser, origin);
    check('S1 主窗口打开', !!main, main && main.url());
    if (main) {
      await main.waitForLoadState('domcontentloaded');
      await sleep(1500);
      check('S1 自动登录成功（未被重定向到 /login）', !main.url().includes('/login'), main.url());
      const ver = await main.textContent('#version-pill').catch(() => null);
      check('S1 版本徽章 v1（首次建库）', ver === 'v1', ver);
      const nodes = await main.textContent('#node-count').catch(() => null);
      // 服务端工作区设计为「空树 + 等待导入第一份资料」，不是前端演示种子。
      check('S1 首次启动为空树（真实工作区）', nodes && nodes.includes('0'), nodes);
      const emptyVisible = await main.isVisible('#empty-state').catch(() => false);
      check('S1 空状态提示可见', emptyVisible === true, emptyVisible);
    }

    // ============ S2 本地闭环 ============
    console.log('=== S2 本地闭环 ===');
    // 2.1 同步凭据（UI 所用同一 API）
    let token = '';
    if (main) {
      const t = await main.evaluate(async () => {
        const m = await import('/modules/server-api.js');
        return m.request('/sync/tokens', { method: 'POST', body: JSON.stringify({ label: 'e2e-local', expiresInDays: 1 }) });
      }).catch(e => ({ error: String(e) }));
      token = (t && t.token) || '';
      check('S2 生成同步凭据', !!token, t && (t.prefix || t.error));
    }

    // 2.3 Skill 本地目标：config --local 自动发现 + submit
    // 注意：不能从 EXE_DIR 往上推——交付包可能被放在任意交付目录（例如 %USERPROFILE%\AITreeLocal），
    // 与仓库不再相邻。脚本自身位置才是稳定锚点。
    const skillScript = path.join(__dirname, '..', '..', 'skill', 'knowledge-os-sync', 'scripts', 'ko_sync.py');
    // 打包目录外找仓库里的 skill；找不到则用资源副本
    const skillCandidates = [skillScript];
    const env = { ...process.env, KO_SYNC_HOME: skillHome,
      KO_DESKTOP_SERVER_FILE: serverFile,
      HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' };
    let usedSkill = null;
    for (const candidate of skillCandidates) {
      if (!fs.existsSync(candidate)) continue;
      usedSkill = candidate;
      break;
    }
    if (usedSkill && token) {
      let cfgOut = '';
      try {
        cfgOut = execFileSync(SKILL_PY, [usedSkill, 'config', '--local', '--token-stdin'],
          { input: token + '\n', env, encoding: 'utf8', timeout: 60000 });
      } catch (e) { cfgOut = String((e && (e.stdout || e.message)) || e); }
      check('S2 Skill config --local 发现本机实例', cfgOut.includes('本机 AI Tree') && cfgOut.includes(origin), cfgOut.trim().split('\n').slice(0, 3));

      const pkgFile = path.join(OUT_DIR, 'pkg1.json');
      fs.writeFileSync(pkgFile, JSON.stringify(pkg('e2e-local-0001', 'local-e2e-a', '本地优先验收节点 A'), null, 1));
      let subOut = '';
      try {
        subOut = execFileSync(SKILL_PY, [usedSkill, 'submit', '--file', pkgFile], { env, encoding: 'utf8', timeout: 120000 });
      } catch (e) { subOut = String((e && (e.stdout || e.message)) || e); }
      check('S2 Skill 提交到本机（目标明确）', subOut.includes('提交目标 本机 AI Tree') && subOut.includes('已提交'), subOut.trim().split('\n').slice(0, 4));
    } else {
      check('S2 Skill config --local 发现本机实例', false, 'token 或脚本缺失');
    }

    // 2.4 UI 待审确认
    if (main) {
      await main.click('button[data-action="sync"]').catch(e => check('S2 打开同步面板', false, String(e)));
      await sleep(1200);
      await main.click('.segmented button[data-batch="sync"]').catch(() => {});
      await sleep(1500);
      const pendingText = await main.textContent('body');
      check('S2 待审提交出现在界面', pendingText.includes('待审的同步提交') && pendingText.includes('e2e-local-0001'), null);
      await main.click('button[data-server-action="sync-open"]').catch(e => check('S2 打开审阅', false, String(e)));
      await sleep(1200);
      const before = await main.evaluate(async () => {
        const m = await import('/modules/server-api.js');
        const s = await m.request('/state');
        const snap = s.snapshots[s.snapshots.length - 1];
        return { version: snap.version, count: snap.nodes.length };
      });
      await main.click('button[data-server-action="apply"]').catch(e => check('S2 确认应用', false, String(e)));
      await sleep(2500);
      const after = await main.evaluate(async () => {
        const m = await import('/modules/server-api.js');
        const s = await m.request('/state');
        const snap = s.snapshots[s.snapshots.length - 1];
        return { version: snap.version, count: snap.nodes.length };
      });
      check('S2 确认应用生成新版本', after.version === before.version + 1, { before, after });
      check('S2 新节点进入知识树', after.count === before.count + 1, { before: before.count, after: after.count });
      const pill = await main.textContent('#version-pill');
      check('S2 界面版本徽章更新', pill === 'v2', pill);

      // 2.5 学习任务（导入之后才有节点可勾）
      const taskResult = await main.evaluate(async () => {
        const m = await import('/modules/server-api.js');
        const s = await m.request('/state');
        const snap = s.snapshots[s.snapshots.length - 1];
        const node = snap.nodes.find(n => (n.tasks || []).length > 0) || snap.nodes[0];
        await m.saveTask(snap.version, node.id, 0, true);
        const after = await m.request('/state');
        return { version: snap.version, node: node.id, done: after.tasks[`v${snap.version}:${node.id}:0`] === true };
      }).catch(e => ({ error: String(e) }));
      check('S2 学习任务勾选写入本地库', taskResult && taskResult.done === true, taskResult);
    }

    // ============ S4 回环等价断网 ============
    console.log('=== S4 回环等价断网 ===');
    if (main) {
      const externals = [];
      const listener = req => { if (!req.url().startsWith(origin)) externals.push(req.url()); };
      main.on('request', listener);
      await main.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await sleep(1500);
      main.off('request', listener);
      check('S4 页面全部资源来自回环（无外网依赖）', externals.length === 0, externals.slice(0, 5));
      const stillOk = await healthOnce(origin);
      check('S4 界面重载后功能可用（等效断网场景）', stillOk);
    }

    // ============ S3 重启持久化 ============
    console.log('=== S3 重启持久化 ===');
    const stateBefore = main ? await main.evaluate(async () => {
      const m = await import('/modules/server-api.js');
      const s = await m.request('/state');
      const snap = s.snapshots[s.snapshots.length - 1];
      const tasks = s.tasks || {};
      return { version: snap.version, count: snap.nodes.length, doneCount: Object.values(tasks).filter(Boolean).length };
    }) : null;
    const exitedCleanly = await killAll();
    check('S3 应用与本地服务已停止', exitedCleanly);
    try { if (browser) await browser.close(); } catch {}
    browser = null;
    launch();
    browser = await connect();
    card = await waitPage(browser, '/card.html', 90000);
    check('S3 重启后卡片加载', !!card, card && card.url());
    if (card) origin = new URL(card.url()).origin;
    main = await openMainFromCard(browser, origin);
    if (main) {
      await main.waitForLoadState('domcontentloaded');
      await sleep(1500);
      const stateAfter = await main.evaluate(async () => {
        const m = await import('/modules/server-api.js');
        const s = await m.request('/state');
        const snap = s.snapshots[s.snapshots.length - 1];
        const tasks = s.tasks || {};
        return { version: snap.version, count: snap.nodes.length, doneCount: Object.values(tasks).filter(Boolean).length };
      });
      check('S3 版本持久化', stateAfter.version === stateBefore.version, { before: stateBefore.version, after: stateAfter.version });
      check('S3 节点数持久化', stateAfter.count === stateBefore.count, { before: stateBefore.count, after: stateAfter.count });
      check('S3 学习任务勾选持久化', stateAfter.doneCount === stateBefore.doneCount && stateAfter.doneCount > 0, { before: stateBefore.doneCount, after: stateAfter.doneCount });
    }

    // ============ S5 备份恢复 ============
    console.log('=== S5 备份恢复 ===');
    const rtPython = path.join(EXE_DIR, 'resources', 'runtime', 'python.exe');
    const resDir = path.join(EXE_DIR, 'resources');
    const backupFile = path.join(OUT_DIR, 'backup-' + stamp + '.db');
    const backupRun = () => execFileSync(rtPython, ['-m', 'backend.local', 'backup', '--data', dataDir, '--out', backupFile],
      { cwd: resDir, env: { ...process.env, PYTHONPATH: resDir, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 120000 });
    try { backupRun(); check('S5 运行中备份成功（VACUUM INTO）', fs.existsSync(backupFile) && fs.statSync(backupFile).size > 0); }
    catch (e) { check('S5 运行中备份成功（VACUUM INTO）', false, String(e).slice(0, 200)); }

    // 备份后再制造一个 v3 变更
    if (main && token && usedSkill) {
      const pkgFile = path.join(OUT_DIR, 'pkg2.json');
      fs.writeFileSync(pkgFile, JSON.stringify(pkg('e2e-local-0002', 'local-e2e-b', '备份后新增节点 B'), null, 1));
      try { execFileSync(SKILL_PY, [usedSkill, 'submit', '--file', pkgFile], { env, encoding: 'utf8', timeout: 120000 }); } catch {}
      await main.click('button[data-action="sync"]').catch(() => {});
      await sleep(1200);
      await main.click('.segmented button[data-batch="sync"]').catch(() => {});
      await sleep(1500);
      await main.click('button[data-server-action="sync-open"]').catch(() => {});
      await sleep(1200);
      await main.click('button[data-server-action="apply"]').catch(() => {});
      await sleep(2500);
    }
    const stateAtV3 = main ? await main.evaluate(async () => {
      const m = await import('/modules/server-api.js');
      const s = await m.request('/state');
      const snap = s.snapshots[s.snapshots.length - 1];
      return { version: snap.version, count: snap.nodes.length };
    }) : null;
    check('S5 备份后推进到 v3', stateAtV3 && stateAtV3.version === 3, stateAtV3);

    await killAll();
    try { if (browser) await browser.close(); } catch {}
    browser = null;
    const restoreRun = () => execFileSync(rtPython, ['-m', 'backend.local', 'restore', '--data', dataDir, '--from', backupFile],
      { cwd: resDir, env: { ...process.env, PYTHONPATH: resDir, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 120000 });
    try { restoreRun(); check('S5 停机后恢复备份成功', fs.existsSync(localDb)); }
    catch (e) { check('S5 停机后恢复备份成功', false, String(e).slice(0, 200)); }

    launch();
    browser = await connect();
    card = await waitPage(browser, '/card.html', 90000);
    if (card) origin = new URL(card.url()).origin;
    main = await openMainFromCard(browser, origin);
    if (main) {
      await main.waitForLoadState('domcontentloaded');
      await sleep(1500);
      const stateRestored = await main.evaluate(async () => {
        const m = await import('/modules/server-api.js');
        const s = await m.request('/state');
        const snap = s.snapshots[s.snapshots.length - 1];
        return { version: snap.version, count: snap.nodes.length };
      });
      check('S5 恢复后回到 v2（v3 变更被回退）', stateRestored.version === 2, { restored: stateRestored, v3: stateAtV3 });
      check('S5 恢复后节点数与备份一致', stateAtV3 && stateRestored.count === stateAtV3.count - 1, { restored: stateRestored.count, v3: stateAtV3 && stateAtV3.count });
    }

    // ============ S6 真实托盘退出 ============
    console.log('=== S6 真实托盘退出 ===');
    // 当前实例为普通启动；退出它，再用 --self-test-tray-menu 重启做真实菜单点击
    await killAll();
    try { if (browser) await browser.close(); } catch {}
    browser = null;
    const logPath = path.join(USERDATA_DIR, 'logs', 'main.log');
    let logOffset = 0;
    try { logOffset = fs.statSync(logPath).size; } catch {}
    launch(['--self-test-tray-menu']);
    // 等应用自己打出“已弹菜单”的日志再动手：本地模式冷启动要 7~9 秒，
    // 固定 sleep 会在后端还没就绪时就点，必然点空。
    let popped = false;
    for (let i = 0; i < 150 && !popped; i++) {
      try { popped = fs.readFileSync(logPath).subarray(logOffset).toString('utf8').includes('popup tray menu'); } catch {}
      if (!popped) await sleep(200);
    }
    check('S6 托盘菜单已由应用真实弹出（日志）', popped, { waitedForPopup: popped });
    const ps1 = path.join(__dirname, 'tray-click-quit.ps1');
    const clickOut = path.join(OUT_DIR, 'tray-click.json');
    try { execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Remove-Item -LiteralPath \"' + clickOut + '\" -Force -ErrorAction SilentlyContinue'], { stdio: 'ignore' }); } catch {}
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', ps1, '-Out', clickOut, '-WaitMs', '20000'], { encoding: 'utf8', timeout: 60000 });
    } catch (e) { /* 超时也继续，读结果文件 */ }
    const clicked = fs.existsSync(clickOut) ? JSON.parse(fs.readFileSync(clickOut, 'utf8')) : { ok: false };
    // UIA 连托盘图标都找不到 = 本次会话的任务栏/托盘未暴露给自动化，
    // 属于环境受限（同一脚本在 2026-10-21 21:09 对 0.1.2 成功点到过菜单项），
    // 不能记成产品失败，也不能算通过。
    const envBlocked = !clicked.ok && !clicked.icon_found && !clicked.menu_found;
    if (clicked.ok) {
      check('S6 托盘“退出 AI Tree”菜单项真实点击', true, { steps: clicked.steps });
    } else if (envBlocked) {
      blocked('S6 托盘“退出 AI Tree”菜单项真实点击',
        '当前会话的任务栏/托盘未暴露给 UI Automation（图标与菜单都找不到），需人工确认',
        { steps: clicked.steps, error: clicked.error });
    } else {
      check('S6 托盘“退出 AI Tree”菜单项真实点击', false, { steps: clicked.steps, error: clicked.error });
    }
    if (clicked.ok) {
      let gone = false;
      for (let i = 0; i < 60 && !gone; i++) { await sleep(250); gone = exePids().length === 0 && runtimePyPids().length === 0; }
      check('S6 点击退出后主进程与本地服务全部结束', gone, { exe: exePids().length, py: runtimePyPids().length });
      launch();
    } else {
      blocked('S6 点击退出后主进程与本地服务全部结束', '未发生真实点击，退出路径未走到', { exe: exePids().length, py: runtimePyPids().length });
      await killAll();
      launch();
    }

    // 退出后立即重开
    browser = await connect();
    card = await waitPage(browser, '/card.html', 90000);
    check('S6 重开后可继续使用', !!card, card && card.url());
  } catch (err) {
    check('未预期异常', false, String((err && err.stack) || err).slice(0, 500));
  } finally {
    try { if (browser) await browser.close(); } catch {}
    await killAll();
  }

  const pass = results.filter(r => r.status === 'pass').length;
  const blockedN = results.filter(r => r.status === 'blocked').length;
  const failN = results.filter(r => r.status === 'fail').length;
  console.log(`\nTOTAL ${pass} pass / ${blockedN} blocked / ${failN} fail / ${results.length} checks`);
  if (blockedN) {
    console.log('BLOCKED 明细（环境受限，需人工确认）：');
    for (const r of results.filter(x => x.status === 'blocked')) console.log('  - ' + r.name + ' :: ' + r.reason);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'local-mvp-result.json'),
    JSON.stringify({ pass, blocked: blockedN, fail: failN, total: results.length, results }, null, 1));
  process.exit(failN === 0 ? 0 : 1);
})();
