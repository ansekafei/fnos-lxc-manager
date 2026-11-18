/* dashboard.js —— 仪表盘：全局统计卡 + 宿主信息 */

import { getState, setState } from '../state.js';
import { getStats, getCpus, listInterfaces } from '../api/system.js';

let root = null;

export function init(mountEl) { root = mountEl; }

export async function load() {
  if (!root) return;
  root.innerHTML = '<div class="loading">加载中…</div>';
  try {
    const [stats, cpus, nics] = await Promise.all([getStats(), getCpus(), listInterfaces()]);
    setState({ stats: { ...stats, cpus, nics } }, ['stats']);
    render();
  } catch (e) {
    root.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

export function render() {
  const { stats, version } = getState();
  if (!root || !stats) return;
  root.innerHTML = `
    <h1 style="font-size:var(--fs-xl);margin-bottom:18px">仪表盘</h1>
    <div class="cards">
      <div class="card"><div class="k">容器总数</div><div class="v">${stats.total ?? 0}</div></div>
      <div class="card"><div class="k">运行中</div><div class="v" style="color:var(--ok-txt)">${stats.running ?? 0}</div></div>
      <div class="card"><div class="k">已停止</div><div class="v">${stats.stopped ?? 0}</div></div>
      <div class="card"><div class="k">快照 / 备份</div><div class="v">${stats.snapshots ?? 0}<small> / ${stats.backups ?? 0}</small></div></div>
    </div>
    <div class="grid2">
      <div class="panel"><div class="ph">宿主信息</div><div class="pb" id="db-host"></div></div>
      <div class="panel"><div class="ph">存储</div><div class="pb" id="db-store"></div></div>
    </div>`;
  fill('db-host', [
    ['CPU 核心数', stats.cpus ?? '—'],
    ['网卡', (stats.nics || []).map((n) => n.name).join(', ') || '—'],
    ['LXC 版本', stats.lxc_version || '—'],
    ['应用版本', version || '—'],
  ]);
  fill('db-store', [
    ['容器目录', stats.lxc_path || '—'],
  ]);
}

function fill(sel, pairs) {
  const el = root.querySelector(`#${sel}`);
  for (const [k, v] of pairs) {
    const d = document.createElement('div');
    d.className = 'kv';
    const ke = document.createElement('span'); ke.className = 'k'; ke.textContent = k;
    const ve = document.createElement('span'); ve.className = 'v'; ve.textContent = String(v);
    d.append(ke, ve);
    el.appendChild(d);
  }
}
