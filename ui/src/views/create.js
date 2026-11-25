/* create.js —— 创建容器：本地模板 / 官方模板 / 克隆 / 快照 / 备份，每种一张表单 */

import { toastErr, toastOk, getState } from '../state.js';
import { listTemplates, listCachedTemplates, createFromTemplate, createFromCopy, createFromSnapshot, createFromBackup, createFromProxmox, createProgress } from '../api/templates.js';
import { listAllBackups } from '../api/backups.js';
import { getSettings } from '../api/system.js';
import { field, input, select } from '../components/field.js';

const TABS = [
  ['local', '本地模板'],
  ['official', '官方模板'],
  ['clone', '克隆容器'],
  ['snapshot', '从快照'],
  ['backup', '从备份'],
];

const NET_OPTS = [
  { value: 'bridge', label: '宿主桥接' },
  { value: 'nat', label: 'NAT (lxcbr0)' },
  { value: 'macvlan', label: 'macvlan' },
  { value: 'none', label: '无网络' },
];

let root = null;
let tab = 'local';
let D = { templates: [], cached: [], backups: [], settings: {} };
let R = {};                                  // 当前表单里的控件引用
const created = [];                          // 等进度的容器名
let pollTimer = null;                        // #3 修复：模块级单例

export function init(mountEl) { root = mountEl; }

export async function load() {
  if (!root) return;
  stopPoll();
  root.innerHTML = '<div class="loading">加载中…</div>';
  try {
    const [templates, cached, backups, st] = await Promise.all([
      listTemplates().catch(() => []),
      listCachedTemplates().catch(() => []),
      listAllBackups().catch(() => ({})),
      getSettings().catch(() => ({})),
    ]);
    D = {
      templates: templates || [],
      cached: cached || [],
      backups: Object.values(backups || {}).flat(),
      settings: st || {},
    };
    render();
  } catch (e) {
    root.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

/* 切分段（main.js 委托转发） */
export function onTab(next) {
  if (!TABS.some(([k]) => k === next)) return;
  tab = next;
  renderShell();
}

function defaultNet() {
  const n = D.settings.network_type || 'bridge';
  return NET_OPTS.some((o) => o.value === n) ? n : 'bridge';
}

/* ---- 渲染 ---- */

function render() { renderShell(); }

function renderShell() {
  root.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'page-head';
  head.innerHTML = '<div><h1>创建容器</h1><div class="sub">选一种方式把容器建起来，后台任务进度会显示在下面</div></div>';
  root.appendChild(head);

  const seg = document.createElement('div');
  seg.className = 'seg';
  for (const [k, label] of TABS) {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.crTab = k;
    if (k === tab) b.classList.add('on');
    seg.appendChild(b);
  }
  root.appendChild(seg);

  const panel = document.createElement('div');
  panel.className = 'panel form-panel';
  panel.innerHTML = '<div class="pb" id="cr-body"></div>';
  root.appendChild(panel);

  const prog = document.createElement('div');
  prog.className = 'panel';
  prog.id = 'cr-progress';
  prog.style.display = 'none';
  prog.innerHTML = '<div class="ph">创建进度</div><div class="pb"></div>';
  root.appendChild(prog);

  renderBody();
}

function row(...items) {
  const r = document.createElement('div');
  r.className = 'form-row';
  for (const it of items) r.appendChild(it);
  return r;
}

function actions(...btns) {
  const a = document.createElement('div');
  a.className = 'form-actions';
  for (const b of btns) a.appendChild(b);
  return a;
}

function blank() { const d = document.createElement('div'); d.className = 'field'; return d; }

function btn(label, act, cls = 'primary') {
  const b = document.createElement('button');
  b.className = `btn ${cls}`;
  b.textContent = label;
  b.dataset.crAct = act;
  return b;
}

function renderBody() {
  const body = root.querySelector('#cr-body');
  if (!body) return;
  body.innerHTML = '';
  R = {};

  const containerOpts = [{ value: '', label: '— 选择容器 —' }]
    .concat((getState().containers || []).map((c) => ({ value: c.name, label: c.name })));
  const net = () => select(NET_OPTS, defaultNet());
  const disk = () => input({ type: 'number', value: '0', placeholder: '0' });

  if (tab === 'local') {
    const name = input({ placeholder: 'my-container' });
    const tpl = select(D.cached.length
      ? D.cached.map((c) => ({ value: c.file, label: `${c.os || c.file}${c.arch ? ` · ${c.arch}` : ''}` }))
      : [{ value: '', label: '缓存目录里还没有模板' }]);
    const netSel = net();
    const diskGb = disk();
    const auto = select([{ value: 'false', label: '不自启' }, { value: 'true', label: '开机自启' }], 'false');
    const unpriv = select([{ value: 'false', label: '特权' }, { value: 'true', label: '非特权' }], 'false');
    body.append(
      row(field('容器名称', name, { hint: '字母数字开头，可含 - 和 _' }), field('模板', tpl, { hint: '来自 /vol1/1000/lxc/template' })),
      row(field('网络模式', netSel), field('根盘配额 (GB)', diskGb, { hint: '0 = 不限制，共享宿主可用空间' })),
      row(field('自启动', auto), field('权限', unpriv, { hint: '非特权更安全，但挂载和网络受限' })),
      actions(btn('创建容器', 'c-local')),
    );
    R = { name, tpl, netSel, diskGb, auto, unpriv };
  }

  if (tab === 'official') {
    const name = input({ placeholder: 'my-container' });
    const tpl = select(D.templates.length
      ? D.templates.map((t) => ({ value: t.name, label: `${t.os || t.name}${t.cached ? '（已缓存）' : ''}` }))
      : [{ value: '', label: '模板源不可达' }]);
    const rel = input({ placeholder: '如 bookworm / 24.04', type: 'text' });
    const arch = select(['amd64', 'arm64', 'i386'], 'amd64');
    const netSel = net();
    const diskGb = disk();
    body.append(
      row(field('容器名称', name), field('发行版', tpl, { hint: '镜像源设置见「设置」页' })),
      row(field('发行版版本', rel, { hint: '留空则由模板决定' }), field('架构', arch)),
      row(field('网络模式', netSel), field('根盘配额 (GB)', diskGb, { hint: '0 = 不限制' })),
      actions(btn('创建容器', 'c-tpl')),
    );
    R = { name, tpl, rel, arch, netSel, diskGb };
  }

  if (tab === 'clone') {
    const source = select(containerOpts);
    const name = input({ placeholder: 'my-clone' });
    const netSel = net();
    body.append(
      row(field('源容器', source), field('新容器名称', name)),
      row(field('网络模式', netSel), blank()),
      actions(btn('克隆容器', 'c-copy')),
    );
    R = { source, name, netSel };
  }

  if (tab === 'snapshot') {
    const source = select(containerOpts);
    const snap = input({ placeholder: '快照名' });
    const name = input({ placeholder: '新容器名称' });
    const netSel = net();
    body.append(
      row(field('源容器', source), field('快照', snap, { hint: '在容器详情「数据」页可查看已有快照' })),
      row(field('新容器名称', name), field('网络模式', netSel)),
      actions(btn('从快照创建', 'c-snap')),
    );
    R = { source, snap, name, netSel };
  }

  if (tab === 'backup') {
    const baks = D.backups;
    const bakSel = select(baks.length
      ? baks.map((b) => ({ value: b.name || b.file, label: `${b.container ? `${b.container} · ` : ''}${b.name || b.file}` }))
      : [{ value: '', label: '备份目录里还没有备份' }]);
    const name = input({ placeholder: '新容器名称' });
    const netSel = net();
    body.append(
      row(field('备份文件', bakSel, { hint: '备份路径见「设置」页' }), field('新容器名称', name)),
      row(field('网络模式', netSel), blank()),
      actions(btn('从备份创建', 'c-bak')),
    );
    R = { bakSel, name, netSel };
  }
}

/* ---- 进度 ---- */

function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function showProgress(name, text) {
  const box = root?.querySelector('#cr-progress');
  if (!box) return;
  box.style.display = '';
  const pb = box.querySelector('.pb');
  let line = pb.querySelector(`[data-p="${CSS.escape(name)}"]`);
  if (!line) {
    line = document.createElement('div');
    line.className = 'kv';
    line.dataset.p = name;
    pb.appendChild(line);
  }
  line.innerHTML = `<span class="k">${name}</span><span class="v">${text}</span>`;
}

// #3 修复：模块级单例轮询，load() 和 onAction 都先 stopPoll() 再启动
function startProgressPoll() {
  stopPoll();
  if (!created.length) return;
  pollTimer = setInterval(async () => {
    if (!created.length) { stopPoll(); return; }
    for (const it of created.slice()) {
      try {
        const p = await createProgress(it.name);
        showProgress(it.name, `${p?.message || '进行中'}${p?.percent != null ? ` ${p.percent}%` : ''}`);
        if (p?.done) {
          toastOk(`容器 ${it.name} 创建完成`);
          showProgress(it.name, '完成');
          created.splice(created.indexOf(it), 1);
        }
      } catch { /* 轮询失败忽略 */ }
    }
    if (!created.length) stopPoll();
  }, 2000);
}

/* main.js 委托转发 */
export async function onAction(act) {
  const v = (el) => (el?.value || '').trim();
  try {
    if (act === 'c-local') {
      const name = v(R.name);
      if (!name) return toastErr('请填写容器名');
      if (!R.tpl.value) return toastErr('请选择模板');
      await createFromProxmox({
        name,
        template_file: R.tpl.value,
        autostart: R.auto.value === 'true',
        unprivileged: R.unpriv.value === 'true',
        network_type: R.netSel.value,
        disk_size_gb: parseFloat(R.diskGb.value) || 0,
      });
    } else if (act === 'c-tpl') {
      const name = v(R.name);
      if (!name) return toastErr('请填写容器名');
      if (!R.tpl.value) return toastErr('请选择发行版');
      await createFromTemplate({
        name,
        template: R.tpl.value,
        release: v(R.rel),
        arch: R.arch.value,
        disk_size_gb: parseFloat(R.diskGb.value) || 0,
        network_type: R.netSel.value,
      });
    } else if (act === 'c-copy') {
      const name = v(R.name), source = R.source.value;
      if (!name || !source) return toastErr('请填写新容器名并选择源容器');
      await createFromCopy({ name, source, network_type: R.netSel.value });
    } else if (act === 'c-snap') {
      const name = v(R.name), source = R.source.value, snapshot = v(R.snap);
      if (!name || !source || !snapshot) return toastErr('请填全新容器名、源容器与快照名');
      await createFromSnapshot({ name, source, snapshot, network_type: R.netSel.value });
    } else if (act === 'c-bak') {
      const name = v(R.name), backup_name = R.bakSel.value;
      if (!name || !backup_name) return toastErr('请填写新容器名并选择备份文件');
      await createFromBackup({ name, backup_name, network_type: R.netSel.value });
    } else {
      return;
    }
    created.push({ name: v(R.name) });
    toastOk('创建任务已开始');
    startProgressPoll();
  } catch (e) {
    toastErr(`创建失败：${e.message}`);
  }
}
