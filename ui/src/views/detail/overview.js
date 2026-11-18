/* detail/overview.js —— 容器详情 · 概览 tab。只读 state 与 api，不持有数据副本 */

import { getState, setState, toastErr, toastOk } from '../../state.js';
import { getContainerInfo } from '../../api/containers.js';
import { containerAction } from '../../api/containers.js';
import { deleteContainer } from '../../api/containers.js';
import { listBackups } from '../../api/backups.js';
import { confirm } from '../../components/confirm.js';
import { openTerminal } from '../../components/terminal.js';

export const TABS = [
  ['overview', '概览'],
  ['settings', '设置'],
  ['network', '网络'],
  ['data', '数据'],
];

let root = null;
let pollTimer = null;

export function init(mountEl) {
  root = mountEl;
}

/** 选中容器或 tab 变化时调用：拉 info 渲染 */
export async function load() {
  const { selected } = getState();
  stopPoll();
  if (!selected || !root) { renderEmpty(); return; }
  setState({ info: null }, ['info']);
  render();
  try {
    const info = await getContainerInfo(selected);
    setState({ info }, ['info']);
    render();
  } catch (e) {
    toastErr(`加载容器信息失败：${e.message}`);
    renderEmpty();
  }
  // 运行中每 5s 轮询刷新
  if (getState().info?.state === 'RUNNING') pollTimer = setInterval(refreshInfo, 5000);
}

function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function refreshInfo() {
  const { selected } = getState();
  if (!selected) return;
  try {
    const info = await getContainerInfo(selected);
    if (getState().selected === selected) setState({ info }, ['info']);
  } catch { /* 轮询失败静默，下次再试 */ }
}

export function render() {
  const { selected, info, detailTab } = getState();
  if (!root) return;
  root.innerHTML = '';

  if (!selected) { renderEmpty(); return; }

  /* 头部：名字 + 状态 + 操作按钮 */
  const head = document.createElement('div');
  head.className = 'd-head';
  const running = info?.state === 'RUNNING';
  head.innerHTML = `
    <span class="st ${running ? 'run' : ''}" style="width:11px;height:11px;border-radius:50%;background:${running ? 'var(--ok)' : 'var(--stop)'}"></span>
    <h2></h2>
    <span class="tag ${running ? 'run' : 'down'}">${running ? '运行中' : '已停止'}</span>
    <div class="btns"></div>`;
  head.querySelector('h2').textContent = selected;
  const btns = head.querySelector('.btns');
  for (const [act, label, cls] of running
    ? [['restart', '重启', ''], ['stop', '停止', 'primary']]
    : [['start', '启动', 'primary']]) {
    const b = document.createElement('button');
    b.className = `btn ${cls}`;
    b.textContent = label;
    b.dataset.act = act;
    btns.appendChild(b);
  }
  const tb = document.createElement('button');
  tb.className = 'btn'; tb.textContent = '终端'; tb.dataset.act = 'terminal';
  btns.appendChild(tb);
  const db = document.createElement('button');
  db.className = 'btn danger'; db.textContent = '删除'; db.dataset.act = 'delete';
  btns.appendChild(db);
  root.appendChild(head);

  /* tab 条 */
  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  for (const [key, label] of TABS) {
    const a = document.createElement('a');
    a.textContent = label;
    a.dataset.tab = key;
    if (key === detailTab) a.classList.add('on');
    tabs.appendChild(a);
  }
  root.appendChild(tabs);

  /* tab 内容容器：由各 tab 模块填充（main.js 协调） */
  const body = document.createElement('div');
  body.id = 'detail-body';
  root.appendChild(body);

  if (detailTab === 'overview') renderOverview(body);
}

function renderOverview(body) {
  const { info, selected } = getState();
  if (!info) {
    body.innerHTML = '<div class="loading">加载中…</div>';
    return;
  }

  const memPct = info.memory_limit ? (info.memory_used / info.memory_limit) * 100 : 0;
  const diskPct = info.disk_limit ? (info.disk_used / info.disk_limit) * 100 : 0;

  body.innerHTML = `
    <div class="cards">
      <div class="card"><div class="k">CPU</div><div class="v">${fmtVal(info.cpu_usage)}<small> %</small></div><div class="bar"><i style="width:${clamp(info.cpu_usage)}%"></i></div></div>
      <div class="card"><div class="k">内存</div><div class="v">${fmtMB(info.memory_used)}<small> ${info.memory_limit ? '/ ' + fmtMB(info.memory_limit) : ''}</small></div><div class="bar"><i style="width:${clamp(memPct)}%"></i></div></div>
      <div class="card"><div class="k">根盘</div><div class="v">${fmtGB(info.disk_used)}<small> ${info.disk_limit ? '/ ' + fmtGB(info.disk_limit) : ''}</small></div><div class="bar"><i style="width:${clamp(diskPct)}%;background:var(--ok)"></i></div></div>
      <div class="card"><div class="k">进程数</div><div class="v">${info.processes ?? '—'}</div></div>
    </div>
    <div class="grid2">
      <div class="panel"><div class="ph">基本信息<span></span></div><div class="pb" id="ov-base"></div></div>
      <div class="panel"><div class="ph">网络</div><div class="pb" id="ov-net"></div></div>
    </div>
    <div class="panel"><div class="ph">最近备份</div><div class="pb" id="ov-bak"></div></div>`;

  body.querySelector('.ph span').textContent = info.name || selected;

  const base = [
    ['系统', `${info.os || '—'} ${info.release || ''}`.trim()],
    ['IPv4', (info.ipv4 || info.ips || ['—'])[0] || '—'],
    ['PID', info.pid ?? '—'],
    ['开机自启', info.autostart ? '已开启' : '未开启'],
    ['快照数', info.snapshots?.length ?? 0],
  ];
  fillKv(body, '#ov-base', base);

  const nets = (info.network || info.interfaces || []);
  if (nets.length) {
    fillKv(body, '#ov-net', nets.slice(0, 5).map((n) => [n.name || n.interface || 'eth0', n.ip || n.address || '—']));
  } else {
    fillKv(body, '#ov-net', [['IPv4', Array.isArray(info.ips) ? info.ips.join(', ') || '—' : '—']]);
  }

  /* 最近备份异步补齐 */
  listBackups(selected).then((bak) => {
    const list = (bak || []).slice(0, 3);
    const el = body.querySelector('#ov-bak');
    if (!el || el.isConnected === false) return;
    el.innerHTML = '';
    if (!list.length) { el.innerHTML = '<div class="empty">暂无备份</div>'; return; }
    fillKv(el, null, list.map((b) => [b.name || b.file, fmtSize(b.size)]));
  }).catch(() => {});
}

function fillKv(scope, sel, pairs) {
  const el = sel ? scope.querySelector(sel) : scope;
  el.innerHTML = '';
  for (const [k, v] of pairs) {
    const d = document.createElement('div');
    d.className = 'kv';
    const ke = document.createElement('span'); ke.className = 'k'; ke.textContent = k;
    const ve = document.createElement('span'); ve.className = 'v'; ve.textContent = String(v);
    d.append(ke, ve);
    el.appendChild(d);
  }
}

/* 事件处理：由 main.js 委托转发到这里 */
export async function onAction(act) {
  const { selected } = getState();
  if (!selected) return;
  if (act === 'delete') {
    const ok = await confirm({ title: '删除容器', text: `确定删除容器 ${selected} 吗？此操作不可恢复。`, danger: true, okLabel: '删除' });
    if (!ok) return;
    try {
      await deleteContainer(selected, { force: getState().info?.state === 'RUNNING' });
      toastOk(`容器 ${selected} 已删除`);
      setState({ selected: null, info: null, containers: getState().containers.filter((c) => c.name !== selected) }, ['selected', 'info', 'containers']);
    } catch (e) { toastErr(`删除失败：${e.message}`); }
    return;
  }
  if (act === 'terminal') {
    const body = document.getElementById('detail-body');
    if (body) openTerminal(selected, body);
    return;
  }
  try {
    await containerAction(selected, act);
    toastOk(`${selected} ${act} 指令已下发`);
    await refreshInfo();
    render();
  } catch (e) { toastErr(`${act} 失败：${e.message}`); }
}

export function onTabClick(tab) {
  setState({ detailTab: tab }, ['detailTab']);
  render();
}

function renderEmpty() {
  if (root) root.innerHTML = '<div class="empty" style="padding-top:80px">从左侧选择一个容器查看详情</div>';
}

/* ---- 格式化工具 ---- */
const fmtVal = (v) => (v == null ? '—' : Number(v).toFixed(1));
const clamp = (v) => Math.max(0, Math.min(100, Number(v) || 0));
const fmtMB = (b) => (b == null ? '—' : `${(b / 1024 / 1024).toFixed(0)} MB`);
const fmtGB = (b) => (b == null ? '—' : `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`);
const fmtSize = (b) => (b == null ? '—' : b > 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`);
