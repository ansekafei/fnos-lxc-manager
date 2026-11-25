/* detail/overview.js —— 容器详情 · 概览 tab。只读 state 与 api，不持有数据副本 */

import { getState, setState, toastErr, toastOk } from '../../state.js';
import { getContainerInfo } from '../../api/containers.js';
import { containerAction } from '../../api/containers.js';
import { deleteContainer } from '../../api/containers.js';
import { confirm } from '../../components/confirm.js';

export const TABS = [
  ['overview', '概览'],
  ['settings', '设置'],
  ['network', '网络'],
  ['data', '数据'],
  ['terminal', '终端'],
];

let root = null;
let pollTimer = null;
let renderDetailTabFn = null; // main.js 注入，用于跨 tab 重绘 body

export function init(mountEl) { root = mountEl; }

/** main.js 注入 renderDetailTab 回调，启停后在非概览 tab 也能正确重绘 */
export function setRenderDetailTab(fn) { renderDetailTabFn = fn; }

/** 选中容器或 tab 变化时调用：拉 info 渲染 */
export async function load() {
  const { selected } = getState();
  stopPoll();
  if (!selected || !root) { renderEmpty(); return; }
  setState({ info: null }, ['info']);
  render();
  try {
    const info = await getContainerInfo(selected);
    // #7 竞态修复：await 返回后复查 selected 是否已切换
    if (getState().selected !== selected) return;
    setState({ info }, ['info']);
    render();
  } catch (e) {
    toastErr(`加载容器信息失败：${e.message}`);
    renderEmpty();
  }
  if ((getState().info?.state || '').toLowerCase() === 'running') pollTimer = setInterval(refreshInfo, 5000);
}

function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function refreshInfo() {
  const { selected, detailTab } = getState();
  if (!selected) return;
  // 只在概览 tab 可见时采样：用户在看设置/网络/数据页时不做无谓的接口轮询
  if (detailTab !== 'overview') return;
  try {
    const info = await getContainerInfo(selected);
    if (getState().selected !== selected) return;
    setState({ info }, ['info']);
    const { containers } = getState();
    const i = containers.findIndex((c) => c.name === selected);
    if (i >= 0) {
      const c = containers[i];
      const patch = {
        state: info.state, cpu_usage: info.cpu_usage, pid: info.pid,
        memory_used: info.memory_used, memory_limit: info.memory_limit,
        processes: info.processes, ipv4: info.ipv4 || [], ips: info.ipv4 || [],
      };
      if (Object.keys(patch).some((k) => JSON.stringify(c[k]) !== JSON.stringify(patch[k]))) {
        const next = containers.slice(); next[i] = { ...c, ...patch };
        setState({ containers: next }, ['containers']);
      }
    }
    if (getState().detailTab === 'overview') render();
  } catch { /* 轮询失败静默 */ }
}

export function render() {
  const { selected, info, detailTab } = getState();
  if (!root) return;
  root.innerHTML = '';
  if (!selected) { renderEmpty(); return; }

  /* 头部 */
  const head = document.createElement('div');
  head.className = 'd-head';
  const running = (info?.state || '').toLowerCase() === 'running';
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

  /* body 容器 */
  const body = document.createElement('div');
  body.id = 'detail-body';
  root.appendChild(body);

  if (detailTab === 'overview') renderOverview(body);
  // 非概览 tab 时由 main.js renderDetailTab 填充 body
}

function renderOverview(body) {
  const { info, selected } = getState();
  if (!info) {
    body.innerHTML = '<div class="loading">加载中…</div>';
    return;
  }

  const memPct = info.memory_limit ? (info.memory_used / info.memory_limit) * 100 : 0;
  const diskPct = info.disk_limit ? (info.disk_used / info.disk_limit) * 100 : 0;
  const memLabel = `${fmtMB(info.memory_used)}<small> / ${info.memory_limit ? fmtMB(info.memory_limit) : '不限'}</small>`;
  const diskLabel = info.disk_limit
    ? `${fmtGB(info.disk_used)}<small> / ${fmtGB(info.disk_limit)}</small>`
    : `${fmtGB(info.disk_used)}<small> / 不限</small>`;

  body.innerHTML = `
    <div class="cards">
      <div class="card"><div class="k">CPU</div><div class="v">${fmtVal(info.cpu_usage)}<small> %</small></div><div class="bar"><i style="width:${clamp(info.cpu_usage)}%"></i></div></div>
      <div class="card"><div class="k">内存</div><div class="v">${memLabel}</div><div class="bar"><i style="width:${clamp(memPct)}%"></i></div></div>
      <div class="card"><div class="k">根盘</div><div class="v">${diskLabel}</div><div class="bar"><i style="width:${clamp(diskPct)}%;background:var(--ok)"></i></div></div>
      <div class="card"><div class="k">进程数</div><div class="v">${info.processes ?? '—'}</div></div>
    </div>
    <div class="grid2">
      <div class="panel"><div class="ph">基本信息<span></span></div><div class="pb" id="ov-base"></div></div>
      <div class="panel"><div class="ph">网络</div><div class="pb" id="ov-net"></div></div>
    </div>`;

  body.querySelector('.ph span').textContent = info.name || selected;

  const base = [
    ['系统', `${info.os || '—'} ${info.release || ''}`.trim()],
    ['IPv4', (info.ipv4?.length ? info.ipv4 : info.ip ? [info.ip] : ['—'])[0] || '—'],
    ['PID', info.pid ?? '—'],
    ['开机自启', info.autostart ? '已开启' : '未开启'],
    ['快照数', typeof info.snapshots === 'number' ? info.snapshots : (info.snapshots?.length ?? 0)],
  ];
  fillKv(body, '#ov-base', base);

  const nets = (info.network || info.interfaces || []);
  const v4 = info.ipv4?.length ? info.ipv4 : (info.ip ? [info.ip] : []);
  const nd = info.network_detail || {};
  if (nets.length) {
    fillKv(body, '#ov-net', nets.slice(0, 5).map((n) => [n.name || n.interface || 'eth0', n.ip || n.address || '—']));
  } else if (v4.length || Object.keys(nd).length) {
    const rows = v4.slice(0, 5).map((ip, i) => [v4.length > 1 ? `IPv4 ${i + 1}` : 'IPv4', ip]);
    (info.ipv6 || []).slice(0, 2).forEach((ip, i) => rows.push([info.ipv6.length > 1 ? `IPv6 ${i + 1}` : 'IPv6', ip]));
    if (nd.ipv4_gateway) rows.push(['网关', nd.ipv4_gateway]);
    if (nd.ipv6_gateway) rows.push(['IPv6 网关', nd.ipv6_gateway]);
    if (nd.dns?.length) rows.push(['DNS', nd.dns.join(', ')]);
    if (nd.type || nd.link) rows.push([nd.type === 'veth' ? '桥接' : '网络类型', nd.link || nd.type]);
    fillKv(body, '#ov-net', rows);
  } else {
    fillKv(body, '#ov-net', [['IPv4', '—']]);
  }

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

export async function onAction(act) {
  const { selected } = getState();
  if (!selected) return;
  if (act === 'delete') {
    const ok = await confirm({ title: '删除容器', text: `确定删除容器 ${selected} 吗？此操作不可恢复。`, danger: true, okLabel: '删除' });
    if (!ok) return;
    try {
      await deleteContainer(selected, { force: ((getState().info?.state || '').toLowerCase() === 'running') });
      toastOk(`容器 ${selected} 已删除`);
      setState({ selected: null, info: null, containers: getState().containers.filter((c) => c.name !== selected) }, ['selected', 'info', 'containers']);
    } catch (e) { toastErr(`删除失败：${e.message}`); }
    return;
  }
  try {
    await containerAction(selected, act);
    toastOk(`${selected} ${act} 指令已下发`);
    await refreshInfo();
    // #1 修复：非概览 tab 时调用 renderDetailTab 而非 render()，确保 body 正确重绘
    if (renderDetailTabFn) renderDetailTabFn();
    else render();
    setTimeout(() => { if (getState().selected === selected) { refreshInfo(); if (renderDetailTabFn) renderDetailTabFn(); } }, 3000);
  } catch (e) { toastErr(`${act} 失败：${e.message}`); }
}

export function onTabClick(tab) {
  setState({ detailTab: tab }, ['detailTab']);
  // #12 修复：不再手动调 render()，由 main.js 订阅 detailTab 变化统一调用 renderDetailTab
  if (tab === 'overview') load();
}

function renderEmpty() {
  if (root) root.innerHTML = '<div class="empty" style="padding-top:80px">从左侧选择一个容器查看详情</div>';
}

/* 格式化工具 */
const fmtVal = (v) => (v == null ? '—' : Number(v).toFixed(1));
const clamp = (v) => Math.max(0, Math.min(100, Number(v) || 0));
const fmtMB = (b) => (b == null ? '—' : `${(b / 1024 / 1024).toFixed(0)} MB`);
const fmtGB = (b) => {
  if (b == null) return '—';
  const gb = b / 1024 ** 3;
  if (gb < 0.5) return `${(b / 1024 ** 2).toFixed(0)} MB`;
  return `${gb.toFixed(1)} GB`;
};
