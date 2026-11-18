/* detail/data.js —— 容器详情 · 数据 tab：快照 + 备份 */

import { getState, toastErr, toastOk } from '../../state.js';
import { listSnapshots, createSnapshot, deleteSnapshot, restoreSnapshot } from '../../api/snapshots.js';
import { listBackups, createBackup, deleteBackup, restoreBackup, backupProgress, restoreProgress } from '../../api/backups.js';
import { confirm } from '../../components/confirm.js';

export function render(body) {
  const { selected } = getState();
  if (!selected) { body.innerHTML = ''; return; }
  body.innerHTML = `
    <div class="panel"><div class="ph">快照<button class="btn" data-dt-act="new-snap" style="padding:5px 12px;font-size:12.5px">新建快照</button></div><div class="pb" id="dt-snaps"></div></div>
    <div class="panel"><div class="ph">备份<button class="btn primary" data-dt-act="new-backup" style="padding:5px 12px;font-size:12.5px">立即备份</button></div><div class="pb" id="dt-baks"></div></div>
    <div class="panel" id="dt-prog-panel" style="display:none"><div class="ph">任务进度<span id="dt-prog-msg"></span></div><div class="pb"><div class="bar"><i id="dt-prog-bar" style="width:0%"></i></div></div></div>`;

  loadSnaps(body.querySelector('#dt-snaps'), selected);
  loadBaks(body.querySelector('#dt-baks'), selected);
}

function rowTable(el, headers, rows, rowActions) {
  el.innerHTML = '';
  if (!rows.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const t = document.createElement('table');
  t.style.cssText = 'width:100%;font-size:13px;border-collapse:collapse';
  t.innerHTML = `<thead><tr>${headers.map((h) => `<th style="text-align:left;padding:7px 4px;color:var(--sub);font-weight:500;border-bottom:1px solid var(--line)">${h}</th>`).join('')}<th></th></tr></thead>`;
  const tb = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const cell of r) {
      const td = document.createElement('td');
      td.style.cssText = 'padding:8px 4px;border-bottom:1px dashed #eef1f5';
      td.textContent = String(cell ?? '');
      tr.appendChild(td);
    }
    const tda = document.createElement('td');
    tda.style.cssText = 'text-align:right;white-space:nowrap';
    for (const [label, key, cls] of rowActions) {
      const b = document.createElement('button');
      b.className = `btn ${cls || ''}`;
      b.style.cssText = 'padding:4px 10px;font-size:12px;margin-left:6px';
      b.textContent = label;
      b.dataset.dtAct = key;
      b.dataset.row = r[0];
      tda.appendChild(b);
    }
    tr.appendChild(tda);
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  el.appendChild(t);
}

async function loadSnaps(el, name) {
  try {
    const snaps = (await listSnapshots(name)) || [];
    rowTable(el, ['快照名', '时间'], snaps.map((s) => [s.name || s.snapshot, s.time || '']),
      [['回滚', 'restore-snap', ''], ['删除', 'del-snap', 'danger']]);
  } catch (e) { el.innerHTML = `<div class="empty">${e.message}</div>`; }
}

async function loadBaks(el, name) {
  try {
    const baks = (await listBackups(name)) || [];
    rowTable(el, ['文件', '大小', '时间'], baks.map((b) => [b.name || b.file, fmtSize(b.size), b.time || b.created || '']),
      [['恢复', 'restore-bak', ''], ['删除', 'del-bak', 'danger']]);
  } catch (e) { el.innerHTML = `<div class="empty">${e.message}</div>`; }
}

const fmtSize = (b) => (b == null ? '—' : b > 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`);

/* 进度条 */
function showProg(msg, pct, done) {
  const panel = document.getElementById('dt-prog-panel');
  if (!panel) return;
  panel.style.display = '';
  document.getElementById('dt-prog-msg').textContent = msg;
  const bar = document.getElementById('dt-prog-bar');
  bar.style.width = `${done ? 100 : Math.max(2, pct || 0)}%`;
  if (done) setTimeout(() => { panel.style.display = 'none'; }, 1500);
}

function startPoll(fn) {
  const timer = setInterval(async () => {
    try {
      const p = await fn();
      showProg(p.message || '进行中…', p.percent, p.done);
      if (p.done) { clearInterval(timer); render(document.getElementById('detail-body')); }
    } catch { clearInterval(timer); showProg('进度查询失败', 0, true); }
  }, 1500);
}

/* main.js 委托转发 */
export async function onAction(act, btn) {
  const { selected } = getState();
  if (!selected) return;
  const row = btn?.dataset.row;
  const refresh = () => render(document.getElementById('detail-body'));
  try {
    if (act === 'new-snap') {
      const name = prompt('快照名称', `${selected}-${Date.now()}`);
      if (!name) return;
      await createSnapshot(selected, name);
      toastOk('快照已创建'); refresh();
    } else if (act === 'restore-snap') {
      if (await confirm({ title: '回滚快照', text: `回滚到快照 ${row}？当前状态将丢失。`, danger: true, okLabel: '回滚' })) {
        await restoreSnapshot(selected, row); toastOk('已回滚'); refresh();
      }
    } else if (act === 'del-snap') {
      if (await confirm({ title: '删除快照', text: `删除快照 ${row}？`, danger: true, okLabel: '删除' })) {
        await deleteSnapshot(selected, row); toastOk('快照已删除'); refresh();
      }
    } else if (act === 'new-backup') {
      await createBackup(selected);
      toastOk('备份任务已开始');
      startPoll(() => backupProgress(selected));
    } else if (act === 'restore-bak') {
      const newname = prompt('恢复为新容器名（留空则覆盖同名）', '');
      await restoreBackup(selected, row, newname || undefined);
      toastOk('恢复任务已开始');
      startPoll(() => restoreProgress(selected, row));
    } else if (act === 'del-bak') {
      if (await confirm({ title: '删除备份', text: `删除备份文件 ${row}？`, danger: true, okLabel: '删除' })) {
        await deleteBackup(selected, row); toastOk('备份已删除'); refresh();
      }
    }
  } catch (e) { toastErr(`操作失败：${e.message}`); }
}
