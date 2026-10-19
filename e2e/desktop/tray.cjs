// 托盘常驻语义验收（Win11 对 UIA 屏蔽通知区，托盘菜单点击无法自动化，
// 所以这里验证的是「关窗口 ≠ 退出」这条等效证据链）：
//   T1 关卡片 → 窗口隐藏（OS 层 IsWindowVisible=false）
//   T2 进程仍存活（托盘常驻）
//   T3 再次启动 exe → 单实例锁生效，卡片恢复显示
//
// 前置：客户端带调试端口启动。
// 环境变量：
//   KO_EXE       AI Tree.exe 的绝对路径（必填，免安装目录里的那个）
//   KO_PYTHON    用于跑 window_state.py 的 Python（默认 python）
//   KO_CDP       调试端点（默认 http://127.0.0.1:9222）
//   KO_OUT       结果目录（默认 ./out）
//   KO_PROCESS   进程名（默认 AI Tree.exe）
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EXE = process.env.KO_EXE;
const PY = process.env.KO_PYTHON || 'python';
const CDP = process.env.KO_CDP || 'http://127.0.0.1:9222';
const OUT = process.env.KO_OUT || path.join(__dirname, 'out');
const PROCESS = process.env.KO_PROCESS || 'AI Tree.exe';

if (!EXE) {
  console.error('缺少 KO_EXE：指向免安装目录里的 AI Tree.exe');
  process.exit(1);
}
if (process.platform !== 'win32') {
  console.error('托盘验收只在 Windows 上实现（依赖 tasklist 与 user32）');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const results = { phase: 'tray', checks: [] };
function check(name, pass, detail) {
  results.checks.push({ name, pass: !!pass, detail: detail === undefined ? null : detail });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + '  ' + JSON.stringify(detail === undefined ? null : detail));
}

function alive() {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${PROCESS}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8' });
    return out.includes(PROCESS);
  } catch { return false; }
}

// 用 OS 层状态判断窗口是否真的显示。渲染器的 visibilityState 在 CDP 连接期间不可信。
function osWindowVisible() {
  try {
    const out = execFileSync(PY, [path.join(__dirname, 'window_state.py'), 'AI Tree'], { encoding: 'utf8' });
    return JSON.parse(out).any_visible === true;
  } catch (error) {
    console.error('window_state.py 失败：' + String(error).split('\n')[0]);
    return false;
  }
}

// 从 Electron 宿主（例如某些 IDE）继承 ELECTRON_RUN_AS_NODE=1 时，exe 会以 node 模式运行、
// 秒退且不请求单实例锁。启动前显式清掉；用户从资源管理器双击没有这个变量。
function launchNormally() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  execFileSync('cmd.exe', ['/c', 'start', '', EXE], { env, stdio: 'ignore' });
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const card = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('/card.html'));
  if (!card) throw new Error('没找到 card.html');

  check('T0 进程运行中', alive(), PROCESS);

  // 上一轮可能把卡片藏起来了：先经 second-instance 路径恢复，保证起点确定。
  if (!osWindowVisible()) {
    launchNormally();
    await card.waitForTimeout(2500);
  }
  check('T0b 卡片可见（起点）', osWindowVisible());

  // 点 × 与直接调 bridge 是同一条链（render handler → koDesktop.hideCard → ipc 'card:hide'
  // → 主进程 hideCard）。这里调 bridge 避开恢复后按钮可见性的抖动。
  await card.evaluate(() => window.koDesktop.hideCard());
  await card.waitForTimeout(2500);
  check('T1 关卡片后窗口隐藏', !osWindowVisible());
  check('T2 关窗后进程仍存活（托盘常驻）', alive(), PROCESS);

  launchNormally();
  await card.waitForTimeout(2500);
  check('T3 二次启动后卡片恢复显示（单实例锁 + 托盘路径）', osWindowVisible());

  fs.writeFileSync(path.join(OUT, 'tray.json'), JSON.stringify(results, null, 2));
  await browser.close();
  process.exit(results.checks.every(c => c.pass) ? 0 : 2);
})().catch(error => { console.error('FAILED', error); process.exit(1); });
