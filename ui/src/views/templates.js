/* templates.js —— 模板页：官方模板 / Proxmox 源 / 本地缓存 */

import { toastErr, toastOk } from '../state.js';
import { listTemplates, listTemplateVersions, listProxmoxTemplates, downloadProxmoxTemplate, listCachedTemplates } from '../api/templates.js';

let root = null;

export function init(mountEl) { root = mountEl; }

export async function load() {
  if (!root) return;
  root.innerHTML = '<div class="loading">加载中…</div>';
  const [official, proxmox, cached] = await Promise.all([
    listTemplates().catch(() => []),
    listProxmoxTemplates().catch(() => []),
    listCachedTemplates().catch(() => []),
  ]);
  render(official || [], proxmox || [], cached || []);
}

function render(official, proxmox, cached) {
  root.innerHTML = '<h1 style="font-size:var(--fs-xl);margin-bottom:18px">模板</h1>';
  const grid = document.createElement('div');
  grid.className = 'grid2';

  const p1 = document.createElement('div');
  p1.className = 'panel';
  p1.innerHTML = '<div class="ph">官方发行版模板</div><div class="pb"></div>';
  const pb1 = p1.querySelector('.pb');
  if (!official.length) pb1.innerHTML = '<div class="empty">加载失败或无数据</div>';
  for (const t of official) {
    const d = document.createElement('div');
    d.className = 'kv';
    const name = t.distro || t.name || t;
    const ke = document.createElement('span'); ke.className = 'k'; ke.textContent = String(name);
    const ve = document.createElement('button');
    ve.className = 'btn'; ve.style.cssText = 'padding:4px 12px;font-size:12px';
    ve.textContent = '查看版本';
    ve.dataset.tpAct = 'versions';
    ve.dataset.distro = String(name);
    d.append(ke, ve);
    pb1.appendChild(d);
  }

  const p2 = document.createElement('div');
  p2.className = 'panel';
  p2.innerHTML = '<div class="ph">本地缓存模板</div><div class="pb"></div>';
  const pb2 = p2.querySelector('.pb');
  if (!cached.length) pb2.innerHTML = '<div class="empty">缓存目录为空</div>';
  for (const c of cached) {
    const d = document.createElement('div');
    d.className = 'kv';
    const ke = document.createElement('span'); ke.textContent = typeof c === 'string' ? c : (c.name || c.file);
    const ve = document.createElement('span'); ve.className = 'v'; ve.style.color = 'var(--sub)';
    ve.textContent = typeof c === 'object' && c.size ? fmtSize(c.size) : '';
    d.append(ke, ve);
    pb2.appendChild(d);
  }

  grid.append(p1, p2);
  root.appendChild(grid);

  const p3 = document.createElement('div');
  p3.className = 'panel';
  p3.innerHTML = '<div class="ph">Proxmox 源模板（联网拉取）</div><div class="pb"></div>';
  const pb3 = p3.querySelector('.pb');
  if (!proxmox.length) {
    pb3.innerHTML = '<div class="empty">拉取失败或源不可达（可走代理后重试）</div>';
  } else {
    for (const t of proxmox) {
      const d = document.createElement('div');
      d.className = 'kv';
      const ke = document.createElement('span'); ke.style.wordBreak = 'break-all'; ke.textContent = t.file || t.name || JSON.stringify(t);
      const ve = document.createElement('button');
      ve.className = 'btn'; ve.style.cssText = 'padding:4px 12px;font-size:12px';
      ve.textContent = '下载到缓存';
      ve.dataset.tpAct = 'download';
      ve.dataset.url = t.url || '';
      ve.dataset.file = t.file || t.name || '';
      d.append(ke, ve);
      pb3.appendChild(d);
    }
  }
  root.appendChild(p3);
}

const fmtSize = (b) => (b == null ? '' : b > 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`);

/* main.js 委托转发 */
export async function onAction(act, btn) {
  try {
    if (act === 'versions') {
      const distro = btn.dataset.distro;
      const versions = await listTemplateVersions(distro);
      import('../components/modal.js').then(({ openModal }) => {
        openModal({
          title: `${distro} 可用版本`,
          body: `<pre style="font-size:12.5px;white-space:pre-wrap;max-height:50vh;overflow:auto">${escapeHtml(JSON.stringify(versions, null, 2))}</pre>`,
          actions: [{ label: '关闭' }],
        });
      });
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
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
