/* FnLxc v2 — 完整前端 */
const API = 'api/lxc';
const SYS_API = 'api';
let containers = [], templates = [], selected = new Set(), currentContainer = '';
let proxmoxLoaded = false, proxmoxData = null;
let cacheLoaded = false, cacheData = null;
let activeCreateTab = 'template';
let confirmCallback = null, promptCallback = null;
let autoRefresh = null;
let filterState = ''; // '' | 'running' | 'stopped' | 'frozen'

// ═══════════ API ═══════════
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  const d = await r.json();
  if (!r.ok && !d.success) throw new Error(d.error || `HTTP ${r.status}`);
  if (!d.success) throw new Error(d.error || '请求失败');
  return d;
}
async function lxc(url, method = 'GET', body) { return api(method, `${API}${url}`, body); }
async function sys(url, method = 'GET', body) { return api(method, `${SYS_API}${url}`, body); }

// ═══════════ Toast ═══════════
function toast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${type === 'success' ? '✓' : type === 'error' ? '✗' : type === 'warning' ? '⚠' : 'ℹ'}</span><span>${esc(msg)}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(100px)'; setTimeout(() => t.remove(), 300); }, 3500);
}

// ═══════════ Confirm / Prompt ═══════════
function confirm(msg, cb) {
  document.getElementById('confirm-message').textContent = msg;
  document.getElementById('confirm-btn').textContent = '确定';
  document.getElementById('confirm-btn').className = 'btn btn-danger';
  confirmCallback = cb;
  document.getElementById('confirm-modal').classList.add('active');
}
function closeConfirm() { document.getElementById('confirm-modal').classList.remove('active'); confirmCallback = null; }
function confirmAction() { const cb = confirmCallback; closeConfirm(); if (cb) cb(); }

function promptInput(title, msg, placeholder, cb) {
  document.getElementById('prompt-title').textContent = title;
  document.getElementById('prompt-message').textContent = msg;
  document.getElementById('prompt-input').value = '';
  document.getElementById('prompt-input').placeholder = placeholder;
  promptCallback = cb;
  document.getElementById('prompt-modal').classList.add('active');
  setTimeout(() => document.getElementById('prompt-input').focus(), 200);
}
function closePrompt() { document.getElementById('prompt-modal').classList.remove('active'); promptCallback = null; }
function promptConfirm() {
  const cb = promptCallback, val = document.getElementById('prompt-input').value.trim();
  closePrompt(); if (cb) cb(val);
}

// ═══════════ Helpers ═══════════
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function fmtBytes(b) {
  if (!b || b <= 0) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length-1) { b /= 1024; i++; }
  return `${b.toFixed(1)} ${u[i]}`;
}
function fmtState(s) { return { running: '运行中', stopped: '已停止', frozen: '已冻结', starting: '启动中', stopping: '停止中' }[s] || s; }
function stateClass(s) { return { running: 'running', stopped: 'stopped', frozen: 'frozen' }[s] || 'unknown'; }
function fmtDate(d) { if (!d) return '-'; try { return new Date(d).toLocaleString('zh-CN'); } catch(e) { return d; } }

// ═══════════ Tab Navigation ═══════════
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${name}`));
  if (name === 'containers') loadContainers();
  else if (name === 'dashboard') loadDashboard();
  else if (name === 'templates') { showProxmoxTemplates(); showCachedTemplates(); }
  else if (name === 'create') refreshCreateSelects();
  else if (name === 'settings') loadSettings();
}

// ═══════════ DASHBOARD ═══════════
async function loadDashboard() {
  const grid = document.getElementById('dashboard-grid');
  try {
    const [stats, cpus, ifaces] = await Promise.all([
      sys('/stats'), sys('/cpus'), sys('/interfaces')
    ]);
    const d = stats.data, cpu = cpus.data;
    grid.innerHTML = `
      <div class="stat-card clickable" onclick="gotoContainers('')"><div class="stat-value">${d.total}</div><div class="stat-label">总容器数</div></div>
      <div class="stat-card stat-running clickable" onclick="gotoContainers('running')"><div class="stat-value">${d.running}</div><div class="stat-label">运行中</div></div>
      <div class="stat-card stat-stopped clickable" onclick="gotoContainers('stopped')"><div class="stat-value">${d.stopped}</div><div class="stat-label">已停止</div></div>
      <div class="stat-card stat-frozen clickable" onclick="gotoContainers('frozen')"><div class="stat-value">${d.frozen}</div><div class="stat-label">已冻结</div></div>
      <div class="stat-card stat-snap"><div class="stat-value">${d.snapshots}</div><div class="stat-label">快照数</div></div>
      <div class="stat-card stat-backup"><div class="stat-value">${d.backups}</div><div class="stat-label">备份数</div></div>
      <div class="info-card info-card-wide">
        <h4>系统信息</h4>
        <table class="info-table">
          <tr><td>LXC 版本</td><td>${d.lxc_version || '-'}</td></tr>
          <tr><td>容器路径</td><td>${d.lxc_path || '-'}</td></tr>
          <tr><td>CPU 核心</td><td>${cpu.count} (${cpu.cores} 核, ${cpu.threads_per_core}/核)</td></tr>
          <tr><td>网络接口</td><td>${ifaces.data.map(i => i.name).join(', ') || '-'}</td></tr>
        </table>
      </div>`;
    document.getElementById('header-stats').textContent = `${d.running}/${d.total} 运行`;
  } catch(e) {
    grid.innerHTML = `<div class="empty-state"><p>加载失败: ${esc(e.message)}</p></div>`;
  }
}

// ═══════════ CONTAINER LIST ═══════════
async function loadContainers() {
  const grid = document.getElementById('container-grid');
  const empty = document.getElementById('empty-containers');
  const badge = document.getElementById('container-count-badge');
  try {
    const r = await lxc('/list');
    containers = r.data || [];
    badge.textContent = containers.length;
    renderContainers();
  } catch(e) {
    toast('加载容器列表失败: ' + e.message, 'error');
    renderContainers();
  }
}

function filterContainers() { renderContainers(); }

function gotoContainers(state) {
  filterState = state;
  switchTab('containers');
}

function renderContainers() {
  const grid = document.getElementById('container-grid');
  const empty = document.getElementById('empty-containers');
  const q = (document.getElementById('search-containers').value || '').toLowerCase();
  const filtered = containers.filter(c => {
    const matchState = !filterState || c.state === filterState;
    const matchName = c.name.toLowerCase().includes(q);
    return matchState && matchName;
  });
  if (filtered.length === 0) {
    grid.innerHTML = '';
    empty.style.display = containers.length === 0 ? 'block' : 'none';
    if (containers.length > 0) {
      empty.querySelector('h3').textContent = '未找到匹配的容器';
      empty.querySelector('p').textContent = `没有名称包含 "${esc(q)}" 的容器`;
    }
    return;
  }
  empty.style.display = 'none';
  grid.innerHTML = filtered.map(c => {
    const rx = c.network_rx > 0 ? fmtBytes(c.network_rx) : '-';
    const tx = c.network_tx > 0 ? fmtBytes(c.network_tx) : '-';
    const ips = c.ips && c.ips.length ? c.ips.filter(ip => ip !== '127.0.0.1').join(', ') : '-';
    return `
    <div class="container-card ${selected.has(c.name) ? 'selected' : ''}">
      <div class="container-card-header">
        <label class="checkbox-label">
          <input type="checkbox" ${selected.has(c.name) ? 'checked' : ''} onchange="toggleSel('${esc(c.name)}')">
        </label>
        <span class="container-name" onclick="openDetail('${esc(c.name)}')">${esc(c.name)}</span>
        <span class="container-status ${stateClass(c.state)}"><span class="status-dot"></span>${fmtState(c.state)}</span>
      </div>
      ${c.description ? `<div class="container-desc">${esc(c.description)}</div>` : ''}
      <div class="container-meta">
        <div class="meta-item"><span class="meta-label">IP</span><span>${ips}</span></div>
        <div class="meta-item"><span class="meta-label">内存</span><span>${fmtBytes(c.memory_used)}</span></div>
        <div class="meta-item"><span class="meta-label">↓RX</span><span>${rx}</span></div>
        <div class="meta-item"><span class="meta-label">↑TX</span><span>${tx}</span></div>
        <div class="meta-item"><span class="meta-label">快照</span><span>${c.snapshots || 0}</span></div>
      </div>
      <div class="container-actions">
        ${c.state === 'running' ? `
          <button class="btn btn-sm btn-terminal" onclick="openTerminal('${esc(c.name)}')" title="终端">⎇ 终端</button>
          <button class="btn btn-sm btn-warning" onclick="act('${esc(c.name)}','stop')">⏹ 停止</button>
          <button class="btn btn-sm btn-secondary" onclick="act('${esc(c.name)}','restart')">🔄 重启</button>
          <button class="btn btn-sm btn-secondary" onclick="act('${esc(c.name)}','freeze')">❄️ 冻结</button>` : c.state === 'frozen' ? `
          <button class="btn btn-sm btn-success" onclick="act('${esc(c.name)}','unfreeze')">▶ 解冻</button>
          <button class="btn btn-sm btn-danger" onclick="delContainer('${esc(c.name)}')">🗑 删除</button>` : `
          <button class="btn btn-sm btn-success" onclick="act('${esc(c.name)}','start')">▶ 启动</button>
          <button class="btn btn-sm btn-danger" onclick="delContainer('${esc(c.name)}')">🗑 删除</button>`}
        <button class="btn btn-sm btn-ghost" onclick="openDetail('${esc(c.name)}')" title="详情">ℹ️</button>
      </div>
    </div>`;
  }).join('');
  updateBatchUI();
}

// ═══════════ Selection & Batch ═══════════
function toggleSel(name) {
  if (selected.has(name)) selected.delete(name); else selected.add(name);
  renderContainers();
}
function updateBatchUI() {
  const n = selected.size;
  document.getElementById('batch-info').style.display = n ? 'inline' : 'none';
  document.getElementById('batch-info').textContent = `已选 ${n} 个`;
  ['btn-batch-start','btn-batch-stop','btn-batch-delete'].forEach(id =>
    document.getElementById(id).style.display = n ? 'inline-flex' : 'none');
}
async function batchStart() {
  for (const n of [...selected]) await act(n, 'start', true);
  selected.clear(); loadContainers();
}
async function batchStop() {
  for (const n of [...selected]) await act(n, 'stop', true);
  selected.clear(); loadContainers();
}
async function batchDelete() {
  const names = [...selected];
  confirm(`确定要删除 ${names.length} 个容器吗？`, async () => {
    for (const n of names) await delContainer(n, true);
    selected.clear(); loadContainers();
  });
}

async function act(name, action, silent = false) {
  try {
    await lxc(`/${encodeURIComponent(name)}/${action}`, 'POST');
    if (!silent) toast(`${action} ${name} 成功`, 'success');
    loadContainers();
  } catch(e) { if (!silent) toast(`${action} 失败: ${e.message}`, 'error'); }
}
async function delContainer(name, silent = false) {
  if (!silent) {
    confirm(`确定要删除容器 ${name} 吗？`, async () => {
      try {
        await lxc(`/${encodeURIComponent(name)}?force=true`, 'DELETE');
        toast(`${name} 已删除`, 'success');
        closeModal(); loadContainers();
      } catch(e) { toast(`删除失败: ${e.message}`, 'error'); }
    });
    return;
  }
  try { await lxc(`/${encodeURIComponent(name)}?force=true`, 'DELETE'); }
  catch(e) {}
}

// ═══════════ TERMINAL (xterm.js + WebSocket) ═══════════
let termInstance = null, termSocket = null, terminalName = '';

function openTerminal(name) {
  terminalName = name;
  document.getElementById('terminal-title').textContent = '\u7ec8\u7aef: ' + name;
  document.getElementById('terminal-modal').classList.add('active');

  // 初始化 xterm
  if (!termInstance) {
    termInstance = new Terminal({
      cursorBlink: true, cursorStyle: 'block',
      fontSize: 14, fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: { background: '#0d1117', foreground: '#c9d1d9',
        cursor: '#58a6ff', selection: '#1f6feb',
        black: '#484f58', red: '#ff7b72', green: '#3fb950',
        yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff',
        cyan: '#39c5cf', white: '#b1bac4',
        brightBlack: '#6e7681', brightRed: '#ffa198',
        brightGreen: '#56d364', brightYellow: '#e3b341',
        brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
      },
      allowTransparency: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    termInstance.loadAddon(fitAddon);

    termInstance.open(document.getElementById('terminal-container'));
    termInstance.focus();

    // 窗口大小变化时自适应
    const resizeObserver = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch(e) {}
    });
    resizeObserver.observe(document.getElementById('terminal-container'));

    // 键盘输入 -> WebSocket
    termInstance.onData(data => {
      if (termSocket && termSocket.readyState === WebSocket.OPEN) {
        termSocket.send(data);
      }
    });

    // 保存 fitAddon 用于窗口大小变化
    termInstance.fitAddon = fitAddon;
  } else {
    termInstance.reset();
    document.getElementById('terminal-container').innerHTML = '';
    termInstance.open(document.getElementById('terminal-container'));
    termInstance.focus();
    try { termInstance.fitAddon.fit(); } catch(e) {}
  }

  // 建 WebSocket 连接
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = proto + '//' + window.location.host + '/app/fnlxc/api/lxc/' + encodeURIComponent(name) + '/terminal';
  termSocket = new WebSocket(wsUrl);

  termSocket.onopen = () => {
    // 发初始终端大小
    try {
      const dims = termInstance.fitAddon ? termInstance.fitAddon.proposeDimensions() : null;
      const cols = dims ? dims.cols : 80;
      const rows = dims ? dims.rows : 24;
      termSocket.send(JSON.stringify({ cols, rows }));
    } catch(e) {}
    termInstance.write('\r\n\u2501\u2501\u2501 \u8fde\u63a5\u5df2\u5efa\u7acb \u2501\u2501\u2501\r\n');
  };

  termSocket.onmessage = (e) => {
    if (e.data instanceof Blob) {
      const reader = new FileReader();
      reader.onload = () => termInstance.write(reader.result);
      reader.readAsText(e.data);
    } else {
      termInstance.write(e.data);
    }
  };

  termSocket.onclose = () => {
    termSocket = null;
    termInstance.write('\r\n\u2501\u2501\u2501 \u8fde\u63a5\u5df2\u5173\u95ed \u2501\u2501\u2501\r\n');
  };

  termSocket.onerror = () => {
    termInstance.write('\r\n\u2501\u2501\u2501 \u8fde\u63a5\u9519\u8bef \u2501\u2501\u2501\r\n');
  };
}

function closeTerminal() {
  if (termSocket) {
    termSocket.close();
    termSocket = null;
  }
  document.getElementById('terminal-modal').classList.remove('active');
  terminalName = '';
}

// ═══════════ CONTAINER DETAIL MODAL ═══════════
async function openDetail(name) {
  currentContainer = name;
  document.getElementById('modal-title').textContent = `容器: ${name}`;
  document.getElementById('container-modal').classList.add('active');
  showDetailTab('info');
}

async function showDetailTab(tab) {
  document.querySelectorAll('.detail-tab').forEach(b => b.classList.toggle('active', b.textContent.includes(
    { info: '信息', meta: '元数据', config: '配置', snapshots: '快照', backups: '备份', network: '网络' }[tab])));
  const body = document.getElementById('modal-body');
  body.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>加载中...</p></div>';
  try {
    switch(tab) {
      case 'info': await renderDetailInfo(body); break;
      case 'meta': await renderDetailMeta(body); break;
      case 'config': await renderDetailConfig(body); break;
      case 'snapshots': await renderDetailSnapshots(body); break;
      case 'backups': await renderDetailBackups(body); break;
      case 'network': await renderDetailNetwork(body); break;
    }
  } catch(e) {
    body.innerHTML = `<div class="empty-state"><p>加载失败: ${esc(e.message)}</p></div>`;
  }
}

async function renderDetailInfo(body) {
  const r = await lxc(`/${encodeURIComponent(currentContainer)}/info`);
  const c = r.data;
  document.getElementById('modal-status-badge').className = `container-status ${stateClass(c.state)}`;
  document.getElementById('modal-status-badge').innerHTML = `<span class="status-dot"></span>${fmtState(c.state)}`;
  body.innerHTML = `
    <div class="detail-section">
      <table class="detail-table">
        <tr><td>状态</td><td><span class="container-status ${stateClass(c.state)}"><span class="status-dot"></span>${fmtState(c.state)}</span></td></tr>
        <tr><td>PID</td><td>${c.pid || '-'}</td></tr>
        <tr><td>IP 地址</td><td>${c.ip && c.ip.length ? c.ip.join(', ') : '-'}</td></tr>
        <tr><td>系统</td><td>${c.os || '-'} ${c.release || ''}</td></tr>
        <tr><td>架构</td><td>${c.arch || '-'}</td></tr>
        <tr><td>自启动</td><td>${c.autostart ? '✅ 是' : '❌ 否'}</td></tr>
        <tr><td>描述</td><td>${c.description || '-'}</td></tr>
        <tr><td>WebUI</td><td>${c.webui_url ? `<a href="${esc(c.webui_url)}" target="_blank">${esc(c.webui_url)}</a>` : '-'}</td></tr>
        <tr><td>创建时间</td><td>${fmtDate(c.created_at)}</td></tr>
        <tr><td>运行时间</td><td>${c.uptime || '-'}</td></tr>
      </table>
    </div>
    <div class="detail-section">
      <h4>资源使用</h4>
      <div class="resource-bars">
        <div class="resource-bar-item"><span class="rb-label">内存</span><span class="rb-val">${fmtBytes(c.memory_used)} / ${fmtBytes(c.memory_limit)}</span></div>
        <div class="resource-bar-item"><span class="rb-label">CPU</span><span class="rb-val">${c.cpu_usage ? c.cpu_usage.toFixed(1) + 's' : '-'}</span></div>
        <div class="resource-bar-item"><span class="rb-label">进程</span><span class="rb-val">${c.processes || '-'}</span></div>
        <div class="resource-bar-item"><span class="rb-label">快照</span><span class="rb-val">${c.snapshots || 0}</span></div>
        <div class="resource-bar-item"><span class="rb-label">网络 RX</span><span class="rb-val">${fmtBytes(c.network_rx)}</span></div>
        <div class="resource-bar-item"><span class="rb-label">网络 TX</span><span class="rb-val">${fmtBytes(c.network_tx)}</span></div>
      </div>
    </div>
    <div class="detail-section">
      <h4>操作</h4>
      <div class="action-group">
        ${c.state !== 'running' ? `<button class="btn btn-success" onclick="act('${esc(currentContainer)}','start');showDetailTab('info')">▶ 启动</button>` : ''}
        ${c.state === 'running' ? `<button class="btn btn-warning" onclick="act('${esc(currentContainer)}','stop');showDetailTab('info')">⏹ 停止</button>` : ''}
        <button class="btn btn-secondary" onclick="act('${esc(currentContainer)}','restart');showDetailTab('info')">🔄 重启</button>
        ${c.state === 'running' ? `<button class="btn btn-secondary" onclick="act('${esc(currentContainer)}','freeze');showDetailTab('info')">❄️ 冻结</button>` : ''}
        <button class="btn btn-danger" onclick="delContainer('${esc(currentContainer)}')">🗑 删除</button>
        <button class="btn btn-secondary" onclick="showDetailTab('snapshots')">📸 快照</button>
        <button class="btn btn-secondary" onclick="showDetailTab('backups')">💾 备份</button>
        <button class="btn btn-secondary" onclick="showDetailTab('network')">🌐 网络</button>
        <button class="btn btn-secondary" onclick="openTerminal('${esc(currentContainer)}')">⎇ 终端</button>
      </div>
    </div>`;
}

async function renderDetailMeta(body) {
  const r = await lxc(`/${encodeURIComponent(currentContainer)}/info`);
  const c = r.data;
  body.innerHTML = `
    <div class="detail-section">
      <h4>元数据</h4>
      <div class="meta-edit-group">
        <div class="meta-edit-row">
          <label>描述</label>
          <input type="text" id="meta-desc" value="${esc(c.description || '')}" placeholder="容器描述">
          <button class="btn btn-sm btn-primary" onclick="saveMetaDesc()">保存</button>
          ${c.description ? `<button class="btn btn-sm btn-danger" onclick="delMetaDesc()">×</button>` : ''}
        </div>
        <div class="meta-edit-row">
          <label>WebUI URL</label>
          <input type="text" id="meta-webui" value="${esc(c.webui_url || '')}" placeholder="http://[IP]:8080 (自动替换[IP])">
          <button class="btn btn-sm btn-primary" onclick="saveMetaWebUI()">保存</button>
          ${c.webui_url ? `<button class="btn btn-sm btn-danger" onclick="delMetaWebUI()">×</button>` : ''}
        </div>
        <div class="meta-edit-row">
          <label>自启动</label>
          <label class="toggle"><input type="checkbox" id="meta-autostart" ${c.autostart ? 'checked' : ''} onchange="saveMetaAutostart()"><span class="toggle-slider"></span></label>
        </div>
        <div class="meta-edit-row">
          <label>MAC 地址</label>
          <input type="text" id="meta-mac" value="${esc(c.mac || '')}" placeholder="00:16:3e:xx:xx:xx">
          <button class="btn btn-sm btn-primary" onclick="saveMetaMac()">保存</button>
        </div>
        <div class="meta-edit-row">
          <label>排序号</label>
          <input type="number" id="meta-order" value="${c.container_order || 0}" min="0" style="width:100px">
          <button class="btn btn-sm btn-primary" onclick="saveMetaOrder()">保存</button>
        </div>
      </div>
    </div>`;
}

async function saveMetaDesc() {
  const v = document.getElementById('meta-desc').value;
  try { await lxc(`/${encodeURIComponent(currentContainer)}/description`, 'PUT', { description: v }); toast('描述已更新', 'success'); }
  catch(e) { toast('更新失败: ' + e.message, 'error'); }
}
async function delMetaDesc() {
  try { await lxc(`/${encodeURIComponent(currentContainer)}/description`, 'DELETE'); toast('描述已删除', 'success'); showDetailTab('meta'); }
  catch(e) { toast('删除失败: ' + e.message, 'error'); }
}
async function saveMetaWebUI() {
  const v = document.getElementById('meta-webui').value;
  try { await lxc(`/${encodeURIComponent(currentContainer)}/webui`, 'PUT', { webui_url: v }); toast('WebUI 已更新', 'success'); }
  catch(e) { toast('更新失败: ' + e.message, 'error'); }
}
async function delMetaWebUI() {
  try { await lxc(`/${encodeURIComponent(currentContainer)}/webui`, 'DELETE'); toast('WebUI 已删除', 'success'); showDetailTab('meta'); }
  catch(e) { toast('删除失败: ' + e.message, 'error'); }
}
async function saveMetaAutostart() {
  const v = document.getElementById('meta-autostart').checked ? 1 : 0;
  try { await lxc(`/${encodeURIComponent(currentContainer)}/autostart`, 'PUT', { autostart: v }); toast(`自启动已${v ? '开启' : '关闭'}`, 'success'); }
  catch(e) { toast('更新失败: ' + e.message, 'error'); }
}
async function saveMetaMac() {
  const v = document.getElementById('meta-mac').value;
  try { await lxc(`/${encodeURIComponent(currentContainer)}/mac`, 'PUT', { mac: v }); toast('MAC 已更新', 'success'); }
  catch(e) { toast('更新失败: ' + e.message, 'error'); }
}
async function saveMetaOrder() {
  const v = parseInt(document.getElementById('meta-order').value) || 0;
  try { await lxc(`/${encodeURIComponent(currentContainer)}/order`, 'PUT', { order: v }); toast('排序已更新', 'success'); }
  catch(e) { toast('更新失败: ' + e.message, 'error'); }
}

async function renderDetailConfig(body) {
  const r = await lxc(`/${encodeURIComponent(currentContainer)}/config`);
  const lines = r.data || [];
  body.innerHTML = `
    <p class="info-text">编辑容器配置文件。保存后将重启容器生效。</p>
    <textarea id="config-editor" class="config-editor" spellcheck="false">${esc(lines.join('\n'))}</textarea>
    <div class="form-actions" style="margin-top:12px">
      <button class="btn btn-primary" onclick="saveConfig()">💾 保存配置</button>
    </div>`;
}

async function saveConfig() {
  const v = document.getElementById('config-editor').value;
  const updates = {};
  v.split('\n').forEach(line => {
    const m = line.match(/^\s*(\w[\w.]*)\s*=\s*(.+)\s*$/);
    if (m) updates[m[1].trim()] = m[2].trim();
  });
  try {
    await lxc(`/${encodeURIComponent(currentContainer)}/config`, 'PUT', { updates });
    toast('配置已保存', 'success');
  } catch(e) { toast('保存失败: ' + e.message, 'error'); }
}

async function renderDetailSnapshots(body) {
  const r = await lxc(`/${encodeURIComponent(currentContainer)}/snapshots`);
  const snaps = r.data || [];
  body.innerHTML = `
    <div class="detail-section">
      <div class="section-header">
        <h4>快照列表 (${snaps.length})</h4>
        <button class="btn btn-sm btn-primary" onclick="createSnapshot()">📸 创建快照</button>
      </div>
      ${snaps.length === 0 ? '<p class="info-text">暂无快照</p>' : snaps.map(s => `
        <div class="list-item">
          <div class="list-item-info">
            <strong>${esc(s.name)}</strong>
            ${s.created_at ? `<span class="text-muted">${fmtDate(s.created_at)}</span>` : ''}
          </div>
          <div class="list-item-actions">
            <button class="btn btn-sm btn-success" onclick="restoreSnapshot('${esc(s.name)}')">恢复</button>
            <button class="btn btn-sm btn-danger" onclick="deleteSnapshot('${esc(s.name)}')">删除</button>
            <button class="btn btn-sm btn-secondary" onclick="cloneFromSnapshot('${esc(s.name)}')">克隆</button>
          </div>
        </div>`).join('')}
    </div>`;
}

async function createSnapshot() {
  promptInput('创建快照', '输入快照名称（留空自动命名）：', 'snap-时间戳', async (name) => {
    try {
      const body = name ? { snapshot_name: name } : {};
      await lxc(`/${encodeURIComponent(currentContainer)}/snapshot`, 'POST', body);
      toast('快照创建成功', 'success');
      showDetailTab('snapshots');
    } catch(e) { toast('创建失败: ' + e.message, 'error'); }
  });
}
async function restoreSnapshot(name) {
  confirm(`确定要从快照 "${name}" 恢复容器 ${currentContainer} 吗？`, async () => {
    try {
      await lxc(`/${encodeURIComponent(currentContainer)}/snapshot/${encodeURIComponent(name)}/restore`, 'POST');
      toast('快照已恢复', 'success');
      showDetailTab('snapshots');
    } catch(e) { toast('恢复失败: ' + e.message, 'error'); }
  });
}
async function deleteSnapshot(name) {
  confirm(`确定要删除快照 "${name}" 吗？`, async () => {
    try {
      await lxc(`/${encodeURIComponent(currentContainer)}/snapshot/${encodeURIComponent(name)}`, 'DELETE');
      toast('快照已删除', 'success');
      showDetailTab('snapshots');
    } catch(e) { toast('删除失败: ' + e.message, 'error'); }
  });
}
function cloneFromSnapshot(name) {
  closeModal();
  switchTab('create');
  switchCreateTab('snapshot');
  document.getElementById('snap-source').value = currentContainer;
  loadSnapshotList().then(() => { document.getElementById('snap-select').value = name; });
  document.getElementById('snap-new-name').value = currentContainer + '-' + name;
}

async function renderDetailBackups(body) {
  const r = await lxc(`/${encodeURIComponent(currentContainer)}/backups`);
  const backups = r.data || [];
  body.innerHTML = `
    <div class="detail-section">
      <div class="section-header">
        <h4>备份列表 (${backups.length})</h4>
        <button class="btn btn-sm btn-primary" onclick="createBackup()">💾 创建备份</button>
      </div>
      ${backups.length === 0 ? '<p class="info-text">暂无备份</p>' : backups.map(b => `
        <div class="list-item">
          <div class="list-item-info">
            <strong>${esc(b.filename)}</strong>
            <span class="text-muted">${fmtBytes(b.size)} · ${fmtDate(b.created_at)}</span>
          </div>
          <div class="list-item-actions">
            <button class="btn btn-sm btn-success" onclick="restoreBackup('${esc(b.filename)}')">恢复</button>
            <button class="btn btn-sm btn-danger" onclick="deleteBackup('${esc(b.filename)}')">删除</button>
          </div>
        </div>`).join('')}
    </div>`;
}

// ═══════════ NETWORK ═══════════
async function renderDetailNetwork(body) {
  const info = await lxc('/' + encodeURIComponent(currentContainer) + '/info');
  const c = info.data;
  const config = await lxc('/' + encodeURIComponent(currentContainer) + '/config');
  const cfgLines = config.data || [];
  const settings = await sys('/settings');
  const hostIface = settings.data.host_interface || 'enp4s0-ovs';

  let netType = 'veth', netLink = 'lxcbr0', netHwaddr = '', netFlags = 'up';
  for (const line of cfgLines) {
    if (line.startsWith('lxc.net.0.type =')) netType = line.split('=')[1].trim();
    if (line.startsWith('lxc.net.0.link =')) netLink = line.split('=')[1].trim();
    if (line.startsWith('lxc.net.0.hwaddr =')) netHwaddr = line.split('=')[1].trim();
    if (line.startsWith('lxc.net.0.flags =')) netFlags = line.split('=')[1].trim();
  }

  body.innerHTML =
    '<div class="detail-section">' +
      '<h4>网络配置 (lxc.net.0)</h4>' +
      '<div class="info-card">' +
        '<table class="info-table">' +
          '<tr><td>当前模式</td><td><code>' + esc(netType) + '</code></td></tr>' +
          '<tr><td>桥接/链路</td><td><code>' + esc(netLink) + '</code></td></tr>' +
          '<tr><td>MAC 地址</td><td>' + (netHwaddr ? '<code>' + esc(netHwaddr) + '</code>' : '-') + '</td></tr>' +
          '<tr><td>容器 IP</td><td>' + (c.ip && c.ip.length ? c.ip.join(', ') : '-') + '</td></tr>' +
          '<tr><td>主机 IP</td><td>192.168.1.171/24 (enp4s0-ovs)</td></tr>' +
        '</table>' +
      '</div>' +
    '</div>' +
    '<div class="detail-section">' +
      '<h4>切换网络模式</h4>' +
      '<p class="info-text" style="margin-bottom:12px;">' +
        '当前容器使用 <code>' + esc(netLink) + '</code> 桥接（NAT 模式，10.0.3.x 子网）。' +
        '如需与主机同网段，可选以下模式：' +
      '</p>' +
      '<div class="network-mode-card" onclick="setNetworkMode(' + "'" + esc(currentContainer) + "'" + ", 'lxcbr0')" +
        ' style="cursor:pointer;padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;' +
        (netType === 'veth' && netLink === 'lxcbr0' ? 'border-color:var(--accent);' : '') + '">' +
        '<div><strong>lxcbr0 (NAT) — 当前默认</strong></div>' +
        '<div class="text-muted" style="font-size:12px;">容器分配到 10.0.3.x 子网，通过 NAT 访问外网。隔离性好，但和宿主机不在同网段。</div>' +
      '</div>' +
      '<div class="network-mode-card" onclick="setNetworkMode(' + "'" + esc(currentContainer) + "'" + ", 'macvlan')" +
        ' style="cursor:pointer;padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;' +
        (netType === 'macvlan' ? 'border-color:var(--accent);' : '') + '">' +
        '<div><strong>macvlan — 同网段（推荐）</strong></div>' +
        '<div class="text-muted" style="font-size:12px;">容器获取与宿主机同网段的 IP（192.168.1.x），DHCP 自动分配。无法直接访问宿主机，但可互访其他局域网设备。</div>' +
      '</div>' +
      '<p class="info-text" style="margin-top:12px;font-size:12px;color:var(--text-dim);">' +
        '切换网络模式后需重启容器生效。macvlan 模式将在重启后从上级路由获取 DHCP IP。' +
      '</p>' +
    '</div>';
}

async function setNetworkMode(name, mode) {
  try {
    if (mode === 'lxcbr0') {
      await lxc('/' + encodeURIComponent(name) + '/config', 'PUT', { updates: {
        'lxc.net.0.type': 'veth',
        'lxc.net.0.link': 'lxcbr0',
        'lxc.net.0.flags': 'up',
      }});
    } else if (mode === 'macvlan') {
      const settings = await sys('/settings');
      const hostIface = settings.data.host_interface || 'enp4s0-ovs';
      await lxc('/' + encodeURIComponent(name) + '/config', 'PUT', { updates: {
        'lxc.net.0.type': 'macvlan',
        'lxc.net.0.link': hostIface,
        'lxc.net.0.flags': 'up',
      }});
    }
    toast('网络配置已更新，请重启容器生效', 'success');
    showDetailTab('network');
  } catch(e) {
    toast('网络配置失败: ' + e.message, 'error');
  }
}

async function createBackup() {
  confirm('创建备份（将使用当前设置中的备份配置）', async () => {
    try {
      await lxc(`/${encodeURIComponent(currentContainer)}/backup`, 'POST');
      toast('备份创建成功', 'success');
      showDetailTab('backups');
    } catch(e) { toast('备份失败: ' + e.message, 'error'); }
  });
}
async function restoreBackup(file) {
  promptInput('从备份恢复', `从 ${esc(file)} 恢复到哪个容器名？`, currentContainer + '-restored', async (newname) => {
    if (!newname) { toast('请输入容器名', 'warning'); return; }
    try {
      await lxc(`/${encodeURIComponent(currentContainer)}/backup/${encodeURIComponent(file)}/restore`, 'POST', { newname });
      toast(`已恢复为 ${newname}`, 'success');
      showDetailTab('backups');
      loadContainers();
    } catch(e) { toast('恢复失败: ' + e.message, 'error'); }
  });
}
async function deleteBackup(file) {
  confirm(`确定要删除备份 ${esc(file)} 吗？`, async () => {
    try {
      await lxc(`/${encodeURIComponent(currentContainer)}/backup/${encodeURIComponent(file)}`, 'DELETE');
      toast('备份已删除', 'success');
      showDetailTab('backups');
    } catch(e) { toast('删除失败: ' + e.message, 'error'); }
  });
}

function closeModal() {
  document.getElementById('container-modal').classList.remove('active');
  currentContainer = '';
}

// ═══════════ CREATE CONTAINER ═══════════
function switchCreateTab(tab) {
  activeCreateTab = tab;
  document.querySelectorAll('.create-tab').forEach(b => b.classList.toggle('active', b.dataset.createTab === tab));
  document.querySelectorAll('.create-section').forEach(s => s.classList.toggle('active', s.id === `create-${tab}`));
  if (tab === 'clone') refreshCloneSelects();
  else if (tab === 'snapshot') refreshSnapshotSelects();
  else if (tab === 'backup') refreshBackupSelects();
  else if (tab === 'template') refreshTemplateSelect();
  else if (tab === 'local') refreshLocalTemplateSelect();
}

async function refreshCreateSelects() { refreshTemplateSelect(); }

async function refreshTemplateSelect() {
  try {
    const r = await lxc('/templates');
    const sel = document.getElementById('ct-template');
    const tpls = r.data || [];
    sel.innerHTML = '<option value="">选择模板...</option>' +
      tpls.map(t => {
        const note = t.note ? ' ' + t.note : '';
        const available = t.available !== false;
        return `<option value="${esc(t.name)}" ${!available ? 'disabled style="color:#999"' : ''}>${esc(t.os)} ${t.release || ''}${note}</option>`;
      }).join('');
    // 自动选择第一个可用模板并加载版本
    const defaultOpt = [...sel.options].find(o => o.value === 'sshd') || sel.options[1] || sel.options[0];
    if (defaultOpt && defaultOpt.value) {
      defaultOpt.selected = true;
      setTimeout(() => handleTemplateChange(defaultOpt.value), 100);
    } else {
      document.getElementById('ct-release').innerHTML = '<option value="">— 先选发行版 —</option>';
    }
  } catch(e) {}
}
async function refreshCloneSelects() {
  try {
    const sel = document.getElementById('clone-source');
    sel.innerHTML = '<option value="">选择容器...</option>' +
      containers.map(c => `<option value="${esc(c.name)}">${esc(c.name)} (${fmtState(c.state)})</option>`).join('');
  } catch(e) {}
}
async function refreshSnapshotSelects() {
  try {
    const sel = document.getElementById('snap-source');
    sel.innerHTML = '<option value="">选择容器...</option>' +
      containers.filter(c => c.snapshots > 0).map(c => `<option value="${esc(c.name)}">${esc(c.name)} (${c.snapshots} 快照)</option>`).join('');
  } catch(e) {}
}
async function refreshBackupSelects() {
  try {
    const sel = document.getElementById('backup-source');
    sel.innerHTML = '<option value="">选择容器...</option>' +
      containers.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  } catch(e) {}
}

async function loadSnapshotList() {
  const src = document.getElementById('snap-source').value;
  const sel = document.getElementById('snap-select');
  if (!src) { sel.innerHTML = '<option value="">先选择容器...</option>'; return; }
  try {
    const r = await lxc(`/${encodeURIComponent(src)}/snapshots`);
    sel.innerHTML = (r.data || []).length === 0
      ? '<option value="">该容器无快照</option>'
      : (r.data || []).map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
  } catch(e) { sel.innerHTML = '<option value="">加载失败</option>'; }
}
async function loadBackupList() {
  const src = document.getElementById('backup-source').value;
  const sel = document.getElementById('backup-select');
  if (!src) { sel.innerHTML = '<option value="">先选择容器...</option>'; return; }
  try {
    const r = await lxc(`/${encodeURIComponent(src)}/backups`);
    sel.innerHTML = (r.data || []).length === 0
      ? '<option value="">该容器无备份</option>'
      : (r.data || []).map(b => `<option value="${esc(b.filename)}">${esc(b.filename)} (${fmtBytes(b.size)})</option>`).join('');
  } catch(e) { sel.innerHTML = '<option value="">加载失败</option>'; }
}

async function handleCreateFromTemplate(e) {
  e.preventDefault();
  const data = {
    name: document.getElementById('ct-name').value.trim(),
    template: document.getElementById('ct-template').value,
    release: document.getElementById('ct-release').value.trim(),
    arch: document.getElementById('ct-arch').value,
    autostart: document.getElementById('ct-autostart').checked,
    container_order: parseInt(document.getElementById('ct-order').value) || 0,
  };
  if (!data.name) { toast('请输入容器名称', 'warning'); return; }
  if (!data.template) { toast('请选择模板', 'warning'); return; }
  toast('正在创建容器...', 'info');
  try {
    await lxc('/create', 'POST', data);
    toast(`容器 ${data.name} 创建成功`, 'success');
    switchTab('containers');
    document.getElementById('ct-name').value = '';
  } catch(e) { toast('创建失败: ' + e.message, 'error'); }
}

async function handleClone(e) {
  e.preventDefault();
  const source = document.getElementById('clone-source').value;
  const name = document.getElementById('clone-name').value.trim();
  if (!source || !name) { toast('请填写完整信息', 'warning'); return; }
  toast('正在克隆容器...', 'info');
  try {
    await lxc('/create/copy', 'POST', { name, source });
    toast(`容器 ${source} 已克隆为 ${name}`, 'success');
    switchTab('containers');
  } catch(e) { toast('克隆失败: ' + e.message, 'error'); }
}

async function handleCreateFromSnapshot(e) {
  e.preventDefault();
  const source = document.getElementById('snap-source').value;
  const snapshot = document.getElementById('snap-select').value;
  const name = document.getElementById('snap-new-name').value.trim();
  if (!source || !snapshot || !name) { toast('请填写完整信息', 'warning'); return; }
  toast('正在从快照创建容器...', 'info');
  try {
    await lxc('/create/from-snapshot', 'POST', { name, source, snapshot });
    toast(`已从 ${source}/${snapshot} 创建 ${name}`, 'success');
    switchTab('containers');
  } catch(e) { toast('创建失败: ' + e.message, 'error'); }
}

async function handleCreateFromBackup(e) {
  e.preventDefault();
  const source = document.getElementById('backup-source').value;
  const backup_name = document.getElementById('backup-select').value;
  const name = document.getElementById('backup-new-name').value.trim();
  if (!source || !backup_name || !name) { toast('请填写完整信息', 'warning'); return; }
  toast('正在从备份恢复容器...', 'info');
  try {
    await lxc('/create/from-backup', 'POST', { name, backup_name });
    toast(`已从备份恢复为 ${name}`, 'success');
    switchTab('containers');
  } catch(e) { toast('恢复失败: ' + e.message, 'error'); }
}

// ═══════════ TEMPLATES ═══════════
async function loadTemplates() {
  const grid = document.getElementById('template-grid');
  try {
    const r = await lxc('/templates');
    const tpls = r.data || [];
    if (tpls.length === 0) {
      grid.innerHTML = '<div class="empty-state"><p>未找到可用模板</p></div>'; return;
    }
    // Group by distro
    const distros = [...new Set(tpls.map(t => t.name.split('/')[0]))];
    grid.innerHTML = distros.map(distro => `
      <div class="template-card">
        <div class="template-name">${esc(distro)}</div>
        <div class="template-info">点击选择版本</div>
        <button class="btn btn-sm btn-primary" onclick="openVersionsModal('${esc(distro)}')">📋 版本</button>
      </div>`).join('');
  } catch(e) {
    grid.innerHTML = `<div class="empty-state"><p>加载失败: ${esc(e.message)}</p></div>`;
  }
}

async function handleTemplateChange(distro) {
  const releaseSel = document.getElementById('ct-release');
  releaseSel.innerHTML = '<option value="">加载中...</option>';
  if (!distro) {
    releaseSel.innerHTML = '<option value="">— 先选发行版 —</option>';
    return;
  }
  // 本地模板（sshd/busybox）直接返回无版本要求
  if (['sshd', 'busybox'].includes(distro)) {
    releaseSel.innerHTML = '<option value="">本地模板，无版本要求</option>';
    return;
  }
  try {
    const r = await lxc(`/templates/${encodeURIComponent(distro)}/versions`);
    const versions = r.data || [];
    const releases = [...new Set(versions.map(v => v.release))];
    releaseSel.innerHTML = '<option value="">选择版本...</option>' +
      releases.map(rel => `<option value="${esc(rel)}">${esc(rel)}</option>`).join('');
  } catch(e) {
    releaseSel.innerHTML = '<option value="">加载失败</option>';
  }
}

async function openVersionsModal(distro) {
  document.getElementById('versions-title').textContent = `${distro} — 选择版本`;
  document.getElementById('versions-list').innerHTML = '';
  document.getElementById('versions-loading').style.display = 'block';
  document.getElementById('versions-modal').classList.add('active');
  try {
    const r = await lxc(`/templates/${encodeURIComponent(distro)}/versions`);
    const versions = r.data || [];
    document.getElementById('versions-loading').style.display = 'none';
    if (versions.length === 0) {
      document.getElementById('versions-list').innerHTML = '<p class="info-text">未找到可用版本</p>';
      return;
    }
    document.getElementById('versions-list').innerHTML = versions.map(v => {
      const cached = v.cached;
      const date = v.build_date ? new Date(v.build_date).toLocaleDateString('zh-CN') : '-';
      const variant = v.variant !== 'default' ? v.variant : '';
      const releaseLabel = variant ? `${v.release} (${variant})` : v.release;
      return `<div class="version-item">
        <div class="version-info">
          <div class="version-release">${esc(releaseLabel)}</div>
          <div class="version-meta">架构: ${esc(v.arch)} · 构建: ${esc(date)}</div>
        </div>
        <div class="version-actions">
          ${cached
            ? `<button class="btn btn-sm btn-success" onclick="createFromVersion('${esc(distro)}','${esc(v.release)}','${esc(v.arch)}','${esc(variant)}')">▶ 创建容器</button>`
            : `<button class="btn btn-sm btn-primary" onclick="downloadVersion('${esc(distro)}','${esc(v.release)}','${esc(v.arch)}','${esc(variant)}')">⬇ 下载</button>`
          }
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    document.getElementById('versions-loading').style.display = 'none';
    document.getElementById('versions-list').innerHTML = `<p class="error-text">加载失败: ${esc(e.message)}</p>`;
  }
}

function closeVersionsModal() {
  document.getElementById('versions-modal').classList.remove('active');
}

function createFromVersion(distro, release, arch, variant) {
  closeVersionsModal();
  switchTab('create');
  switchCreateTab('template').then(() => {
    document.getElementById('ct-template').value = distro;
    document.getElementById('ct-release').value = release;
    document.getElementById('ct-arch').value = arch || 'amd64';
  });
  toast(`已选择: ${distro}/${release} (${arch})`, 'info');
}

async function downloadVersion(distro, release, arch, variant) {
  toast(`正在下载 ${distro}/${release}/${arch}...`, 'info');
  try {
    await lxc('/cache/fetch', 'POST', { distro, release, arch });
    toast(`下载成功: ${distro}/${release}/${arch}`, 'success');
    // Refresh the versions modal
    openVersionsModal(distro);
  } catch(e) { toast(`下载失败: ${e.message}`, 'error'); }
}

// ═══════════ TEMPLATE CACHE ═══════════
async function loadCacheList() {
  const el = document.getElementById('cache-list');
  const loading = document.getElementById('cache-loading');
  loading.style.display = 'block';
  el.innerHTML = '';
  try {
    const r = await lxc('/cache/list');
    const items = r.data || [];
    loading.style.display = 'none';
    if (items.length === 0) {
      el.innerHTML = '<p class="info-text">暂无缓存记录，请点击"预热缓存"下载镜像。</p>';
      return;
    }
    el.innerHTML = items.map(item => {
      const cached = item.cached;
      const size = item.size ? fmtBytes(item.size) : '-';
      const meta = item.metadata || {};
      const date = meta.created_at ? fmtDate(meta.created_at) : '-';
      const path = esc(item.path || '');
      const key = `${item.distro}/${item.release}/${item.arch}`;
      return `<div class="cache-card ${cached ? 'cached' : 'uncached'}">
        <div class="cache-card-header">
          <span class="cache-card-name">${esc(item.distro)} ${esc(item.release)} · ${esc(item.arch)}</span>
          <span class="cache-card-badge ${cached ? 'cache-badge-cached' : 'cache-badge-uncached'}">${cached ? '✅ 已缓存' : '⏳ 未缓存'}</span>
        </div>
        <div class="cache-card-meta">${size !== '-' ? `<div>大小: ${size}</div>` : ''}<div>${date}</div></div>
        <div class="cache-card-actions">
          ${!cached ? `<button class="btn btn-sm btn-primary" onclick="fetchCacheImage('${esc(item.distro)}','${esc(item.release)}','${esc(item.arch)}')">⬇ 下载</button>` : ''}
          ${cached ? `<button class="btn btn-sm btn-success" onclick="createFromVersion('${esc(item.distro)}','${esc(item.release)}','${esc(item.arch)}','')">▶ 创建容器</button>
          <button class="btn btn-sm btn-danger" onclick="deleteCacheImage('${esc(item.distro)}','${esc(item.release)}','${esc(item.arch)}')">🗑 删除</button>` : ''}
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    loading.style.display = 'none';
    el.innerHTML = `<p class="info-text" style="color:var(--danger)">加载失败: ${esc(e.message)}</p>`;
  }
}

async function fetchCacheImage(distro, release, arch) {
  toast(`正在下载 ${distro}/${release}/${arch}...`, 'info');
  try {
    await lxc('/cache/fetch', 'POST', { distro, release, arch });
    toast(`下载成功: ${distro}/${release}/${arch}`, 'success');
    loadCacheList();
  } catch(e) { toast(`下载失败: ${e.message}`, 'error'); }
}

async function deleteCacheImage(distro, release, arch) {
  confirm(`确定要删除 ${distro}/${release}/${arch} 的缓存吗？`, async () => {
    try {
      await lxc(`/cache/${encodeURIComponent(distro)}/${encodeURIComponent(release)}/${encodeURIComponent(arch)}`, 'DELETE');
      toast('缓存已删除', 'success');
      loadCacheList();
    } catch(e) { toast(`删除失败: ${e.message}`, 'error'); }
  });
}

async function warmCache() {
  toast('正在预热缓存...', 'info');
  try {
    await lxc('/cache/warm', 'POST');
    toast('缓存预热完成', 'success');
    loadCacheList();
  } catch(e) { toast(`预热失败: ${e.message}`, 'error'); }
}

function selectTemplate(name) {
  switchTab('create');
  switchCreateTab('template');
  const sel = document.getElementById('ct-template');
  if ([...sel.options].some(o => o.value === name)) sel.value = name;
  toast(`已选择模板: ${name}`, 'info');
}

// ═══════════ SETTINGS ═══════════
async function loadSettings() {
  document.getElementById('settings-loading').style.display = 'block';
  document.getElementById('settings-form').style.display = 'none';
  try {
    const [r, ifaces] = await Promise.all([sys('/settings'), sys('/interfaces')]);
    const s = r.data || {};
    const sel = document.getElementById('stg-interface');
    sel.innerHTML = '<option value="">自动</option>' +
      (ifaces.data || []).map(i => `<option value="${esc(i.name)}"${i.name === s.default_interface ? ' selected' : ''}>${esc(i.name)} (${esc(i.type)})</option>`).join('');
    document.getElementById('stg-path').value = s.default_path || '';
    document.getElementById('stg-cache').value = s.cache_dir || '';
    document.getElementById('stg-backend').value = s.backend_type || 'dir';
    document.getElementById('stg-lxc-mirror').value = s.lxc_mirror || 'https://images.linuxcontainers.org';
    document.getElementById('stg-backup-path').value = s.backup_path || '';
    document.getElementById('stg-backup-keep').value = s.backup_keep || 7;
    document.getElementById('stg-backup-compression').value = s.backup_compression || 6;
    document.getElementById('stg-backup-threads').value = s.backup_threads || 4;
    document.getElementById('stg-backup-snapshot').checked = s.backup_use_snapshot === 'true';
    document.getElementById('settings-loading').style.display = 'none';
    document.getElementById('settings-form').style.display = 'block';
  } catch(e) {
    document.getElementById('settings-loading').innerHTML = `<p>加载设置失败: ${esc(e.message)}</p>`;
  }
}

async function handleSaveSettings(e) {
  e.preventDefault();
  const data = {
    default_path: document.getElementById('stg-path').value,
    cache_dir: document.getElementById('stg-cache').value,
    backend_type: document.getElementById('stg-backend').value,
    default_interface: document.getElementById('stg-interface').value,
    lxc_mirror: document.getElementById('stg-lxc-mirror').value,
    backup_path: document.getElementById('stg-backup-path').value,
    backup_keep: document.getElementById('stg-backup-keep').value,
    backup_compression: document.getElementById('stg-backup-compression').value,
    backup_threads: document.getElementById('stg-backup-threads').value,
    backup_use_snapshot: document.getElementById('stg-backup-snapshot').checked ? 'true' : 'false',
  };
  try {
    await sys('/settings', 'PUT', data);
    toast('设置已保存', 'success');
  } catch(e) { toast('保存失败: ' + e.message, 'error'); }
}

// ═══════════ Refresh All ═══════════
function refreshAll() {
  const active = document.querySelector('.tab-content.active');
  if (active) {
    const id = active.id;
    if (id === 'tab-containers') loadContainers();
    else if (id === 'tab-dashboard') loadDashboard();
    else if (id === 'tab-templates') { loadProxmoxTemplates(); loadCachedTemplates(); }
    else if (id === 'tab-settings') loadSettings();
  }
  toast('已刷新', 'success');
}

// ═══════════ Proxmox Templates ═══════════
function showProxmoxTemplates() {
  // 已加载过 -> 直接渲染缓存，不请求
  if (proxmoxLoaded && proxmoxData) {
    document.getElementById('proxmox-loading').style.display = 'none';
    renderProxmoxGrid(proxmoxData);
    return;
  }
  // 首次 -> 拉远程
  loadProxmoxTemplates();
}

async function loadProxmoxTemplates() {
  const grid = document.getElementById('proxmox-grid');
  const loading = document.getElementById('proxmox-loading');
  if (!grid) return;
  // 强制刷新：重置缓存标记
  proxmoxLoaded = false;
  proxmoxData = null;
  loading.style.display = '';
  grid.innerHTML = '';
  try {
    const r = await lxc('/../templates/proxmox');
    const tpls = r.data || [];
    loading.style.display = 'none';
    // 写入缓存
    proxmoxLoaded = true;
    proxmoxData = tpls;
    renderProxmoxGrid(tpls);
  } catch(e) {
    loading.style.display = 'none';
    // 即使失败，也标记为"已尝试加载"，避免反复请求
    proxmoxLoaded = true;
    proxmoxData = [];
    grid.innerHTML = `<div class="empty-state"><p>加载失败: ${esc(e.message)}</p></div>`;
  }
}

function renderProxmoxGrid(tpls) {
  const grid = document.getElementById('proxmox-grid');
  if (!grid) return;
  if (tpls.length === 0) {
    grid.innerHTML = '<div class="empty-state"><p>未获取到模板列表</p></div>'; return;
  }
  grid.innerHTML = tpls.map(t => {
    const cached = t.cached ? '<span class="badge" style="background:#2ea043">已缓存</span>' : '';
    return `<div class="template-card">
      <div class="template-name">${esc(t.package)} ${cached}</div>
      <div class="template-info">${esc(t.os)} ${t.version ? 'v'+esc(t.version) : ''} | ${esc(t.arch)}</div>
      <div class="template-info" style="font-size:12px;color:#888">${esc(t.description)}</div>
      <div class="template-actions">
        ${t.cached
          ? `<button class="btn btn-sm btn-primary" onclick="createFromProxmox('${esc(t.tar_file)}')">📦 创建容器</button>`
          : `<button class="btn btn-sm btn-primary" onclick="downloadProxmoxTemplate('${esc(t.tar_url)}','${esc(t.tar_file)}')">⬇ 下载</button>`}
      </div>
    </div>`;
  }).join('');
}

async function downloadProxmoxTemplate(url, file) {
  toast('开始下载...', 'info');
  try {
    await lxc('/../templates/proxmox/download', 'POST', { url, file });
    toast('下载完成', 'success');
    // 下载后清除缓存，强制刷新
    proxmoxLoaded = false; proxmoxData = null;
    cacheLoaded = false; cacheData = null;
    loadProxmoxTemplates();
    loadCachedTemplates();
  } catch(e) { toast('下载失败: ' + e.message, 'error'); }
}

function showCachedTemplates() {
  if (cacheLoaded && cacheData) {
    document.getElementById('cache-loading').style.display = 'none';
    renderCachedGrid(cacheData);
    return;
  }
  loadCachedTemplates();
}

async function loadCachedTemplates() {
  const list = document.getElementById('cache-list');
  const loading = document.getElementById('cache-loading');
  if (!list) return;
  cacheLoaded = false; cacheData = null;
  loading.style.display = '';
  try {
    const r = await lxc('/../templates/cached');
    const items = r.data || [];
    loading.style.display = 'none';
    cacheLoaded = true; cacheData = items;
    renderCachedGrid(items);
  } catch(e) {
    loading.style.display = 'none';
    cacheLoaded = true; cacheData = [];
    list.innerHTML = `<div class="empty-state"><p>加载失败: ${esc(e.message)}</p></div>`;
  }
}

function renderCachedGrid(items) {
  const list = document.getElementById('cache-list');
  if (!list) return;
  if (items.length === 0) {
    list.innerHTML = '<div class="empty-state"><p>暂无缓存模板</p></div>'; return;
  }
  list.innerHTML = items.map(i =>
    `<div class="cache-item">
      <span class="cache-name">${esc(i.file)}</span>
      <span class="cache-size">${fmtBytes(i.size)}</span>
      <button class="btn btn-sm btn-primary" onclick="createFromProxmox('${esc(i.file)}')">📦 创建容器</button>
    </div>`
  ).join('');
}

async function createFromProxmox(file) {
  switchTab('create');
  switchCreateTab('local');
  // 直接等下拉填充完成
  try {
    const r = await lxc('/../templates/cached');
    const items = r.data || [];
    const sel = document.getElementById('cl-template');
    if (sel) {
      sel.innerHTML = '<option value="">选择模板文件...</option>' +
        items.map(i => `<option value="${esc(i.file)}">${esc(i.file)} (${fmtBytes(i.size)})</option>`).join('');
      sel.value = file;
    }
  } catch(e) {
    toast('加载模板列表失败: ' + e.message, 'error');
  }
}

async function refreshLocalTemplateSelect() {
  const sel = document.getElementById('cl-template');
  if (!sel) return;
  try {
    const r = await lxc('/../templates/cached');
    const items = r.data || [];
    if (items.length === 0) {
      sel.innerHTML = '<option value="">暂无缓存模板，请先在模板页下载</option>';
      return;
    }
    sel.innerHTML = '<option value="">选择模板文件...</option>' +
      items.map(i => `<option value="${esc(i.file)}">${esc(i.file)} (${fmtBytes(i.size)})</option>`).join('');
  } catch(e) {
    sel.innerHTML = '<option value="">加载失败</option>';
  }
}

async function handleCreateFromLocal(e) {
  e.preventDefault();
  const name = document.getElementById('cl-name').value.trim();
  const tmpl = document.getElementById('cl-template').value;
  const autostart = document.getElementById('cl-autostart').checked;
  if (!name) { toast('请输入容器名称', 'warning'); return; }
  if (!tmpl) { toast('请选择模板文件', 'warning'); return; }
  toast('正在创建容器...', 'info');
  try {
    const r = await lxc('/create/from-proxmox', 'POST', { name, template_file: tmpl, autostart });
    toast(`容器 ${name} 创建成功`, 'success');
    switchTab('containers');
  } catch(e) { toast('创建失败: ' + e.message, 'error'); }
}

// ═══════════ Auto-refresh ═══════════
function startAutoRefresh() {
  if (autoRefresh) clearInterval(autoRefresh);
  autoRefresh = setInterval(() => {
    const active = document.querySelector('.tab-content.active');
    if (active && active.id === 'tab-containers') loadContainers();
  }, 15000);
}

// ═══════════ Init ═══════════
document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();
  startAutoRefresh();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closeConfirm(); closePrompt(); closeTerminal(); }
});
