/* detail/network.js —— 容器详情 · 网络 tab：网卡与地址 / 网络模式 / 网关与 DNS */

import { getState, toastErr, toastOk } from '../../state.js';
import { listInterfaces } from '../../api/system.js';
import { getConfig, updateConfig } from '../../api/config.js';
import { ApiError } from '../../api/client.js';
import { field, input, select } from '../../components/field.js';

export function render(body) {
  const { info, selected } = getState();
  if (!info) { body.innerHTML = '<div class="loading">加载中…</div>'; return; }

  body.innerHTML = `
    <div class="panel"><div class="ph">网卡与地址<span>运行期实时</span></div><div class="pb" id="nw-list"></div></div>
    <div class="panel"><div class="ph">网络模式<span>保存后容器自动重启生效</span></div><div class="pb" id="nw-mode"></div></div>
    <div class="panel"><div class="ph">网关与 DNS<span>保存后容器自动重启生效</span></div><div class="pb" id="nw-route"></div></div>`;

  fillNicList(body.querySelector('#nw-list'), info);
  load(body, selected);
}

function fmtList(v) {
  if (Array.isArray(v)) return v.filter(Boolean).join(', ') || '—';
  return v ? String(v) : '—';
}

function fillNicList(el, info) {
  const nd = info.network_detail || {};
  const rows = [
    ['IPv4', fmtList(info.ipv4 && info.ipv4.length ? info.ipv4 : info.ip)],
    ['IPv6', fmtList(info.ipv6)],
    ['IPv4 网关', nd.ipv4_gateway || '—'],
    ['IPv6 网关', nd.ipv6_gateway || '—'],
    ['DNS', (nd.dns || []).join('  ') || '—'],
    ['接口 / 模式', [nd.link, nd.type].filter(Boolean).join(' · ') || '—'],
  ];
  el.innerHTML = '';
  for (const [k, v] of rows) {
    const d = document.createElement('div');
    d.className = 'kv';
    const ke = document.createElement('span'); ke.className = 'k'; ke.textContent = k;
    const ve = document.createElement('span'); ve.className = 'v'; ve.textContent = String(v);
    d.append(ke, ve);
    el.appendChild(d);
  }
}

/* 取 config 里某键的值（首次出现） */
function cfgVal(lines, key) {
  const hit = (lines || []).find((l) => l.startsWith(key + ' ') || l.startsWith(key + '=') || l.trim().startsWith(key + ' '));
  return hit ? hit.split('=').slice(1).join('=').trim() : '';
}

/* 取 config 里某键的全部值（nameserver 可能多行 / 一行多个） */
function cfgVals(lines, key) {
  const out = [];
  for (const l of (lines || [])) {
    const i = l.indexOf('=');
    if (i < 0) continue;
    if (l.slice(0, i).trim() !== key) continue;
    for (const tok of l.slice(i + 1).trim().split(/[\s,]+/)) {
      if (tok && !out.includes(tok)) out.push(tok);
    }
  }
  return out;
}

function errBox(msg) {
  const d = document.createElement('div');
  d.className = 'empty';
  d.textContent = msg;
  return d;
}

async function load(body, name) {
  const modeEl = body.querySelector('#nw-mode');
  const routeEl = body.querySelector('#nw-route');
  if (!modeEl || !routeEl) return;
  modeEl.innerHTML = '<div class="loading">加载中…</div>';
  routeEl.innerHTML = '<div class="loading">加载中…</div>';

  let lines, nics;
  try {
    [lines, nics] = await Promise.all([getConfig(name), listInterfaces()]);
  } catch (e) {
    // 选中已切换就不回写
    if (getState().selected !== name) return;
    const msg = e instanceof ApiError && e.locked ? '⚠️ ' + e.message : e.message;
    modeEl.innerHTML = ''; modeEl.appendChild(errBox(msg));
    routeEl.innerHTML = ''; routeEl.appendChild(errBox(msg));
    return;
  }
  if (getState().selected !== name || !modeEl.isConnected) return;

  renderMode(modeEl, lines, nics);
  renderRoute(routeEl, lines);
}

function renderMode(el, lines, nics) {
  // 当前真实 config 的 type + link；下拉要把 veth+link=lxcbr0 回显成 'lxcbr0'，
  // veth+link=<其它桥> 回显成 'bridge'（宿主桥接），否则按 type 直显
  const type = cfgVal(lines, 'lxc.net.0.type');
  const link = cfgVal(lines, 'lxc.net.0.link');
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
}

function renderRoute(el, lines) {
  const gw4 = cfgVal(lines, 'lxc.net.0.ipv4.gateway');
  const gw6 = cfgVal(lines, 'lxc.net.0.ipv6.gateway');
  const dns = cfgVals(lines, 'lxc.net.0.nameserver');

  el.innerHTML = '';
  const i4 = input({ value: gw4, placeholder: '留空 = 不指定（DHCP / ARP 自动）' });
  const i6 = input({ value: gw6, placeholder: '如 fe80::1，留空 = 不指定' });
  const iD = input({ value: dns.join(' '), placeholder: '如 223.5.5.5 1.1.1.1' });
  const save = document.createElement('button');
  save.className = 'btn primary'; save.textContent = '应用';
  save.dataset.nwAct = 'save-route';

  el.append(
    field('IPv4 网关', i4),
    field('IPv6 网关', i6),
    field('DNS', iD, { hint: '多个用空格分隔，最多 3 个；留空会清空该项' }),
    save,
  );
  el._route = { i4, i6, iD };
}

/* main.js 委托转发 */
export async function onAction(act, btn) {
  const { selected } = getState();
  const el = btn?.closest('.pb');
  if (!selected || !el) return;

  if (act === 'save') {
    if (!el._inputs) return;
    const { sel, nicSel } = el._inputs;
    try {
      const mode = sel.value;
      // lxcbr0 是 NAT 模式：type 必须写合法值 veth，link 才是 lxcbr0
      // （曾把 'lxcbr0' 直接写进 lxc.net.0.type，LXC 解析失败导致容器起不来）
      let updates;
      if (mode === 'lxcbr0') {
        updates = { 'lxc.net.0.type': 'veth', 'lxc.net.0.link': 'lxcbr0', 'lxc.net.0.flags': 'up' };
      } else if (mode === 'bridge') {
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
    return;
  }

  if (act === 'save-route') {
    if (!el._route) return;
    const { i4, i6, iD } = el._route;
    const updates = {
      'lxc.net.0.ipv4.gateway': i4.value.trim(),
      'lxc.net.0.ipv6.gateway': i6.value.trim(),
      'lxc.net.0.nameserver': iD.value.trim(),
    };
    try {
      await updateConfig(selected, updates);
      toastOk('网关与 DNS 已更新');
    } catch (e) {
      toastErr(e instanceof ApiError && e.locked ? e.message : `保存失败：${e.message}`);
    }
  }
}
