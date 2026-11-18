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
    // 当前真实 config 的 type + link；下拉要把 veth+link=lxcbr0 回显成 'lxcbr0'，
    // veth+link=<其它桥> 回显成 'bridge'（宿主桥接），否则按 type 直显
    const type = (lines || []).find((l) => l.startsWith('lxc.net.0.type'))?.split('=')[1]?.trim() || '';
    const link = (lines || []).find((l) => l.startsWith('lxc.net.0.link'))?.split('=')[1]?.trim() || '';
    let cur;
    if (type === 'veth' && link === 'lxcbr0') cur = 'lxcbr0';
    else if (type === 'veth' && link && link !== 'lxcbr0') cur = 'bridge';
    else if (type === 'macvlan') cur = 'macvlan';
    else if (type === 'empty' || type === 'none') cur = 'none';
    else cur = 'bridge';
    el.innerHTML = '';
    const sel = select(
      [
        { value: 'bridge', label: '宿主桥接（veth + OVS/物理桥）' },
        { value: 'lxcbr0', label: 'NAT (lxcbr0) — 10.0.3.x 子网' },
        { value: 'macvlan', label: 'macvlan（独立 IP）' },
        { value: 'none', label: '无网络' },
      ],
      cur,
    );
    // 宿主桥接默认选中 link；macvlan 默认父接口（过滤掉 docker/lo/veth）
    const usableNics = (nics || []).filter((n) => n.kind === 'physical' || n.is_ovs);
    const nicSel = select(
      usableNics.map((n) => ({ value: n.name, label: `${n.name}${n.is_ovs ? ' (OVS)' : ''}` })),
      link && link !== 'lxcbr0' ? link : (usableNics[0]?.name || ''),
    );
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
      // lxcbr0 是 NAT 模式：type 必须写合法值 veth，link 才是 lxcbr0
      // （曾把 'lxcbr0' 直接写进 lxc.net.0.type，LXC 解析失败导致容器起不来）
      let updates;
      if (mode === 'lxcbr0') {
        // NAT：veth + lxcbr0
        updates = { 'lxc.net.0.type': 'veth', 'lxc.net.0.link': 'lxcbr0', 'lxc.net.0.flags': 'up' };
      } else if (mode === 'bridge') {
        // 宿主桥接：veth + 选中网卡（OVS 桥或物理网卡，LXC 自动识别）
        updates = { 'lxc.net.0.type': 'veth', 'lxc.net.0.link': nicSel.value, 'lxc.net.0.flags': 'up' };
      } else if (mode === 'macvlan') {
        updates = { 'lxc.net.0.type': 'macvlan', 'lxc.net.0.flags': 'up' };
        if (nicSel.value) updates['lxc.net.0.link'] = nicSel.value;
      } else {
        updates = { 'lxc.net.0.type': 'empty' };
      }
      await updateConfig(selected, updates);
      toastOk('网络模式已更新');
    } catch (e) {
      toastErr(e instanceof ApiError && e.locked ? e.message : `保存失败：${e.message}`);
    }
  }
}
