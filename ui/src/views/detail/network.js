/* detail/network.js —— 容器详情 · 网络 tab：网卡信息 + 网络模式切换 */

import { getState, toastErr, toastOk } from '../../state.js';
import { listInterfaces } from '../../api/system.js';
import { getConfig, updateConfig } from '../../api/config.js';
import { ApiError } from '../../api/client.js';
import { field, select } from '../../components/field.js';

export function render(body) {
  const { info, selected } = getState();
  if (!info) { body.innerHTML = '<div class="loading">加载中…</div>'; return; }

  body.innerHTML = `
    <div class="panel"><div class="ph">网卡与地址</div><div class="pb" id="nw-list"></div></div>
    <div class="panel"><div class="ph">网络模式<span>运行期锁定，停止后可编辑</span></div><div class="pb" id="nw-mode"></div></div>`;

  fillNicList(body.querySelector('#nw-list'), info);
  loadMode(body.querySelector('#nw-mode'), selected);
}

function fillNicList(el, info) {
  const nets = info.network || info.interfaces || [];
  el.innerHTML = '';
  const rows = nets.length
    ? nets.map((n) => [n.name || n.interface || 'eth0', `${n.ip || n.address || '—'}${n.mac ? ' · ' + n.mac : ''}`])
    : [['IPv4', Array.isArray(info.ips) ? info.ips.join(', ') || '—' : (info.ipv4 || '—')],
       ['IPv6', Array.isArray(info.ipv6) ? info.ipv6.join(', ') || '—' : (info.ipv6 || '—')]];
  for (const [k, v] of rows) {
    const d = document.createElement('div');
    d.className = 'kv';
    const ke = document.createElement('span'); ke.className = 'k'; ke.textContent = k;
    const ve = document.createElement('span'); ve.className = 'v'; ve.textContent = String(v);
    d.append(ke, ve);
    el.appendChild(d);
  }
}

async function loadMode(el, name) {
  el.innerHTML = '<div class="loading">加载中…</div>';
  try {
    const [lines, nics] = await Promise.all([getConfig(name), listInterfaces()]);
    const cur = (lines || []).find((l) => l.includes('lxc.net.0.type'))?.split('=')[1]?.trim() || 'lxcbr0';
    el.innerHTML = '';
    const sel = select(
      [
        { value: 'lxcbr0', label: 'lxcbr0 桥接（默认）' },
        { value: 'macvlan', label: 'macvlan（独立 IP）' },
        { value: 'none', label: '无网络' },
      ],
      cur,
    );
    const nicSel = select((nics || []).map((n) => ({ value: n.name, label: n.name })));
    const save = document.createElement('button');
    save.className = 'btn primary'; save.textContent = '应用';
    save.dataset.nwAct = 'save';
    el.append(field('网络模式', sel), field('macvlan 父接口', nicSel), save);
    el._inputs = { sel, nicSel };
  } catch (e) {
    el.innerHTML = '';
    el.innerHTML = `<div class="empty">${e instanceof ApiError && e.locked ? '⚠️ ' + e.message : e.message}</div>`;
  }
}

/* main.js 委托转发 */
export async function onAction(act, btn) {
  const { selected } = getState();
  const el = btn?.closest('.pb');
  if (!selected || !el?._inputs) return;
  if (act === 'save') {
    const { sel, nicSel } = el._inputs;
    try {
      const mode = sel.value;
      const updates = { 'lxc.net.0.type': mode };
      if (mode === 'macvlan' && nicSel.value) updates['lxc.net.0.link'] = nicSel.value;
      await updateConfig(selected, updates);
      toastOk('网络模式已更新');
    } catch (e) {
      toastErr(e instanceof ApiError && e.locked ? e.message : `保存失败：${e.message}`);
    }
  }
}
