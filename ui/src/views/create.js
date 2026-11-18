/* create.js —— 创建容器：官方模板 / 克隆 / 从快照 / 从备份 / 本地（Proxmox 缓存）模板 */

import { toastErr, toastOk } from '../state.js';
import { listTemplates, listCachedTemplates, createFromTemplate, createFromCopy, createFromSnapshot, createFromBackup, createFromProxmox, createProgress } from '../api/templates.js';
import { listAllBackups } from '../api/backups.js';
import { field, input, select } from '../components/field.js';

let root = null;
const created = []; // 已创建、待轮询进度的 {name}

export function init(mountEl) { root = mountEl; }

export async function load() {
  if (!root) return;
  root.innerHTML = '<div class="loading">加载中…</div>';
  try {
    const [templates, cached, backups] = await Promise.all([
      listTemplates().catch(() => []),
      listCachedTemplates().catch(() => []),
      listAllBackups().catch(() => []),
    ]);
    render(templates || [], cached || [], backups || {});
  } catch (e) {
    root.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

function render(templates, cached, backups) {
  root.innerHTML = '<h1 style="font-size:var(--fs-xl);margin-bottom:18px">创建容器</h1>';
  const grid = document.createElement('div');
  grid.className = 'grid2';

  /* 官方模板 */
  const p1 = panel('从官方模板创建');
  const name1 = input({ placeholder: '容器名' });
  const tpl = select(templates.map((t) => ({ value: t.distro || t.name || t, label: t.distro || t.name || t })));
  const rel = input({ placeholder: '版本，如 24.04' });
  const arch = select(['amd64', 'arm64', 'i386'], 'amd64');
  const b1 = btn('创建', 'primary', 'c-tpl');
  p1.append(field('容器名', name1), field('发行版', tpl), field('版本', rel), field('架构', arch), b1);

  /* 克隆 */
  const p2 = panel('从现有容器克隆 / 快照 / 备份');
  const name2 = input({ placeholder: '新容器名' });
  const src = input({ placeholder: '源容器名' });
  const snap = input({ placeholder: '快照名（可选）' });
  const baks = Object.values(backups).flat();
  const bakSel = select([{ value: '', label: '— 选择备份文件 —' }, ...baks.map((b) => ({ value: b.name || b.file || b, label: `${b.container || ''} ${b.name || b.file || b}` }))]);
  const b2 = btn('克隆创建', '', 'c-copy');
  const b3 = btn('从快照创建', '', 'c-snap');
  const b4 = btn('从备份创建', '', 'c-bak');
  p2.append(field('新容器名', name2), field('源容器', src), field('快照（从快照创建时填）', snap), field('备份文件（从备份创建时选）', bakSel), b2, b3, b4);

  /* 本地模板 */
  const p3 = panel('从本地缓存模板创建（Proxmox）');
  const name3 = input({ placeholder: '容器名' });
  const tf = select(cached.map((c) => ({ value: typeof c === 'string' ? c : c.name || c.file, label: typeof c === 'string' ? c : c.name || c.file })));
  const auto = select([{ value: 'true', label: '开机自启' }, { value: 'false', label: '不自启' }], 'false');
  const unpriv = select([{ value: 'false', label: '特权' }, { value: 'true', label: '非特权' }], 'false');
  const b5 = btn('创建', '', 'c-local');
  p3.append(field('容器名', name3), field('模板文件', tf), field('自启', auto), field('权限', unpriv), b5);

  grid.append(p1, p2, p3);
  root.appendChild(grid);
  root.appendChild(panel('创建进度', '创建后此处显示后台任务进度'));

  root._inputs = { name1, tpl, rel, arch, name2, src, snap, bakSel, name3, tf, auto, unpriv };
  startProgressPoll();
}

function panel(title, sub) {
  const p = document.createElement('div');
  p.className = 'panel';
  p.innerHTML = `<div class="ph">${escapeHtml(title)}<span>${sub || ''}</span></div><div class="pb"></div>`;
  return p;
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function btn(label, cls, act) {
  const b = document.createElement('button');
  b.className = `btn ${cls}`;
  b.textContent = label;
  b.dataset.crAct = act;
  b.style.marginRight = '8px';
  return b;
}

function startProgressPoll() {
  const timer = setInterval(async () => {
    if (!created.length) return;
    for (const it of created) {
      try {
        const p = await createProgress(it.name);
        const pb = root.querySelector('.panel:last-child .pb');
        if (pb && p?.message) pb.innerHTML = `<div class="kv"><span class="k">${escapeHtml(it.name)}</span><span class="v">${escapeHtml(p.message)} ${p.percent ?? ''}%</span></div>`;
        if (p?.done) {
          toastOk(`容器 ${it.name} 创建完成`);
          created.splice(created.indexOf(it), 1);
        }
      } catch { /* 轮询失败忽略 */ }
    }
    if (!created.length) clearInterval(timer);
  }, 2000);
}

/* main.js 委托转发 */
export async function onAction(act) {
  const I = root._inputs;
  if (!I) return;
  try {
    if (act === 'c-tpl') {
      const name = I.name1.value.trim();
      if (!name) return toastErr('请填写容器名');
      await createFromTemplate({ name, template: I.tpl.value, release: I.rel.value.trim(), arch: I.arch.value });
      created.push({ name }); toastOk('创建任务已开始'); startProgressPoll();
    } else if (act === 'c-copy') {
      const name = I.name2.value.trim(); const source = I.src.value.trim();
      if (!name || !source) return toastErr('请填写新容器名与源容器');
      await createFromCopy({ name, source });
      created.push({ name }); toastOk('克隆任务已开始'); startProgressPoll();
    } else if (act === 'c-snap') {
      const name = I.name2.value.trim(); const source = I.src.value.trim(); const snapshot = I.snap.value.trim();
      if (!name || !source || !snapshot) return toastErr('请填写新容器名、源容器与快照名');
      await createFromSnapshot({ name, source, snapshot });
      created.push({ name }); toastOk('创建任务已开始'); startProgressPoll();
    } else if (act === 'c-bak') {
      const name = I.name2.value.trim(); const backup_name = I.bakSel.value;
      if (!name || !backup_name) return toastErr('请填写新容器名并选择备份文件');
      await createFromBackup({ name, backup_name });
      created.push({ name }); toastOk('创建任务已开始'); startProgressPoll();
    } else if (act === 'c-local') {
      const name = I.name3.value.trim(); const template_file = I.tf.value;
      if (!name || !template_file) return toastErr('请填写容器名并选择模板');
      await createFromProxmox({ name, template_file, autostart: I.auto.value === 'true', unprivileged: I.unpriv.value === 'true' });
      created.push({ name }); toastOk('创建任务已开始'); startProgressPoll();
    }
  } catch (e) { toastErr(`创建失败：${e.message}`); }
}
