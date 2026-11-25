/* templates.js —— 模板页：已下载的本地模板 / 官方发行版 / Proxmox 源 */

import { toastErr, toastOk } from '../state.js';
import { listTemplates, listTemplateVersions, listProxmoxTemplates, downloadProxmoxTemplate, listCachedTemplates } from '../api/templates.js';

let root = null;
let offline = false;                         // Proxmox 源拉取失败标记

export function init(mountEl) { root = mountEl; }

export async function load() {
  if (!root) return;
  root.innerHTML = '<div class="loading">加载中…</div>';
  const [official, proxmox, cached] = await Promise.all([
    listTemplates().catch(() => []),
    listProxmoxTemplates().catch(() => { offline = true; return []; }),
    listCachedTemplates().catch(() => []),
  ]);
  render(official || [], proxmox || [], cached || []);
}

const fmtSize = (b) => (b == null || b === '' ? '' : b > 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`);

function render(official, proxmox, cached) {
  root.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'page-head';
  head.innerHTML = '<div><h1>模板</h1><div class="sub">Proxmox 源下载后平铺存放在本地模板目录，创建容器时直接可选</div></div>';
  const refresh = document.createElement('button');
  refresh.className = 'btn';
  refresh.textContent = '刷新';
  refresh.dataset.tpAct = 'refresh';
  head.appendChild(refresh);
  root.appendChild(head);

  /* ---- 已下载 ---- */
  const p1 = section('已下载的本地模板', cached.length ? `${cached.length} 个` : '');
  if (!cached.length) p1.grid.innerHTML = '<div class="empty" style="grid-column:1/-1">缓存目录里还没有模板</div>';
  for (const c of cached) {
    p1.grid.appendChild(card(
      escapeHtml(c.file || c.name),
      `${c.os || ''}${c.arch ? ` · ${c.arch}` : ''}${c.size ? ` · ${fmtSize(c.size)}` : ''}`,
      '',
      [],
    ));
  }
  root.appendChild(p1.panel);

  /* ---- 官方发行版 ---- */
  const p2 = section('官方发行版模板', official.length ? `${official.length} 个` : '');
  if (!official.length) p2.grid.innerHTML = '<div class="empty" style="grid-column:1/-1">模板源不可达（镜像源设置见「设置」页）</div>';
  for (const t of official) {
    const name = t.os || t.name;
    const b = document.createElement('button');
    b.className = 'btn sm';
    b.textContent = '查看版本';
    b.dataset.tpAct = 'versions';
    b.dataset.distro = t.name || name;
    const badge = t.cached ? '<span class="badge-ok">已缓存</span>' : '';
    p2.grid.appendChild(card(`${escapeHtml(name)}${badge}`, clean(t.note), '', [b]));
  }
  root.appendChild(p2.panel);

  /* ---- Proxmox 源 ---- */
  const p3 = section('Proxmox 模板源', proxmox.length ? `${proxmox.length} 个` : '');
  if (!proxmox.length) {
    p3.grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${offline ? '源不可达（可走代理后重试刷新）' : '未获取到模板列表'}</div>`;
  }
  for (const t of proxmox) {
    const badge = t.cached ? '<span class="badge-ok">已缓存</span>' : '';
    const acts = [];
    if (t.cached) {
      const b = document.createElement('button');
      b.className = 'btn sm';
      b.textContent = '已缓存';
      b.disabled = true;
      acts.push(b);
    } else {
      const b = document.createElement('button');
      b.className = 'btn sm primary';
      b.textContent = '下载';
      b.dataset.tpAct = 'download';
      b.dataset.url = t.tar_url || '';
      b.dataset.file = t.tar_file || '';
      acts.push(b);
    }
    p3.grid.appendChild(card(
      `${escapeHtml(t.package)}${badge}`,
      `${t.os}${t.version ? ` v${t.version}` : ''}${t.arch ? ` | ${t.arch}` : ''}`,
      clean(t.description),
      acts,
    ));
  }
  root.appendChild(p3.panel);
}

function section(title, count) {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `<div class="ph">${escapeHtml(title)}<span>${escapeHtml(count || '')}</span></div>`;
  const grid = document.createElement('div');
  grid.className = 'tpl-grid';
  panel.appendChild(grid);
  return { panel, grid };
}

function card(name, meta, desc, actions) {
  const c = document.createElement('div');
  c.className = 'tpl-card';
  const n = document.createElement('div');
  n.className = 'n';
  n.innerHTML = name;                            // 名字里带后端给的可信 badge
  c.appendChild(n);
  if (meta) {
    const m = document.createElement('div');
    m.className = 'm';
    m.textContent = meta;
    c.appendChild(m);
  }
  if (desc) {
    const d = document.createElement('div');
    d.className = 'm';
    d.style.cssText = 'opacity:.85';
    d.textContent = desc;
    c.appendChild(d);
  }
  if (actions.length) {
    const a = document.createElement('div');
    a.className = 'a';
    for (const b of actions) a.appendChild(b);
    c.appendChild(a);
  }
  return c;
}

/* 后端 note 里带 📥/📦 之类 emoji，本机字体不带 emoji，渲染成豆腐块，这里剔掉 */
const clean = (s) => String(s || '').replace(/[\u{1F000}-\u{1FAFF}\u{2100}-\u{21FF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim();
const escapeHtml = (s) => String(s || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/* main.js 委托转发 */
export async function onAction(act, btn) {
  try {
    if (act === 'refresh') {
      await load();
    } else if (act === 'versions') {
      const distro = btn.dataset.distro;
      btn.disabled = true;
      const versions = await listTemplateVersions(distro).catch(() => []);
      btn.disabled = false;
      openVersions(distro, versions || []);
    } else if (act === 'download') {
      const { url, file } = btn.dataset;
      if (!url) return toastErr('该条目缺少下载地址');
      btn.disabled = true; btn.textContent = '下载中…';
      await downloadProxmoxTemplate(url, file);
      toastOk('模板已下载到缓存');
      await load();
    }
  } catch (e) { toastErr(`操作失败：${e.message}`); }
}

async function openVersions(distro, versions) {
  const { openModal } = await import('../components/modal.js');
  const wrap = document.createElement('div');
  if (!versions.length) {
    wrap.innerHTML = '<div class="empty">没有取到版本列表</div>';
  } else {
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px;max-height:52vh;overflow:auto';
    for (const v of versions) {
      const d = document.createElement('div');
      d.style.cssText = 'border:1px solid var(--line);border-radius:8px;padding:9px 11px;font-size:12.5px';
      d.innerHTML = `<div style="font-weight:600">${escapeHtml(v.release)}</div>
        <div style="color:var(--sub);font-size:11.5px;margin-top:2px">${escapeHtml(v.arch || '')}${v.variant && v.variant !== 'default' ? ` · ${escapeHtml(v.variant)}` : ''}${v.cached ? ' · 已缓存' : ''}</div>
        <div style="color:var(--sub);font-size:11px;margin-top:2px">${escapeHtml(v.build_date || '')}</div>`;
      grid.appendChild(d);
    }
    wrap.appendChild(grid);
    wrap.insertAdjacentHTML('afterbegin', `<div style="font-size:12.5px;color:var(--sub);margin-bottom:10px">创建容器时在「官方模板」里选 ${escapeHtml(distro)} 并填下面任一版本名</div>`);
  }
  openModal({ title: `${distro} 可用版本`, body: wrap, actions: [{ label: '关闭' }] });
}
