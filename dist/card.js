// AI Tree 桌面卡片。
// 只读：只调用 GET /api/state 与 GET /api/summary，不提交、不应用、不持有同步凭据。
// 与完整窗口共用同一份 Cookie 会话（同源），因此不在客户端保存任何口令。
import { recommendedRoute } from './modules/domain.js';

const REFRESH_MS = 30000;
const BACKOFF = [2000, 5000, 15000, 30000];
const STALE_MS = 90000;
const bridge = window.koDesktop || null;

const el = id => document.getElementById(id);
const card = el('card');

const state = {
  conn: 'loading',      // ok | down | error
  auth: 'unknown',      // ok | expired
  goal: '',
  next: '',
  nextKind: 'empty',
  pending: 0,
  failed: 0,
  last: null,
  serverUpdatedAt: 0,
  version: 0,
  lastOkAt: 0,
  collapsed: false,
  reason: '',
};

let timer = null;
let attempt = 0;
let inflight = false;
let started = false;

function fmtTime(seconds) {
  if (!seconds) return '';
  const d = new Date(seconds * 1000);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function fmtClock(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

async function getJSON(path) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
  if (response.status === 401) {
    const error = new Error('unauthorized');
    error.status = 401;
    throw error;
  }
  if (!response.ok) {
    const error = new Error('HTTP ' + response.status);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

// 真实未完成任务优先；没有任务时退回共享推荐函数，而不是把节点标题冒充任务。
function pickNext(snapshot) {
  const nodes = snapshot.nodes || [];
  if (!nodes.length) return { kind: 'empty', text: '还没有节点 · 用 Skill 同步一次学习记录' };
  const tasks = snapshot.tasks || {};
  for (const node of nodes) {
    const list = node.tasks || [];
    for (let index = 0; index < list.length; index += 1) {
      if (!tasks['v' + snapshot.version + ':' + node.id + ':' + index]) {
        return { kind: 'task', text: list[index] };
      }
    }
  }
  const route = recommendedRoute(snapshot, snapshot.target || '');
  if (route.length) {
    const first = route[0];
    const level = ['未接触', '讨论过', '有实践记录', '实践已验证', '独立掌握'][first.level] || '';
    return { kind: 'study', text: first.title + (level ? ' · ' + level : '') };
  }
  return { kind: 'done', text: '基础节点都有实践记录了 · 去补项目证据' };
}

function renderSyncLine() {
  if (state.auth === 'expired') return '<span class="warn">同步：登录已过期</span>';
  if (state.conn !== 'ok') {
    return '<span class="bad">同步：' + (state.conn === 'down' ? '离线' : '未连上') + '</span>';
  }
  const parts = [];
  if (state.pending > 0) parts.push('<b>待审 ' + state.pending + '</b>');
  else if (state.failed > 0) parts.push('<span class="warn">失败 ' + state.failed + '</span>');
  else parts.push('待审 0');

  const last = state.last;
  if (last) {
    const when = fmtTime(last.updatedAt);
    const label = { ready: '待审', applied: '已应用', failed: '失败' }[last.status] || last.status;
    if (last.status === 'failed') parts.push('<span class="bad">最近一次失败' + (when ? ' · ' + when : '') + '</span>');
    else parts.push('最近 ' + label + (when ? ' · ' + when : ''));
  } else {
    parts.push('还没有提交记录');
  }
  return '同步：' + parts.join(' · ');
}

function render() {
  card.dataset.conn = state.conn;
  card.dataset.auth = state.auth;
  card.dataset.collapsed = state.collapsed ? 'true' : 'false';

  const authExpired = state.auth === 'expired';
  el('goal').textContent = state.goal || (authExpired ? '需要重新登录' : '还没有设置目标');
  el('collapsed-goal').textContent = state.goal || 'AI Tree';

  el('next-label').textContent = state.nextKind === 'task' ? '待完成的任务' : '建议学习';
  const next = el('next');
  next.textContent = authExpired ? '在完整窗口里登录后继续' : (state.next || '—');
  next.classList.toggle('empty', state.nextKind === 'empty' || authExpired);

  el('sync').innerHTML = renderSyncLine();

  const stale = state.conn === 'ok' && state.lastOkAt && (Date.now() - state.lastOkAt > STALE_MS);
  card.dataset.stale = stale ? 'true' : 'false';
  el('stamp').textContent = state.lastOkAt
    ? (stale ? '数据 ' + fmtClock(state.lastOkAt) + '（已过期）' : '更新 ' + fmtClock(state.lastOkAt))
    : '';
  el('collapsed-state').textContent = state.auth === 'expired' ? '需登录'
    : state.pending > 0 ? '待审 ' + state.pending
      : state.conn === 'ok' ? '已连接' : '离线';

  const banner = el('banner');
  if (authExpired) {
    banner.hidden = false;
    el('banner-text').textContent = '登录状态已失效。卡片先保留，打开完整窗口登录后会一起恢复。';
    el('banner-action').textContent = '打开窗口登录';
  } else if (state.conn !== 'ok' && state.reason) {
    banner.hidden = false;
    el('banner-text').textContent = '连不上服务器：' + state.reason + '。已加载的数据仍保留，并标记为过期。';
    el('banner-action').textContent = '打开窗口';
  } else {
    banner.hidden = true;
  }
}

function schedule(delay) {
  clearTimeout(timer);
  timer = null;
  // 隐藏/收起后不再排下一次：避免窗口不可见时仍在轮询。
  if (!started) return;
  timer = setTimeout(refresh, delay);
}

async function refresh() {
  if (inflight) return;
  inflight = true;
  try {
    const [summary, snapshot] = await Promise.all([getJSON('/api/summary'), getJSON('/api/state')]);
    const latest = snapshot.snapshots[snapshot.snapshots.length - 1] || { version: 0, nodes: [] };
    latest.target = snapshot.target || '';
    latest.tasks = snapshot.tasks || {};
    const next = pickNext(latest);

    Object.assign(state, {
      conn: 'ok', auth: 'ok', reason: '',
      goal: snapshot.goalText || '',
      next: next.text, nextKind: next.kind,
      pending: summary.pending || 0, failed: summary.failed || 0,
      last: summary.lastSubmission || null,
      serverUpdatedAt: summary.updatedAt || 0,
      version: summary.version || latest.version || 0,
      lastOkAt: Date.now(),
    });
    attempt = 0;
    render();
    schedule(REFRESH_MS);
  } catch (error) {
    if (error.status === 401) {
      Object.assign(state, { auth: 'expired', conn: 'ok', reason: '' });
      render();
      schedule(REFRESH_MS);
    } else {
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      Object.assign(state, {
        conn: offline ? 'down' : 'error',
        reason: offline ? '网络已断开' : (error.message || '请求失败'),
      });
      render();
      const delay = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
      attempt += 1;
      schedule(delay);
    }
  } finally {
    inflight = false;
  }
}

function setCollapsed(value) {
  state.collapsed = !!value;
  render();
  if (bridge) bridge.setCollapsed(state.collapsed);
}

card.addEventListener('click', event => {
  const button = event.target.closest('[data-act]');
  if (!button) return;
  const act = button.dataset.act;
  if (act === 'refresh') { attempt = 0; refresh(); return; }
  if (act === 'tree') { if (bridge) bridge.openTree(); else window.open('/', '_blank', 'noopener'); return; }
  if (act === 'hide') { if (bridge) bridge.hideCard(); return; }
  if (act === 'collapse') { setCollapsed(true); return; }
  if (act === 'expand') { setCollapsed(false); }
});

// 显示时刷新、隐藏时停表；由主进程告知卡片是否可见。
function start() {
  if (started) return;
  started = true;
  refresh();
}
function stop() {
  started = false;
  clearTimeout(timer);
  timer = null;
}

if (bridge) {
  bridge.onVisibility(visible => { if (visible) start(); else stop(); });
  // 卡片创建出来就是可见的；同时主进程在页面加载完成后还会再告知一次。
  start();
} else {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') start(); else stop();
  });
  start();
}

window.addEventListener('online', () => { attempt = 0; if (started) refresh(); });
window.addEventListener('offline', () => { state.conn = 'down'; state.reason = '网络已断开'; render(); });

// 供桌面壳查询状态（只读，不含凭据）。
window.__cardState = () => ({ conn: state.conn, auth: state.auth, pending: state.pending, next: state.next, goal: state.goal });
