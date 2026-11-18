/* FnLxc v2 — 完整前端 */
const API = '/app/lxcmanager/api/lxc';
const SYS_API = '/app/lxcmanager/api';
let containers = [], templates = [], currentContainer = '';
let activeDetailTab = 'info';
let detailRequestId = 0;
let proxmoxLoaded = false, proxmoxData = null;
let cacheLoaded = false, cacheData = null;
let activeCreateTab = 'local';
let confirmCallback = null, promptCallback = null;
let autoRefresh = null;

// ═══════════ API ═══════════
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  let d;
  try {
    d = await r.json();
  } catch(e) {
    throw new Error(`HTTP ${r.status}: 响应不是有效 JSON`);
  }
  if (!r.ok && !d.success) throw new Error(d.error || `HTTP ${r.status}`);
  if (!d.success) throw new Error(d.error || '请求失败');
  return d;
}
async function lxc(url, method = 'GET', body) { return api(method, `${API}${url}`, body); }
async function sys(url, method = 'GET', body) { return api(method, `${SYS_API}${url}`, body); }

// ═══════════ IP Polling ═══════════
function pollContainerIP(name) {
  let attempts = 0;
  const maxAttempts = 30; // 60s 超时
  const delay = 2000;
  function tick() {
    lxc('/' + name + '/info').then(r => {
      const info = r.data || {};
      const ipv4 = (info.ipv4 || []).filter(ip => ip !== '127.0.0.1');
      const ipv6 = info.ipv6 || [];
      // 只用 IPv4 判断成功（DHCP 可能稍后分配），IPv6 收集到最后一起显示
      if (ipv4.length > 0) {
        const all = [...ipv4, ...ipv6].filter(ip => ip !== '::1');
        toast(name + ' IP: ' + all.join(', '), 'success');
        loadContainers();
        return;
      }
      attempts++;
      if (attempts < maxAttempts) setTimeout(tick, delay);
    }).catch(() => {
      attempts++;
      if (attempts < maxAttempts) setTimeout(tick, delay);
    });
  }
  // 等 2 秒让容器启动稳定后再开始轮询
  setTimeout(tick, 2000);
}

// ═══════════ Toast ═══════════
function toast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  const icons = { success: '✓', error: '✗', warning: '⚠', info: 'ℹ' };
  t.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${esc(msg)}</span>`;
  c.appendChild(t);
  // Trigger reflow for animation
  void t.offsetWidth;
  t.classList.add('toast-visible');
  setTimeout(() => {
    t.classList.remove('toast-visible');
    t.classList.add('toast-hiding');
    setTimeout(() => t.remove(), 300);
  }, 3500);
}

// ═══════════ Modal Manager (统一弹窗层级管理) ═══════════
const ModalManager = {
  stack: [],
  open(id) {
    // 容器详情已经并入工作区；普通弹窗与终端互斥
    if (id !== 'terminal-modal') this.closeAll();
    if (id === 'terminal-modal') this.close('terminal-modal');
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('active');
    this.stack.push(id);
    // ESC 关闭监听
    if (!this._escBound) {
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.stack.length > 0) {
          this.closeTop();
        }
      });
      this._escBound = true;
    }
  },
  close(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
    this.stack = this.stack.filter(i => i !== id);
  },
  closeTop() {
    if (this.stack.length === 0) return;
    const id = this.stack[this.stack.length - 1];
    this.close(id);
    // 特殊清理
    if (id === 'terminal-modal') { closeTerminal(); }
    if (id === 'confirm-modal') { confirmCallback = null; }
    if (id === 'prompt-modal') { promptCallback = null; }
  },
  closeAll() {
    this.stack.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active');
    });
    this.stack = [];
    if (termSocket) { termSocket.close(); termSocket = null; }
    confirmCallback = null;
    promptCallback = null;
  }
};

// ═══════════ Confirm / Prompt ═══════════
function confirm(msg, cb) {
  document.getElementById('confirm-message').textContent = msg;
  document.getElementById('confirm-btn').textContent = '确定';
  document.getElementById('confirm-btn').className = 'btn btn-danger';
  confirmCallback = cb;
  ModalManager.open('confirm-modal');
}
function closeConfirm() { ModalManager.close('confirm-modal'); confirmCallback = null; }
function confirmAction() { const cb = confirmCallback; closeConfirm(); if (cb) cb(); }

function promptInput(title, msg, placeholder, cb) {
  document.getElementById('prompt-title').textContent = title;
  document.getElementById('prompt-message').textContent = msg;
  document.getElementById('prompt-input').value = '';
  document.getElementById('prompt-input').placeholder = placeholder;
  promptCallback = cb;
  ModalManager.open('prompt-modal');
  setTimeout(() => document.getElementById('prompt-input').focus(), 200);
}
function closePrompt() { ModalManager.close('prompt-modal'); promptCallback = null; }
function promptConfirm() {
  const cb = promptCallback, val = document.getElementById('prompt-input').value.trim();
  closePrompt(); if (cb) cb(val);
}

// ═══════════ Helpers ═══════════
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function jsEscape(s) { return esc(s).replace(/'/g, "\\'"); }
function fmtBytes(b) {
  if (!b || b <= 0) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length-1) { b /= 1024; i++; }
  return `${b.toFixed(1)} ${u[i]}`;
}
function fmtRate(bps) {
  if (!bps || bps <= 0) return '-';
  if (bps >= 1000000) return (bps / 1000000).toFixed(1) + ' MB/s';
  if (bps >= 1000) return (bps / 1000).toFixed(1) + ' KB/s';
  return bps.toFixed(0) + ' B/s';
}
function fmtDisk(b) {
  if (!b || b <= 0) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length-1) { b /= 1024; i++; }
  return `${b.toFixed(1)} ${u[i]}`;
}
function fmtState(s) { return { running: '运行中', stopped: '已停止', frozen: '已冻结', starting: '启动中', stopping: '停止中', 'backing up': '创建中' }[s] || s; }
function stateClass(s) { return { running: 'running', stopped: 'stopped', frozen: 'frozen', 'backing up': 'running' }[s] || 'unknown'; }
function fmtDate(d) { if (!d) return '-'; try { return new Date(d).toLocaleString('zh-CN'); } catch(e) { return d; } }

// ═══════════ Navigation (Sidebar) ═══════════
const TAB_TITLES = {
  dashboard: '仪表盘',
  containers: '容器',
  create: '创建',
  templates: '模板',
  settings: '设置',
  logs: '日志',
};

function switchTab(name) {
  // 兼容旧选择器：优先侧边栏 .nav-item，回退到旧 .tab-btn
  const items = document.querySelectorAll('.nav-item, .tab-btn');
  items.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${name}`));
  // 同步顶部栏标题
  const titleEl = document.getElementById('topbar-title');
  if (titleEl && TAB_TITLES[name]) titleEl.textContent = TAB_TITLES[name];
  // 小屏幕：切换后自动收起侧边栏
  if (window.innerWidth <= 900) closeSidebar();

  if (name === 'containers') loadContainers();
  else if (name === 'dashboard') loadDashboard();
  else if (name === 'templates') { showProxmoxTemplates(); showCachedTemplates(); }
  else if (name === 'create') { refreshCreateSelects(); refreshLocalTemplateSelect(); }
  else if (name === 'settings') loadSettings();
  else if (name === 'logs') loadLogs();
}

// ═══════════ Sidebar Toggle (响应式) ═══════════
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const mask = document.getElementById('sidebar-mask');
  if (!sidebar) return;
  if (window.innerWidth <= 900) {
    // 移动端：抽屉式展开/收起
    const open = sidebar.classList.toggle('mobile-open');
    if (mask) mask.classList.toggle('visible', open);
  } else {
    // 桌面端：折叠为仅图标
    sidebar.classList.toggle('collapsed');
  }
}
function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const mask = document.getElementById('sidebar-mask');
  if (sidebar) sidebar.classList.remove('mobile-open');
  if (mask) mask.classList.remove('visible');
}
function openSidebar() {
  const sidebar = document.getElementById('sidebar');
  const mask = document.getElementById('sidebar-mask');
  if (sidebar) sidebar.classList.add('mobile-open');
  if (mask) mask.classList.add('visible');
}
// 窗口尺寸变化时清理移动端展开状态
window.addEventListener('resize', () => {
  if (window.innerWidth > 900) closeSidebar();
});

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
          <tr><td>网络接口</td><td>${renderIfaceSummary(ifaces.data)}</td></tr>
        </table>
      </div>`;
    document.getElementById('header-stats').textContent = `${d.running}/${d.total} 运行`;
  } catch(e) {
    grid.innerHTML = `<div class="empty-state"><p>加载失败: ${esc(e.message)}</p></div>`;
  }
}

/**
 * 从容器数组更新 header 统计（运行数/总数）
 */
function updateHeaderStats(cons) {
  const running = cons.filter(c => c.state === 'running').length;
  document.getElementById('header-stats').textContent = `${running}/${cons.length} 运行`;
}

// ═══════════ CONTAINER WORKSPACE ═══════════
function containerIPv4(c) {
  const ips = (c.ipv4 || c.ip || []).filter(ip => ip !== '127.0.0.1');
  return ips[0] || '未分配 IP 地址';
}

// 上次成功拉取容器列表的时间（毫秒），用于显示数据新鲜度
let lastRefreshAt = 0;

function updateRefreshLabel() {
  const el = document.getElementById('roster-updated');
  if (!el) return;
  if (!lastRefreshAt) { el.textContent = '尚未刷新'; return; }
  const sec = Math.max(0, Math.round((Date.now() - lastRefreshAt) / 1000));
  el.textContent = sec < 45 ? '刚刚更新'
    : sec < 3600 ? `${Math.round(sec / 60)} 分钟前更新`
    : `${Math.round(sec / 3600)} 小时前更新`;
}

function markRefreshed() {
  lastRefreshAt = Date.now();
  updateRefreshLabel();
}

async function loadContainers() {
  const list = document.getElementById('container-roster');
  if (!containers.length) list.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>加载容器列表...</p></div>';
  try {
    const r = await lxc('/list');
    containers = r.data || [];
    if (!containers.some(c => c.name === currentContainer)) currentContainer = containers[0]?.name || '';
    markRefreshed();
    renderContainers();
    if (currentContainer) await openDetail(currentContainer);
    else renderEmptyWorkspace();
  } catch(e) {
    toast('加载容器列表失败: ' + e.message, 'error');
    list.innerHTML = `<div class="workspace-empty"><p>加载失败：${esc(e.message)}</p><button class="btn btn-sm btn-secondary" onclick="loadContainers()">重试</button></div>`;
  }
}

async function refreshContainers() {
  try {
    const r = await lxc('/list');
    containers = r.data || [];
    if (!containers.some(c => c.name === currentContainer)) currentContainer = containers[0]?.name || '';
    markRefreshed();
    renderContainers();
    const editing = document.querySelector('#container-detail-body input:focus, #container-detail-body textarea:focus, #container-detail-body select:focus');
    if (currentContainer && !editing) await showDetailTab(activeDetailTab);
    else if (!currentContainer) renderEmptyWorkspace();
  } catch(e) { /* 静默刷新失败不打断当前操作 */ }
}

function updateContainerCards() { renderContainers(); }

function renderContainers() {
  containers.sort((a, b) => a.name.localeCompare(b.name));
  document.getElementById('container-count-badge').textContent = containers.length;
  document.getElementById('roster-count').textContent = containers.length;
  updateRefreshLabel();
  updateHeaderStats(containers);
  const list = document.getElementById('container-roster');
  list.innerHTML = containers.length ? containers.map(c => `
    <button type="button" class="roster-item ${c.name === currentContainer ? 'active' : ''}" data-name="${escAttr(c.name)}" onclick="openDetail('${jsEscape(c.name)}')" role="option" aria-selected="${c.name === currentContainer}">
      <span class="status-dot roster-state ${stateClass(c.state)}"></span>
      <span class="roster-item-main"><span class="roster-name">${esc(c.name)}</span><span class="roster-ip">${esc(containerIPv4(c))}</span></span>
      <span class="roster-state-label">${fmtState(c.state)}</span>
    </button>`).join('') : '<div class="workspace-empty"><p>还没有容器</p><button class="btn btn-sm btn-primary" onclick="switchTab(&quot;create&quot;)">创建容器</button></div>';
}

function renderEmptyWorkspace() {
  currentContainer = '';
  detailRequestId++;
  document.getElementById('container-detail').innerHTML = '<div class="workspace-empty"><div class="empty-icon">▣</div><h3>创建你的第一个容器</h3><p>容器创建后，可在这里直接管理配置、网络与备份</p><button class="btn btn-primary" onclick="switchTab(&quot;create&quot;)">创建容器</button></div>';
}

function gotoContainers(state) { switchTab('containers'); }

function escAttr(s) { return esc(String(s)).replace(/"/g, '&quot;'); }

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

// ═══════════ MIGRATE MODAL ═══════════
let migrateCallback = null;

async function openMigrateModal(name) {
  // 获取 btrfs 存储卷列表用于填充下拉
  let pools = [];
  try {
    const r = await sys('/zfs/pools');
    pools = r.data || [];
  } catch(e) { pools = []; }

  const selPool = pools.map(p =>
    `<option value="${esc(p.name)}" data-mp="${esc(p.mountpoint || '/')}">${esc(p.mountpoint || '/')} (${esc(p.name)})</option>`
  ).join('');

  const msgDiv = document.getElementById('confirm-message');
  msgDiv.innerHTML =
    `<div style="margin-bottom:12px">迁移容器 <strong>${esc(name)}</strong> 到新存储位置</div>
    <div style="margin-bottom:8px">
      <label style="display:block;margin-bottom:4px;font-size:13px">目标存储卷</label>
      <select id="migrate-pool" style="width:100%;padding:6px;border:1px solid #ccc;border-radius:4px" onchange="onMigratePoolChange()">
        <option value="">— 不迁移（仅目录）—</option>
        ${selPool}
      </select>
    </div>
    <div>
      <label style="display:block;margin-bottom:4px;font-size:13px">目标路径</label>
      <input id="migrate-path" type="text" placeholder="/vol2/lxc" style="width:100%;padding:6px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box">
    </div>`;

  document.getElementById('confirm-btn').textContent = '确认迁移';
  document.getElementById('confirm-btn').className = 'btn btn-warning';

  migrateCallback = async () => {
    const pool = document.getElementById('migrate-pool').value;
    const path = document.getElementById('migrate-path').value.trim();
    closeConfirm();
    try {
      await lxc(`/${encodeURIComponent(name)}/migrate`, 'POST', {
        target_pool: pool,
        target_path: path
      });
      toast(`容器 ${name} 迁移成功`, 'success');
      closeModal();
      loadContainers();
    } catch(e) {
      toast(`迁移失败: ${e.message}`, 'error');
    }
  };
  confirmCallback = migrateCallback;
  document.getElementById('confirm-modal').classList.add('active');
}

function onMigratePoolChange() {
  const sel = document.getElementById('migrate-pool');
  const pathInput = document.getElementById('migrate-path');
  if (!sel || !pathInput) return;
  const selected = sel.options[sel.selectedIndex];
  if (selected && selected.value) {
    const mp = selected.getAttribute('data-mp') || '/';
    // 建议路径 = mountpoint + /lxc
    const base = mp === '/' ? '' : mp;
    pathInput.placeholder = base + '/lxc';
    if (!pathInput.value) {
      pathInput.value = pathInput.placeholder;
    }
  }
}


let termInstance = null, termSocket = null, terminalName = '';

function openTerminal(name) {
  terminalName = name;
  document.getElementById('terminal-title').textContent = '终端: ' + name;
  ModalManager.open('terminal-modal');
  document.getElementById('webshell-output').textContent = '';
  switchTermMode('pty');

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

    // 窗口大小变化时自适应 + 通知服务器
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        if (termSocket && termSocket.readyState === WebSocket.OPEN) {
          const dims = fitAddon.proposeDimensions();
          if (dims) {
            termSocket.send(JSON.stringify({ resize: [dims.cols, dims.rows] }));
          }
        }
      } catch(e) {}
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
    termInstance.focus();
    try { termInstance.fitAddon.fit(); } catch(e) {}
  }

  // 建 WebSocket 连接
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = proto + '//' + window.location.host + '/app/lxcmanager/api/lxc/' + encodeURIComponent(name) + '/terminal';
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
  ModalManager.close('terminal-modal');
  terminalName = '';
  // Reset to PTY mode for next open
  currentTermMode = 'pty';
}

let currentTermMode = 'pty';

function switchTermMode(mode) {
  const termContainer = document.getElementById('terminal-container');
  const wsContainer = document.getElementById('webshell-container');
  const btnPty = document.getElementById('term-mode-pty');
  const btnExec = document.getElementById('term-mode-exec');
  currentTermMode = mode;
  if (mode === 'pty') {
    termContainer.style.display = '';
    wsContainer.style.display = 'none';
    btnPty.classList.add('btn-primary');
    btnExec.classList.remove('btn-primary');
    if (termInstance) { termInstance.focus(); }
  } else {
    termContainer.style.display = 'none';
    wsContainer.style.display = '';
    btnPty.classList.remove('btn-primary');
    btnExec.classList.add('btn-primary');
    document.getElementById('webshell-cmd').focus();
  }
}

async function execCommand() {
  const input = document.getElementById('webshell-cmd');
  const output = document.getElementById('webshell-output');
  const cmd = input.value.trim();
  if (!cmd) return;
  // Echo command
  output.textContent += '$ ' + cmd + '\n';
  input.value = '';
  try {
    const r = await lxc('/' + encodeURIComponent(terminalName) + '/exec', 'POST', { cmd });
    if (r.data.stdout) output.textContent += r.data.stdout + '\n';
    if (r.data.stderr) output.textContent += '\x1b[31m' + r.data.stderr + '\x1b[0m\n';
    if (r.data.exit_code !== 0 && !r.data.stdout && !r.data.stderr) {
      output.textContent += '\x1b[31m(command exited with code ' + r.data.exit_code + ')\x1b[0m\n';
    }
  } catch(e) {
    output.textContent += '\x1b[31mError: ' + e.message + '\x1b[0m\n';
  }
  // Scroll to bottom
  output.parentElement.scrollTop = output.parentElement.scrollHeight;
}

// ═══════════ CONTAINER DETAIL WORKSPACE ═══════════
let detailOpen = false;
const DETAIL_TABS = [
  ['info', '概览'], ['settings', '设置'], ['network', '网络'], ['data', '数据']
];
const DETAIL_TAB_ALIASES = { config: 'settings', limits: 'settings', meta: 'settings', snapshots: 'data', backups: 'data' };

function detailActions(c) {
  const name = jsEscape(c.name);
  const primary = c.state === 'running'
    ? `<button class="btn btn-sm btn-primary" onclick="act('${name}','restart')">↻ 重启</button><button class="btn btn-sm btn-secondary" onclick="act('${name}','stop')">■ 停止</button>`
    : c.state === 'frozen'
      ? `<button class="btn btn-sm btn-success" onclick="act('${name}','unfreeze')">▶ 解冻</button>`
      : `<button class="btn btn-sm btn-success" onclick="act('${name}','start')">▶ 启动</button>`;
  return `${primary}<button class="btn btn-sm btn-secondary" onclick="openTerminal('${name}')">&gt;_ 终端</button><button class="btn btn-sm btn-ghost" onclick="toggleMoreActions()" aria-label="更多操作" title="更多操作">•••</button>`;
}

async function openDetail(name, tab = 'info') {
  if (!containers.some(c => c.name === name)) return;
  currentContainer = name;
  activeDetailTab = tab;
  detailOpen = true;
  renderContainers();
  const c = containers.find(c => c.name === name);
  const panel = document.getElementById('container-detail');
  panel.innerHTML = `
    <header class="workspace-detail-header">
      <div class="workspace-identity">
        <div class="workspace-icon">▣</div>
        <div class="workspace-name-block">
          <div class="workspace-name-row"><h2 class="workspace-name">${esc(c.name)}</h2><span class="container-status workspace-status ${stateClass(c.state)}"><span class="status-dot"></span>${fmtState(c.state)}</span></div>
          <div class="workspace-subtitle">${esc([c.os, c.release, c.arch].filter(Boolean).join(' · ') || 'LXC 容器')}</div>
        </div>
      </div>
      <div class="workspace-actions">${detailActions(c)}</div>
    </header>
    <nav class="workspace-tabs" aria-label="容器详情标签">
      ${DETAIL_TABS.map(([id, label]) => `<button class="workspace-tab ${id === tab ? 'active' : ''}" data-tab="${id}" onclick="showDetailTab('${id}')">${label}</button>`).join('')}
    </nav>
    <div id="container-detail-body" class="workspace-detail-body"><div class="loading-state"><div class="spinner"></div><p>加载容器详情...</p></div></div>`;
  await showDetailTab(tab);
}

function toggleMoreActions() {
  const c = containers.find(c => c.name === currentContainer);
  if (!c) return;
  const name = jsEscape(c.name);
  const actions = `${c.state === 'running' ? `<button class="btn btn-sm btn-secondary" onclick="act('${name}','freeze')">冻结</button>` : ''}<button class="btn btn-sm btn-secondary" onclick="openMigrateModal('${name}')">迁移</button><button class="btn btn-sm btn-danger" onclick="delContainer('${name}')">删除容器</button>`;
  const existing = document.querySelector('.workspace-more-actions');
  if (existing) { existing.remove(); return; }
  const row = document.createElement('div');
  row.className = 'workspace-more-actions workspace-secondary-actions';
  row.innerHTML = actions;
  document.querySelector('.workspace-detail-header').after(row);
}

// 容器创建/恢复完成后轮询直到拿到 IPv4，再刷新列表显示
async function _pollContainerIp(name, attempt = 0) {
  const MAX_ATTEMPTS = 20;   // 最多 20 次
  const INTERVAL = 2000;     // 每 2 秒
  if (attempt >= MAX_ATTEMPTS) {
    // 超时了，直接刷新列表
    loadContainers();
    showDetailTab('backups');
    return;
  }
  try {
    const r = await lxc('/' + name);
    const c = r.data;
    // 找到了该容器且有 IPv4
    if (c && c.ipv4 && c.ipv4.length > 0) {
      loadContainers();
      showDetailTab('backups');
      return;
    }
  } catch(e) {}
  // 还没 IP，继续轮询
  setTimeout(() => _pollContainerIp(name, attempt + 1), INTERVAL);
}

async function showDetailTab(tab) {
  tab = DETAIL_TAB_ALIASES[tab] || tab;
  if (!currentContainer || !DETAIL_TABS.some(([id]) => id === tab)) return;
  activeDetailTab = tab;
  document.querySelectorAll('.workspace-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const body = document.getElementById('container-detail-body');
  if (!body) return;
  const requestId = ++detailRequestId;
  const containerName = currentContainer;
  const bodyStillCurrent = () => requestId === detailRequestId && currentContainer === containerName && body.isConnected;
  body.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>加载中...</p></div>';
  try {
    switch(tab) {
      case 'info': await renderDetailInfo(body, requestId, containerName); break;
      case 'settings': await renderDetailSettings(body, requestId, containerName); break;
      case 'network': await renderDetailNetwork(body, requestId, containerName); break;
      case 'data': await renderDetailData(body, requestId, containerName); break;
    }
  } catch(e) {
    if (requestId === detailRequestId) body.innerHTML = `<div class="empty-state"><p>加载失败: ${esc(e.message)}</p><button class="btn btn-sm btn-secondary" onclick="showDetailTab('${tab}')">重试</button></div>`;
  }
  if (requestId !== detailRequestId || currentContainer !== containerName) {
    // 较晚返回的请求不能覆盖用户已切换的新容器/标签
    if (currentContainer === containerName && activeDetailTab !== tab) showDetailTab(activeDetailTab);
  }
}

function propertyRow(label, value) {
  return `<div class="property-row"><span class="property-label">${label}</span><span class="property-value">${value}</span></div>`;
}

async function renderDetailInfo(body, requestId = detailRequestId, containerName = currentContainer) {
  const bodyStillCurrent = () => requestId === detailRequestId && currentContainer === containerName && body.isConnected;
  const [info, backupsResult] = await Promise.all([
    lxc(`/${encodeURIComponent(currentContainer)}/info`),
    lxc(`/${encodeURIComponent(currentContainer)}/backups`).catch(() => ({ data: [] }))
  ]);
  const c = info.data;
  const backups = backupsResult.data || [];
  const latestBackup = backups.slice().sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0];
  const name = jsEscape(currentContainer);
  if (!bodyStillCurrent()) return;
  const cpu = Number(c.cpu_usage || 0);
  const mem = Number(c.memory_used || 0), memLimit = Number(c.memory_limit || 0);
  const memPct = memLimit > 0 ? Math.min(100, mem / memLimit * 100) : 0;
  const ipv4 = (c.ipv4 || c.ip || []).filter(ip => ip !== '127.0.0.1').join(', ') || '-';
  const webui = c.webui_url ? `<a href="${escAttr(c.webui_url)}" target="_blank" rel="noopener">打开容器 Web UI ↗</a>` : '未配置';
  body.innerHTML = `
    <section class="overview-section">
      <div class="overview-section-head"><h3>运行概览</h3><span class="overview-hint">${esc(c.uptime || '容器未运行')}</span></div>
      <div class="overview-metrics">
        <div class="overview-metric"><div class="metric-label">CPU 使用率</div><div class="metric-value">${cpu.toFixed(1)}<small>%</small></div><div class="metric-track"><div class="metric-fill" style="width:${Math.min(100, cpu)}%"></div></div></div>
        <div class="overview-metric"><div class="metric-label">内存</div><div class="metric-value">${fmtBytes(mem)}<small>${memLimit ? ' / ' + fmtBytes(memLimit) : ''}</small></div><div class="metric-track"><div class="metric-fill green" style="width:${memPct}%"></div></div></div>
        <div class="overview-metric"><div class="metric-label">存储</div><div class="metric-value">${fmtDisk(c.disk_used)}</div><div class="metric-track"><div class="metric-fill green" style="width:${memPct}%"></div></div></div>
        <div class="overview-metric"><div class="metric-label">进程</div><div class="metric-value">${c.processes || 0}</div><div class="metric-label">${esc(c.state === 'running' ? '正在运行' : '当前未运行')}</div></div>
      </div>
    </section>
    <div class="overview-grid">
      <section class="overview-block">
        <div class="overview-block-head"><h3>基本信息</h3><button class="btn btn-sm btn-ghost" onclick="showDetailTab('settings')">编辑设置</button></div>
        <div class="overview-properties">
          ${propertyRow('IPv4 地址', esc(ipv4))}
          ${propertyRow('MAC 地址', `<code>${esc(c.mac || '-')}</code>`)}
          ${propertyRow('权限模式', c.privileged ? '特权容器' : '无特权容器')}
          ${propertyRow('Web 服务', webui)}
          ${propertyRow('创建时间', esc(fmtDate(c.created_at)))}
          ${propertyRow('运行时长', esc(c.uptime || '-'))}
          ${propertyRow('进程 / 快照', `${c.processes || 0} / ${c.snapshots || 0}`)}
        </div>
      </section>
      <section class="overview-block">
        <div class="overview-block-head"><h3>最近数据保护</h3><span class="overview-hint">${backups.length} 个备份 · ${c.snapshots || 0} 个快照</span></div>
        <div class="overview-properties">
          ${propertyRow('最近备份', esc(latestBackup ? fmtDate(latestBackup.created_at) : '暂无备份'))}
          ${propertyRow('备份大小', latestBackup ? fmtBytes(latestBackup.size) : '-')}
          ${propertyRow('可用快照', `${c.snapshots || 0} 个`)}
        </div>
        <div class="overview-actions"><button class="btn btn-sm btn-secondary" onclick="createSnapshot()">＋ 创建快照</button><button class="btn btn-sm btn-secondary" onclick="createBackup()">▣ 立即备份</button><button class="btn btn-sm btn-ghost" onclick="showDetailTab('data')">查看全部</button></div>
      </section>
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
  try { await lxc(`/${encodeURIComponent(currentContainer)}/description`, 'DELETE'); toast('描述已删除', 'success'); showDetailTab('info'); }
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

async function renderDetailSettings(body, requestId = detailRequestId, containerName = currentContainer) {
  const bodyStillCurrent = () => requestId === detailRequestId && currentContainer === containerName && body.isConnected;
  const r = await lxc(`/${encodeURIComponent(currentContainer)}/info`);
  const c = r.data;
  const cfgRes = await lxc(`/${encodeURIComponent(currentContainer)}/config`).catch(() => ({ data: [] }));
  const cfgLines = cfgRes.data || [];
  if (!bodyStillCurrent()) return;
  // 从原始 cgroup 配置回读真实限制值，保证输入框与配置一致
  let cpuLimit = 0, memLimit = 0;
  for (const line of cfgLines) {
    let m;
    if ((m = line.match(/^lxc\.cgroup2\.memory\.max\s*=\s*(\d+)M/))) memLimit = Number(m[1]);
    else if ((m = line.match(/^lxc\.cgroup\.memory\.limit_in_bytes\s*=\s*(\d+)/))) memLimit = Math.round(Number(m[1]) / (1024 * 1024));
    else if ((m = line.match(/^lxc\.cgroup2?\.cpuset\.cpus\s*=\s*([\d,\-]+)/)))
      cpuLimit = m[1].split(',').reduce((n, p) => n + (p.includes('-') ? Number(p.split('-')[1]) - Number(p.split('-')[0]) + 1 : 1), 0);
    else if ((m = line.match(/^lxc\.cgroup2\.cpu\.max\s*=\s*(\d+)\s+\d+/)) && Number(m[1]) > 0)
      cpuLimit = Math.max(1, Math.round(Number(m[1]) / 100000));
  }
  if (!cpuLimit) cpuLimit = c.cpu_limit || c.cpu_cores || 1;
  if (!memLimit) memLimit = c.memory_limit ? Math.round(c.memory_limit / (1024 * 1024)) : 512;
  body.innerHTML = `
    <div class="overview-section-head"><h3>容器设置</h3><span class="overview-hint">配置与资源集中管理</span></div>
    <div class="settings-grid">
      <section class="settings-card"><h3>基础配置</h3><p>容器参数与启动策略，更改即时保存。</p>
        <div class="property-row"><span class="property-label">自动启动</span><span class="property-value"><label class="toggle"><input type="checkbox" id="meta-autostart" ${c.autostart ? 'checked' : ''} onchange="saveMetaAutostart()"><span class="toggle-slider"></span></label></span></div>
        <div class="property-row"><label class="property-label" for="meta-order">启动顺序</label><span class="property-value"><input type="number" id="meta-order" class="compact-order" value="${c.container_order || 0}" min="0" onchange="saveMetaOrder()"></span></div>
        <div class="property-row"><label class="property-label" for="meta-desc">容器描述</label><span class="property-value description-value"><input type="text" id="meta-desc" value="${escAttr(c.description || '')}" placeholder="添加容器描述" onchange="saveMetaDesc()"></span></div>
        <div class="overview-actions"><button class="btn btn-sm btn-secondary" onclick="toggleRawConfig()">查看原始配置</button><button class="btn btn-sm btn-secondary" onclick="cloneContainer('${jsEscape(currentContainer)}')">⧉ 克隆</button></div>
        <div id="raw-config" hidden><div class="loading-state"><div class="spinner"></div></div></div>
      </section>
      <section class="settings-card"><h3>资源限制</h3><p>修改后重启容器生效。</p>
        <div class="resource-field"><label for="limits-cpu">CPU 核心数</label><div class="number-input"><input type="number" id="limits-cpu" min="1" max="16" step="1" value="${cpuLimit}"><span>核</span></div><div class="range-hint">可设置 1–16 核</div></div>
        <div class="resource-field"><label for="limits-mem">内存上限</label><div class="number-input"><input type="number" id="limits-mem" min="64" max="16384" step="1" value="${memLimit}"><span>MB</span></div><div class="range-hint">可设置 64–16384 MB</div></div>
        <div class="overview-actions"><button class="btn btn-sm btn-primary" onclick="saveLimits()">保存限制</button></div>
      </section>
    </div>`;
}

async function toggleRawConfig() {
  const panel = document.getElementById('raw-config');
  if (!panel) return;
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.hidden = false;
  try { await renderDetailConfig(panel); }
  catch (e) { panel.innerHTML = `<div class="empty-state"><p>${esc(e.message)}</p></div>`; }
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

async function renderDetailData(body, requestId = detailRequestId, containerName = currentContainer) {
  const bodyStillCurrent = () => requestId === detailRequestId && currentContainer === containerName && body.isConnected;
  const [snapshotsResult, backupsResult] = await Promise.all([
    lxc(`/${encodeURIComponent(currentContainer)}/snapshots`),
    lxc(`/${encodeURIComponent(currentContainer)}/backups`)
  ]);
  const snaps = snapshotsResult.data || [];
  const backups = backupsResult.data || [];
  const records = [
    ...snaps.map(s => ({ type: 'snapshot', name: s.name, created: s.created_at, size: 0 })),
    ...backups.map(b => ({ type: 'backup', name: b.filename, created: b.created_at, size: b.size }))
  ].sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
  if (!bodyStillCurrent()) return;
  body.innerHTML = `
    <div class="overview-section-head"><h3>数据保护</h3><div class="overview-actions"><button class="btn btn-sm btn-secondary" onclick="createSnapshot()">创建快照</button><button class="btn btn-sm btn-primary" onclick="createBackup()">立即备份</button></div></div>
    ${records.length === 0 ? '<div class="workspace-empty"><p>暂无快照或备份</p></div>' : `<div class="data-records">${records.map(item => `
      <div class="data-record"><span class="data-type">${item.type === 'snapshot' ? '快照' : '备份'}</span><div class="data-record-main"><strong>${esc(item.name)}</strong><span>${esc(item.created ? fmtDate(item.created) : '时间未知')}${item.type === 'backup' ? ' · ' + fmtBytes(item.size) : ''}</span></div><div class="data-record-actions">${item.type === 'snapshot'
        ? `<button class="btn btn-sm btn-success" onclick="restoreSnapshot('${jsEscape(item.name)}')">恢复</button><button class="btn btn-sm btn-danger" onclick="deleteSnapshot('${jsEscape(item.name)}')">删除</button><button class="btn btn-sm btn-secondary" onclick="cloneFromSnapshot('${jsEscape(item.name)}')">克隆</button>`
        : `<button class="btn btn-sm btn-success" onclick="restoreBackup('${jsEscape(item.name)}')">恢复</button><button class="btn btn-sm btn-danger" onclick="deleteBackup('${jsEscape(item.name)}')">删除</button>`}</div></div>`).join('')}</div>`}`;
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
            <button class="btn btn-sm btn-success" onclick="restoreSnapshot('${jsEscape(s.name)}')">恢复</button>
            <button class="btn btn-sm btn-danger" onclick="deleteSnapshot('${jsEscape(s.name)}')">删除</button>
            <button class="btn btn-sm btn-secondary" onclick="cloneFromSnapshot('${jsEscape(s.name)}')">克隆</button>
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
            <button class="btn btn-sm btn-success" onclick="restoreBackup('${jsEscape(b.filename)}')">恢复</button>
            <button class="btn btn-sm btn-danger" onclick="deleteBackup('${jsEscape(b.filename)}')">删除</button>
          </div>
        </div>`).join('')}
    </div>`;
}

// ═══════════ NETWORK ═══════════
async function renderDetailNetwork(body, requestId = detailRequestId, containerName = currentContainer) {
  const isCurrent = () => requestId === detailRequestId && currentContainer === containerName && body.isConnected;
  const info = await lxc('/' + encodeURIComponent(currentContainer) + '/info');
  const c = info.data;
  if (!isCurrent()) return;
  const config = await lxc('/' + encodeURIComponent(currentContainer) + '/config').catch(e => ({ locked: true, message: e.message }));
  const cfgLines = config.data || [];
  if (!isCurrent()) return;

  let netType = 'veth', netLink = 'lxcbr0', netHwaddr = '', netFlags = 'up';
  for (const line of cfgLines) {
    if (line.startsWith('lxc.net.0.type =')) netType = line.split('=')[1].trim();
    if (line.startsWith('lxc.net.0.link =')) netLink = line.split('=')[1].trim();
    if (line.startsWith('lxc.net.0.hwaddr =')) netHwaddr = line.split('=')[1].trim();
    if (line.startsWith('lxc.net.0.flags =')) netFlags = line.split('=')[1].trim();
  }

  body.innerHTML =
    '<div class="detail-section">' +
      '<h4>网络连接</h4>' +
      '<div class="info-card">' +
        '<table class="info-table">' +
          '<tr><td>容器 IP</td><td><code>' + esc((c.ipv4 || c.ip || []).join(', ') || '-') + '</code></td></tr>' +
          '<tr><td>IPv6 地址</td><td><code>' + esc((c.ipv6 || []).join(', ') || '未分配') + '</code></td></tr>' +
          (config.locked ? '<tr><td>网络配置</td><td>' + esc(config.message) + '</td></tr>' : '') +
          '<tr><td>当前模式</td><td><code>' + esc(netType) + '</code></td></tr>' +
          '<tr><td>桥接/链路</td><td><code>' + esc(netLink) + '</code></td></tr>' +
          '<tr><td>MAC 地址</td><td>' + (netHwaddr ? '<code>' + esc(netHwaddr) + '</code>' : '-') + '</td></tr>' +
          '<tr><td>容器 IP</td><td><code>' + esc((c.ipv4 || c.ip || []).join(', ') || '-') + '</code></td></tr>' +
        '</table>' +
      '</div>' +
    '</div>' +
    (config.locked ? '' : '<div class="detail-section">' +
      '<h4>切换网络模式</h4>' +
      '<div class="info-card">' +
        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">' +
          '<div style="flex:1;min-width:180px;">' +
            '<label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:6px;">目标网络模式</label>' +
            '<select id="nw-mode-select" style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:14px;">' +
              '<option value="bridge"' + (netType === 'veth' && netLink !== 'lxcbr0' ? ' selected' : '') + '>桥接 — 与宿主同网段（LXC 原生 OVS）</option>' +
              '<option value="nat"' + (netType === 'veth' && netLink === 'lxcbr0' ? ' selected' : '') + '>NAT (lxcbr0) — 10.0.3.x 子网</option>' +
            '</select>' +
          '</div>' +
          '<div style="padding-top:20px;">' +
            '<button id="nw-apply-btn" class="btn btn-sm btn-primary" onclick="applyNetworkMode(\'' + jsEscape(currentContainer) + '\')">应用</button>' +
          '</div>' +
        '</div>' +
        '<p class="info-text" style="margin-top:10px;font-size:12px;color:var(--text-dim);">' +
          '切换后需重启容器生效。桥接模式由路由器直接分配 IPv4/IPv6（与宿主机同网段）。' +
        '</p>' +
      '</div>' +
    '</div>');
}

async function applyNetworkMode(name) {
  const sel = document.getElementById('nw-mode-select');
  const mode = sel ? sel.value : 'lxcbr0';
  const btn = document.getElementById('nw-apply-btn');
  if (btn) { btn.disabled = true; btn.textContent = '应用中...'; }
  try {
    await setNetworkMode(name, mode);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '应用'; }
  }
}

async function setNetworkMode(name, mode) {
  try {
    if (mode === 'nat') {
      await lxc('/' + encodeURIComponent(name) + '/config', 'PUT', { updates: {
        'lxc.net.0.type': 'veth',
        'lxc.net.0.link': 'lxcbr0',
        'lxc.net.0.flags': 'up',
      }});
    } else {
      // bridge：优先 OVS 桥（LXC 原生识别并自动 add-port），否则物理网卡
      const ifaces = await sys('/interfaces');
      const all = ifaces.data || [];
      const ovsBridge = all.find(i => i.is_ovs);
      const physical = all.find(i =>
        !i.is_ovs &&
        !i.name.startsWith('lo') &&
        !i.name.startsWith('virbr') &&
        !i.name.startsWith('lxcbr') &&
        !i.name.startsWith('docker') &&
        !i.name.startsWith('veth') &&
        i.type === 'eth'
      );
      const hostIface = ovsBridge ? ovsBridge.name : (physical ? physical.name : 'enp4s0');
      await lxc('/' + encodeURIComponent(name) + '/config', 'PUT', { updates: {
        'lxc.net.0.type': 'veth',
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

// ── Resource Limits ──
async function renderDetailLimits(body) {
  const r = await lxc(`/${encodeURIComponent(currentContainer)}/info`);
  const c = r.data;
  const cpuLimit = c.cpu_limit || c.cpu_cores || 1;
  const memLimit = c.memory_limit ? Math.round(c.memory_limit / (1024*1024)) : 512;
  body.innerHTML = `
    <div class="detail-section">
      <h4>资源限制</h4>
      <p class="info-text">调整 CPU 核心数和内存上限。修改后需重启容器才能生效。</p>
      <div class="limits-form">
        <div class="form-group">
          <label>CPU 核心数: <strong id="limits-cpu-val">${cpuLimit}</strong></label>
          <input type="range" id="limits-cpu" min="1" max="16" step="1" value="${cpuLimit}"
            oninput="document.getElementById('limits-cpu-val').textContent=this.value">
          <div class="range-labels"><span>1</span><span>16</span></div>
        </div>
        <div class="form-group">
          <label>内存上限: <strong id="limits-mem-val">${memLimit}</strong> MB</label>
          <input type="range" id="limits-mem" min="64" max="16384" step="64" value="${memLimit}"
            oninput="document.getElementById('limits-mem-val').textContent=this.value">
          <div class="range-labels"><span>64 MB</span><span>16384 MB</span></div>
        </div>
        <div style="margin-top:20px;display:flex;gap:10px;">
          <button class="btn btn-primary" onclick="saveLimits()">💾 保存限制</button>
          <button class="btn btn-secondary" onclick="showDetailTab('info')">取消</button>
        </div>
      </div>
    </div>`;
}

async function saveLimits() {
  const cpu = Number(document.getElementById('limits-cpu').value);
  const memMB = Number(document.getElementById('limits-mem').value);
  if (!Number.isInteger(cpu) || cpu < 1 || cpu > 16 || !Number.isInteger(memMB) || memMB < 64 || memMB > 16384) {
    toast('请输入有效的 CPU 核数（1–16）和内存（64–16384 MB）', 'error');
    return;
  }
  const memBytes = memMB * 1024 * 1024;
  try {
    await lxc(`/${encodeURIComponent(currentContainer)}/limits`, 'PUT', { cpu: String(cpu), memory: String(memMB) });
    toast('资源限制已更新，请重启容器生效', 'success');
    showDetailTab('info');
  } catch(e) {
    toast('保存失败: ' + e.message, 'error');
  }
}

// ═══════════ BACKUP PROGRESS ═══════════
let backupPollTimer = null;
function showBackupProgressModal(name) {
  // 动态创建进度模态框
  let modal = document.getElementById('backup-progress-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'backup-progress-modal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width:480px">
        <div class="modal-header">
          <h3>💾 备份中...</h3>
        </div>
        <div class="modal-body">
          <div class="backup-progress-info">
            <div class="progress-label">
              <span id="bprog-status">正在备份</span>
              <span id="bprog-pct">0%</span>
            </div>
            <div class="progress-bar-container">
              <div id="bprog-bar" class="progress-bar" style="width:0%"></div>
            </div>
            <div class="progress-details">
              <span id="bprog-size">0 MB</span>
              <span id="bprog-elapsed">0s</span>
            </div>
            <div class="progress-details secondary">
              <span id="bprog-msg">正在准备...</span>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeBackupProgress()">后台运行</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }
  modal.dataset.name = name;
  modal.classList.add('active');
  startBackupPoll(name);
}
function closeBackupProgress() {
  const modal = document.getElementById('backup-progress-modal');
  if (modal) modal.classList.remove('active');
  if (backupPollTimer) { clearTimeout(backupPollTimer); backupPollTimer = null; }
}
function startBackupPoll(name) {
  const poll = () => {
    lxc('/' + encodeURIComponent(name) + '/backup/progress').then(r => {
      const d = r.data || {};
      const bar = document.getElementById('bprog-bar');
      const pctEl = document.getElementById('bprog-pct');
      const sizeEl = document.getElementById('bprog-size');
      const elapsedEl = document.getElementById('bprog-elapsed');
      const msgEl = document.getElementById('bprog-msg');
      const statusEl = document.getElementById('bprog-status');

      if (d.status === 'done') {
        const size = d.size || d.current_size || 0;
        sizeEl.textContent = fmtBytes(size);
        elapsedEl.textContent = d.elapsed + 's';
        bar.style.width = '100%';
        pctEl.textContent = '100%';
        statusEl.textContent = '✅ 备份完成';
        msgEl.textContent = '文件: ' + (d.output_file || '').split('/').pop();
        closeBackupProgress();
        toast('备份完成 (' + fmtBytes(size) + ')', 'success');
        loadBackupList();   // 刷新从备份恢复列表
        showDetailTab('backups');
        return;
      }
      if (d.status === 'error') {
        statusEl.textContent = '❌ 备份失败';
        msgEl.textContent = d.error || '未知错误';
        bar.style.width = '0%';
        pctEl.textContent = '失败';
        closeBackupProgress();
        toast('备份失败: ' + (d.error || '未知错误'), 'error');
        showDetailTab('backups');
        return;
      }
      // running
      const cur = d.current_size || 0;
      const total = d.total_size || 1;
      const pct = Math.min(95, Math.round((cur / total) * 100));
      bar.style.width = Math.max(2, pct) + '%';
      pctEl.textContent = pct + '%';
      sizeEl.textContent = fmtBytes(cur) + ' / ' + fmtBytes(total);
      elapsedEl.textContent = d.elapsed + 's';
      if (cur > 0) {
        msgEl.textContent = '已压缩 ' + fmtBytes(cur);
      } else if (d.rootfs_size > 0) {
        msgEl.textContent = '正在压缩 (原始: ' + fmtBytes(d.rootfs_size) + ')';
      } else {
        msgEl.textContent = '正在准备...';
      }
      statusEl.textContent = '⏳ 备份中';
      backupPollTimer = setTimeout(poll, 2000);
    }).catch(() => {
      backupPollTimer = setTimeout(poll, 2000);
    });
  };
  backupPollTimer = setTimeout(poll, 1500);
}

async function cloneContainer(name) {
  switchTab('create');
  await switchCreateTab('clone');
  document.getElementById('clone-source').value = name;
  document.getElementById('clone-name').value = name + '-clone';
}

async function createBackup() {
  const name = currentContainer;
  if (!name) { toast('请先选择容器', 'warning'); return; }
  showBackupProgressModal(name);
  try {
    await lxc('/' + encodeURIComponent(name) + '/backup', 'POST');
  } catch(e) {
    closeBackupProgress();
    toast('备份启动失败: ' + e.message, 'error');
  }
}

let restorePollTimer = null;
let restoreFailCount = 0;

function showRestoreProgressModal(file, newname, mode) {
  if (restorePollTimer) { clearTimeout(restorePollTimer); restorePollTimer = null; }
  restoreFailCount = 0;
  let modal = document.getElementById('backup-progress-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'backup-progress-modal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width:480px">
        <div class="modal-header">
          <h3 id="bprog-title">💾 恢复中...</h3>
        </div>
        <div class="modal-body">
          <div class="backup-progress-info">
            <div class="progress-label">
              <span id="bprog-status">准备中...</span>
              <span id="bprog-pct">—</span>
            </div>
            <div class="progress-bar-container">
              <div id="bprog-bar" class="progress-bar" style="width:0%"></div>
            </div>
            <div class="progress-details">
              <span id="bprog-size">—</span>
              <span id="bprog-elapsed"></span>
            </div>
            <div class="progress-details secondary">
              <span id="bprog-msg"></span>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeRestoreProgress()">后台运行</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }
  const titleEl = document.getElementById('bprog-title');
  if (titleEl) {
    titleEl.textContent = mode === 'create'
      ? `💾 从 ${esc(file)} 创建容器...`
      : `💾 从 ${esc(file)} 恢复中...`;
  }
  modal.dataset.name = newname;
  modal.dataset.file = file;
  modal.dataset.mode = mode;
  modal.classList.add('active');
  startRestorePoll(newname, file, mode);
}

function closeRestoreProgress() {
  const modal = document.getElementById('backup-progress-modal');
  if (modal) modal.classList.remove('active');
  if (restorePollTimer) { clearTimeout(restorePollTimer); restorePollTimer = null; }
}

function startRestorePoll(newname, file, mode) {
  const url = mode === 'create'
    ? '/create/' + encodeURIComponent(newname) + '/progress'
    : '/' + encodeURIComponent(currentContainer) + '/restore/' + encodeURIComponent(newname) + '/progress';

  const poll = () => {
    lxc(url).then(r => {
      restoreFailCount = 0;
      const d = r.data || {};
      console.log('[进度调试]', mode, newname, url, r);
      const bar = document.getElementById('bprog-bar');
      const pctEl = document.getElementById('bprog-pct');
      const sizeEl = document.getElementById('bprog-size');
      const msgEl = document.getElementById('bprog-msg');
      const statusEl = document.getElementById('bprog-status');

      if (d.status === 'done') {
        if (sizeEl) sizeEl.textContent = fmtBytes(d.total_size || 0);
        if (bar) { bar.style.width = '100%'; bar.style.background = '#52c41a'; }
        if (pctEl) pctEl.textContent = '100%';
        if (statusEl) statusEl.textContent = '✅ 完成';
        if (msgEl) msgEl.textContent = mode === 'create' ? '容器已创建' : '恢复完成';
        toast((mode === 'create' ? '容器 ' : '恢复 ') + newname + ' 完成', 'success');
        closeRestoreProgress();
        // 等容器完全启动 DHCP 拿到 IP，持续轮询直到拿到 IPv4
        _pollContainerIp(newname);
        return;
      }
      if (d.status === 'error') {
        if (statusEl) statusEl.textContent = '❌ ' + (d.msg || '操作失败');
        if (msgEl) msgEl.textContent = d.msg || '';
        if (bar) { bar.style.width = '0%'; bar.style.background = '#ff4d4f'; }
        if (pctEl) pctEl.textContent = '失败';
        toast((mode === 'create' ? '创建' : '恢复') + '失败: ' + (d.msg || ''), 'error');
        closeRestoreProgress();
        return;
      }
      // running (pct=-1 表示 indeterminate spinner)
      if (d.pct === -1 || d.pct == null) {
        if (bar) { bar.style.width = '100%'; bar.style.opacity = '0.3'; bar.style.background = '#1890ff'; }
        if (pctEl) pctEl.textContent = '—';
        if (statusEl) statusEl.textContent = '⏳ ' + (d.msg || '处理中...');
        if (msgEl) msgEl.textContent = '请稍候';
      } else {
        if (bar) { bar.style.width = Math.max(2, d.pct) + '%'; bar.style.opacity = '1'; bar.style.background = '#1890ff'; }
        if (pctEl) pctEl.textContent = d.pct + '%';
        if (statusEl) statusEl.textContent = '⏳ ' + (d.msg || '处理中...');
        if (msgEl) msgEl.textContent = d.msg || '';
      }
      restorePollTimer = setTimeout(poll, 2000);
    }).catch(e => {
      // 后端任务完成后删除文件，轮询返回 success:false 被 api() 抛出
      // HTTP 404 或错误消息含"没有进行中"都视为任务已完成
      if ((e && e.status === 404) || (e && String(e.message || '').includes('没有进行中'))) {
        const statusEl = document.getElementById('bprog-status');
        const msgEl = document.getElementById('bprog-msg');
        if (statusEl) statusEl.textContent = '✅ 完成';
        if (msgEl) msgEl.textContent = mode === 'create' ? '容器已创建' : '恢复完成';
        toast((mode === 'create' ? '容器 ' : '恢复 ') + newname + ' 完成', 'success');
        closeRestoreProgress();
        loadContainers();
        return;
      }
      restoreFailCount++;
      if (restoreFailCount >= 10) {
        const statusEl = document.getElementById('bprog-status');
        const msgEl = document.getElementById('bprog-msg');
        if (statusEl) statusEl.textContent = '⚠ 任务已过期';
        if (msgEl) msgEl.textContent = '任务已完成或已失效';
        if (bar) bar.style.width = '0%';
        if (pctEl) pctEl.textContent = '—';
        closeRestoreProgress();
        return;
      }
      restorePollTimer = setTimeout(poll, 2000);
    });
  };
  restorePollTimer = setTimeout(poll, 1000);
}

async function restoreBackup(file) {
  promptInput('从备份恢复', `从 ${esc(file)} 恢复到哪个容器名？`, currentContainer + '-restored', async (newname) => {
    if (!newname) { toast('请输入容器名', 'warning'); return; }
    showRestoreProgressModal(file, newname, 'restore');
    try {
      await lxc('/' + encodeURIComponent(currentContainer) + '/backup/' + encodeURIComponent(file) + '/restore', 'POST', { newname });
      // 轮询由 showRestoreProgressModal 启动，后端返回 202 后才开始
    } catch(e) {
      closeRestoreProgress();
      toast('恢复失败: ' + e.message, 'error');
    }
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
  // 详情不再使用弹窗，保留此函数兼容现有操作流程。
}

// ═══════════ CREATE CONTAINER ═══════════
async function switchCreateTab(tab) {
  activeCreateTab = tab;
  document.querySelectorAll('.create-tab').forEach(b => b.classList.toggle('active', b.dataset.createTab === tab));
  document.querySelectorAll('.create-section').forEach(s => s.classList.toggle('active', s.id === `create-${tab}`));
  if (tab === 'clone') await refreshCloneSelects();
  else if (tab === 'snapshot') await refreshSnapshotSelects();
  else if (tab === 'backup') await refreshBackupSelects();
  else if (tab === 'template') await refreshTemplateSelect();
  else if (tab === 'local') await refreshLocalTemplateSelect();
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
    // 默认选择 sshd（fnOS 上最可靠的模板）
    const sshdOpt = [...sel.options].find(o => o.value === 'sshd');
    if (sshdOpt) sshdOpt.selected = true;
    document.getElementById('ct-release').innerHTML = '<option value="">— 先选发行版 —</option>';
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
  await loadBackupList();
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
  const sel = document.getElementById('backup-select');
  const info = document.getElementById('backup-info');
  try {
    const r = await sys('/backups');
    const backups = r.data || [];
    if (backups.length === 0) {
      sel.innerHTML = '<option value="">无备份文件</option>';
      info.textContent = '';
      return;
    }
    sel.innerHTML = backups.map(b => {
      const label = `${b.filename} (${fmtBytes(b.size)}) — 来自 ${b.container}`;
      return `<option value="${esc(b.filename)}" data-container="${esc(b.container)}">${esc(label)}</option>`;
    }).join('');
    // 自动填入建议的恢复名（从第一个备份解析）
    if (backups.length > 0) {
      const first = backups[0];
      const suggested = first.container + '-restored';
      document.getElementById('backup-new-name').value = suggested;
      info.textContent = `来自容器: ${first.container} | 时间: ${first.created_at}`;
    }
  } catch(e) {
    sel.innerHTML = '<option value="">加载失败</option>';
    info.textContent = '';
  }
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
    network_type: document.getElementById('ct-network_type').value,
    ipv4_address: (document.getElementById('ct-ipv4')?.value || '').trim(),
    ipv4_gateway: (document.getElementById('ct-gateway')?.value || '').trim(),
    ipv6_address: (document.getElementById('ct-ipv6')?.value || '').trim(),
    ipv6_gateway: (document.getElementById('ct-ipv6_gw')?.value || '').trim(),
  };
  if (!data.name) { toast('请输入容器名称', 'warning'); return; }
  if (!data.template) { toast('请选择模板', 'warning'); return; }
  toast('正在创建容器...', 'info');
  try {
    await lxc('/create', 'POST', data);
    toast(`容器 ${data.name} 创建成功`, 'success');
    switchTab('containers');
    pollContainerIP(data.name);
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
    await lxc('/create/copy', 'POST', { name, source, network_type: document.getElementById('clone-network_type').value });
    toast(`容器 ${source} 已克隆为 ${name}`, 'success');
    switchTab('containers');
    pollContainerIP(name);
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
    await lxc('/create/from-snapshot', 'POST', { name, source, snapshot, network_type: document.getElementById('snap-network_type').value });
    toast(`已从 ${source}/${snapshot} 创建 ${name}`, 'success');
    switchTab('containers');
    pollContainerIP(name);
  } catch(e) { toast('创建失败: ' + e.message, 'error'); }
}

async function handleCreateFromBackup(e) {
  e.preventDefault();
  const backup_name = document.getElementById('backup-select').value;
  const name = document.getElementById('backup-new-name').value.trim();
  if (!backup_name || !name) { toast('请选择备份并填写新容器名', 'warning'); return; }
  if (!/^[a-zA-Z0-9][-a-zA-Z0-9_.]*$/.test(name)) { toast('容器名称只能包含字母、数字、点、减号、下划线，且以字母或数字开头', 'warning'); return; }
  showRestoreProgressModal(backup_name, name, 'create');
  try {
    await lxc('/create/from-backup', 'POST', { name, backup_name, network_type: document.getElementById('backup-network_type').value });
    // 轮询由 showRestoreProgressModal 启动，后端返回 202 后才开始
  } catch(e) {
    closeRestoreProgress();
    toast('创建失败: ' + e.message, 'error');
  }
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
        <button class="btn btn-sm btn-primary" onclick="openVersionsModal('${jsEscape(distro)}')">📋 版本</button>
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
            ? `<button class="btn btn-sm btn-success" onclick="createFromVersion('${jsEscape(distro)}','${jsEscape(v.release)}','${jsEscape(v.arch)}','${jsEscape(variant)}')">▶ 创建容器</button>`
            : `<button class="btn btn-sm btn-primary" onclick="downloadVersion('${jsEscape(distro)}','${jsEscape(v.release)}','${jsEscape(v.arch)}','${jsEscape(variant)}')">⬇ 下载</button>`
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
  // lxc-download 创建已废弃，跳转到本地模板 tab 并提示用户
  switchCreateTab('local');
  toast(`已选择发行版: ${distro}/${release} (${arch})，请使用本地模板或工具栏创建`, 'info');
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

function selectTemplate(name) {
  switchTab('create');
  switchCreateTab('local');
  const sel = document.getElementById('ct-template');
  if ([...sel.options].some(o => o.value === name)) sel.value = name;
  toast(`已选择模板: ${name}`, 'info');
}

// ═══════════ SETTINGS ═══════════
async function loadSettings() {
  document.getElementById('settings-loading').style.display = 'block';
  document.getElementById('settings-form').style.display = 'none';
  try {
    // 分别请求各接口，避免单个接口失败阻塞整个设置页加载
    let s = {}, ifacesData = [], zfsPoolsData = [];
    try { const r = await sys('/settings'); s = r.data || {}; } catch(e) { console.warn('加载设置失败:', e); }
    try { const r = await sys('/interfaces'); ifacesData = r.data || []; } catch(e) { console.warn('加载网卡列表失败:', e); }
    try { const r = await sys('/zfs/pools'); zfsPoolsData = r.data || []; } catch(e) { console.warn('加载存储卷列表失败:', e); }

    document.getElementById('stg-path').value = s.lxc_path || s.default_path || '';
    document.getElementById('stg-lxc-mirror').value = s.lxc_mirror || 'https://images.linuxcontainers.org';
    document.getElementById('stg-backup-path').value = s.backup_path || '';
    document.getElementById('stg-cache').value = s.cache_dir || '';
    document.getElementById('stg-backup-keep').value = s.backup_keep || 7;
    document.getElementById('stg-backup-compression').value = s.backup_compression || 6;
    document.getElementById('stg-backup-threads').value = s.backup_threads || 4;
    document.getElementById('stg-backup-snapshot').checked = s.backup_use_snapshot === 'true';
    // 存储卷下拉
    updateZfsPoolUI('zfs', s.zfs_pool, zfsPoolsData);
    // 记住当前 pool，用于检测用户是否手动改过路径
    window._prevZfsPool = s.zfs_pool;
    window._zfsPoolsCache = zfsPoolsData;
    document.getElementById('settings-loading').style.display = 'none';
    document.getElementById('settings-form').style.display = 'block';
  } catch(e) {
    document.getElementById('settings-loading').innerHTML = `<p>加载设置失败: ${esc(e.message)}</p>`;
  }
}

function updateZfsPoolUI(backendType, currentPool, pools) {
  const sel = document.getElementById('stg-zfs-pool');
  if (backendType === 'zfs' || backendType === 'btrfs') {
    sel.innerHTML = pools.map(p =>
      `<option value="${esc(p.name)}" data-mp="${esc(p.mountpoint || '/')}"${p.name === currentPool ? ' selected' : ''}>${esc(p.mountpoint)} (${esc(p.name)}, ${esc(p.size)})</option>`
    ).join('');
    if (sel.options.length === 0) sel.innerHTML = '<option value="">未检测到 btrfs 卷</option>';
  } else {
    sel.innerHTML = '<option value="">不使用 btrfs 子卷（纯目录，无快照）</option>';
  }
}

// 当用户切换存储卷时，自动填充容器路径
document.getElementById('stg-zfs-pool').addEventListener('change', function() {
  const sel = this;
  const opts = sel.options;
  const selected = opts[sel.selectedIndex];
  if (!selected || !selected.value) return;
  const mp = selected.getAttribute('data-mp') || '/';
  // 自动填充三个路径（仅当字段为空或与上一个 pool 的推导值一致时）
  const prev = window._prevZfsPool;
  const prevSel = Array.from(opts).find(o => o.value === prev);
  const prevMp = prevSel ? (prevSel.getAttribute('data-mp') || '/') : null;
  const pathInput = document.getElementById('stg-path');
  const bakInput = document.getElementById('stg-backup-path');
  const cacheInput = document.getElementById('stg-cache');
  // 只有用户未手动修改过，才自动填充
  if (!prevMp || prev === '' || pathInput.value === '' ||
      pathInput.value.startsWith(prevMp + '/')) {
    pathInput.value = mp + '/1000/lxc';
  }
  if (!prevMp || bakInput.value === '' ||
      bakInput.value.startsWith(prevMp + '/')) {
    bakInput.value = mp + '/1000/lxc/bak';
  }
  if (!prevMp || cacheInput.value === '' ||
      cacheInput.value.startsWith(prevMp + '/')) {
    cacheInput.value = mp + '/1000/lxc/template';
  }
  window._prevZfsPool = sel.value;
});

async function handleSaveSettings(e) {
  e.preventDefault();
  const data = {
    lxc_path: document.getElementById('stg-path').value,
    cache_dir: document.getElementById('stg-cache').value,
    zfs_pool: document.getElementById('stg-zfs-pool').value,
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
    loadSettings();
  } catch(e) { toast('保存失败: ' + e.message, 'error'); }
}

function factoryReset() {
  confirm('确定要恢复出厂设置吗？此操作将删除所有配置，刷新后进入首次运行向导。', async () => {
    try {
      await sys('/settings', 'DELETE');
      toast('已恢复出厂设置，即将重新加载...', 'success');
      // 用 pathname 跳转避免浏览器缓存直接走 cache
      setTimeout(() => { window.location.href = window.location.pathname; }, 1500);
    } catch(e) { toast('重置失败: ' + e.message, 'error'); }
  });
}

// ═══════════ SETUP WIZARD ═══════════
function showSetupWizard() {
  const wizard = document.getElementById('setup-wizard');
  if (!wizard) return;
  wizard.querySelector('#wiz-path').value = '';
  wizard.querySelector('#wiz-backup-path').value = '';
  wizard.querySelector('#wiz-cache').value = '';
  wizard.querySelector('#wiz-lxc-mirror').value = 'https://mirrors.tuna.tsinghua.edu.cn/lxc-images';
  loadWizardPools();
  wizard.classList.add('active');
}

async function loadWizardPools() {
  try {
    const r = await sys('/zfs/pools');
    const pools = r.data || [];
    const sel = document.getElementById('wiz-zfs-pool');
    if (!sel) return;
    sel.innerHTML = pools.map(p =>
      `<option value="${esc(p.name)}" data-mp="${esc(p.mountpoint || '/')}">${esc(p.mountpoint)} (${esc(p.name)}, ${esc(p.size)})</option>`
    ).join('');
    if (sel.options.length === 0) {
      sel.innerHTML = '<option value="">未检测到 btrfs 卷</option>';
    } else if (sel.options.length === 1) {
      // Auto-select the only pool
      sel.selectedIndex = 0;
      handleWizardPoolChange();
    }
  } catch(e) {
    const sel = document.getElementById('wiz-zfs-pool');
    if (sel) sel.innerHTML = '<option value="">加载失败</option>';
  }
}

function handleWizardPoolChange() {
  const sel = document.getElementById('wiz-zfs-pool');
  if (!sel?.value) return;
  const mp = sel.options[sel.selectedIndex]?.getAttribute('data-mp') || '/';
  document.getElementById('wiz-path').value = mp + '/1000/lxc';
  document.getElementById('wiz-backup-path').value = mp + '/1000/lxc/bak';
  document.getElementById('wiz-cache').value = mp + '/1000/lxc/template';
}

async function handleSaveWizardSettings(e) {
  e.preventDefault();
  const btn = document.getElementById('wiz-save-btn');
  btn.disabled = true;
  btn.textContent = '保存中...';
  const data = {
    lxc_path: document.getElementById('wiz-path').value,
    cache_dir: document.getElementById('wiz-cache').value,
    zfs_pool: document.getElementById('wiz-zfs-pool').value,
    lxc_mirror: document.getElementById('wiz-lxc-mirror').value,
    backup_path: document.getElementById('wiz-backup-path').value,
    backup_keep: '7',
    backup_compression: '6',
    backup_threads: '4',
    backup_use_snapshot: 'false',
  };
  try {
    await sys('/settings', 'PUT', data);
    toast('设置已保存', 'success');
    // Close wizard
    document.getElementById('setup-wizard').classList.remove('active');
    // Now load the actual dashboard and start auto-refresh
    loadDashboard();
    setupRefreshTriggers();
  } catch(e) {
    toast('保存失败: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = '保存并开始使用';
  }
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
    else if (id === 'tab-logs') loadLogs();
  }
  toast('已刷新', 'success');
}

// ═══════════ Proxmox Template Functions ═══════════
function showProxmoxTemplates() {
  if (proxmoxLoaded && proxmoxData) {
    document.getElementById('proxmox-loading').style.display = 'none';
    renderProxmoxGrid(proxmoxData);
    return;
  }
  loadProxmoxTemplates();
}

async function loadProxmoxTemplates() {
  const grid = document.getElementById('proxmox-grid');
  const loading = document.getElementById('proxmox-loading');
  if (!grid) return;
  proxmoxLoaded = false;
  proxmoxData = null;
  loading.style.display = '';
  grid.innerHTML = '';
  try {
    const r = await sys('/templates/proxmox');
    const tpls = r.data || [];
    loading.style.display = 'none';
    proxmoxLoaded = true;
    proxmoxData = tpls;
    renderProxmoxGrid(tpls);
  } catch(e) {
    loading.style.display = 'none';
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
          ? `<button class="btn btn-sm btn-primary" onclick="createFromProxmox('${jsEscape(t.tar_file)}')">📦 创建容器</button>`
          : `<button class="btn btn-sm btn-primary" onclick="downloadProxmoxTemplate('${jsEscape(t.tar_url)}','${jsEscape(t.tar_file)}')">⬇ 下载</button>`}
      </div>
    </div>`;
  }).join('');
}

async function downloadProxmoxTemplate(url, file) {
  toast('开始下载...', 'info');
  try {
    await sys('/templates/proxmox/download', 'POST', { url, file });
    toast('下载完成', 'success');
    proxmoxLoaded = false; proxmoxData = null;
    cacheLoaded = false; cacheData = null;
    loadProxmoxTemplates();
    loadCachedTemplates();
  } catch(e) { toast('下载失败: ' + e.message, 'error'); }
}

// ── Cached Templates ──
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
    const r = await sys('/templates/cached');
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
  list.innerHTML = items.map(i => {
    const base = (i.file || '').replace(/\.tar\.(gz|xz|zst)$/i, '');
    return `<div class="template-card">
      <div class="template-name" title="${esc(i.file)}">${esc(base)}</div>
      <div class="template-info">${esc(i.arch || '')} | ${fmtBytes(i.size)}</div>
      <div class="template-info" style="font-size:12px;color:var(--text-dim)">${esc(i.file)}</div>
      <div class="template-actions">
        <button class="btn btn-sm btn-primary" onclick="createFromProxmox('${jsEscape(i.file)}')">📦 创建容器</button>
      </div>
    </div>`;
  }).join('');
}

async function createFromProxmox(file) {
  switchTab('create');
  switchCreateTab('local');
  try {
    const r = await sys('/templates/cached');
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
    const r = await sys('/templates/cached');
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
  const g = id => document.getElementById(id);
  const val = id => (g(id)?.value || '').trim();
  const num = id => { const v = val(id); return v === '' ? null : Number(v); };

  const name = val('cl-name');
  const tmpl = val('cl-template');
  const autostart = g('cl-autostart').checked;
  if (!name) { toast('请输入容器名称', 'warning'); return; }
  if (!tmpl) { toast('请选择模板文件', 'warning'); return; }

  const netType = val('cl-network_type') || 'bridge';
  const v4mode = val('cl-ipv4-mode') || 'dhcp';
  const v6mode = val('cl-ipv6-mode') || 'slaac';
  const ipv4 = v4mode === 'static' ? val('cl-ipv4') : '';
  const ipv6 = v6mode === 'static' ? val('cl-ipv6') : '';
  if (v4mode === 'static' && !ipv4) { toast('静态 IPv4 需要填写地址（含掩码）', 'warning'); return; }
  if (v6mode === 'static' && !ipv6) { toast('静态 IPv6 需要填写地址（含前缀长度）', 'warning'); return; }

  const pwd = val('cl-root-password');
  const pwd2 = val('cl-root-password2');
  if (pwd && pwd !== pwd2) { toast('两次输入的密码不一致', 'warning'); return; }
  if (pwd && pwd.length < 6) { toast('密码至少 6 位', 'warning'); return; }

  const payload = {
    name, template_file: tmpl, autostart,
    root_password: pwd || null,
    ssh_public_key: val('cl-ssh-key') || null,
    environment: val('cl-environment') || null,
    hostname: val('cl-hostname') || null,
    network_type: netType,
    unprivileged: !!(document.getElementById('cl-unprivileged') || {}).checked,
    ipv4_mode: v4mode,
    ipv6_mode: v6mode,
    ipv4_address: ipv4 || null,
    ipv4_gateway: val('cl-gateway') || null,
    ipv6_address: ipv6 || null,
    ipv6_gateway: val('cl-ipv6_gw') || null,
    mac: val('cl-mac') || null,
    vlan: num('cl-vlan'),
    mtu: num('cl-mtu'),
    memory: num('cl-memory'),
    swap: num('cl-swap'),
    cores: num('cl-cores'),
    cpu_limit: num('cl-cpu-limit'),
    dns_domain: val('cl-dns-domain') || null,
    dns_servers: val('cl-dns') || null
  };

  toast('正在创建容器...', 'info');
  try {
    await lxc('/create/from-proxmox', 'POST', payload);
    toast(`容器 ${name} 创建成功`, 'success');
    switchTab('containers');
    pollContainerIP(name);
  } catch(err) { toast('创建失败: ' + err.message, 'error'); }
}

/* 从本地 .pub 文件读 SSH 公钥 */
function loadSshKeyFile(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    const ta = document.getElementById('cl-ssh-key');
    if (ta) ta.value = String(r.result || '').trim();
    toast('已载入 ' + f.name, 'success');
  };
  r.onerror = () => toast('读取文件失败', 'error');
  r.readAsText(f);
  input.value = '';
}

/* 仪表盘网络接口：只列物理网卡和带地址的网桥，虚拟接口给个数量 */
function renderIfaceSummary(list) {
  const arr = Array.isArray(list) ? list : [];
  const main = arr.filter(i => ['physical', 'bond', 'bridge'].includes(i.kind)
    && (((i.ipv4 || []).length) || ((i.ipv6 || []).length)));
  const other = arr.length - main.length;
  if (!main.length) return '-';
  const rows = main.map(i => {
    const bits = [esc(i.name)];
    if ((i.ipv4 || []).length) bits.push(esc(i.ipv4[0]));
    else if ((i.ipv6 || []).length) bits.push(esc(i.ipv6[0]));
    if (i.is_ovs) bits.push('OVS');
    return `<div class="iface-line">${bits.join(' · ')}</div>`;
  });
  if (other > 0) rows.push(`<div class="iface-line iface-dim">另有 ${other} 个虚拟接口</div>`);
  return rows.join('');
}

/* 按 IPv4/IPv6 模式显隐地址行 */
function syncCreateNetworkUI() {
  const v4 = document.getElementById('cl-ipv4-mode')?.value || 'dhcp';
  const v6 = document.getElementById('cl-ipv6-mode')?.value || 'slaac';
  const r4 = document.getElementById('cl-ipv4-row');
  const r6 = document.getElementById('cl-ipv6-row');
  if (r4) r4.style.display = v4 === 'static' ? '' : 'none';
  if (r6) r6.style.display = v6 === 'static' ? '' : 'none';
}
document.addEventListener('DOMContentLoaded', syncCreateNetworkUI);
if (document.readyState !== 'loading') syncCreateNetworkUI();

// ═══════════ 刷新策略：不轮询，只在需要时刷新 ═══════════
// 容器状态由用户操作驱动，固定间隔轮询多数时候是空转。
// 改为：切到容器页 / 窗口重新获得焦点时静默刷新一次 + 手动刷新按钮，
// 另用一个纯文本计时器维护「x 分钟前更新」标签（不发请求）。
function setupRefreshTriggers() {
  if (autoRefresh) { clearInterval(autoRefresh); autoRefresh = null; }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const active = document.querySelector('.tab-content.active');
    if (active && active.id === 'tab-containers') refreshContainers();
  });
  window.addEventListener('focus', () => {
    if (document.visibilityState !== 'visible') return;
    const active = document.querySelector('.tab-content.active');
    if (active && active.id === 'tab-containers' && Date.now() - lastRefreshAt > 20000) refreshContainers();
  });
  // 只更新文字标签，不发任何请求
  autoRefresh = setInterval(updateRefreshLabel, 30000);
}

// ═══════════ Init ═══════════
document.addEventListener('DOMContentLoaded', async () => {
  // Check first-run status first
  try {
    const r = await sys('/first-run');
    if (r.data && r.data.first_run) {
      showSetupWizard();
      return; // Don't load dashboard or start auto-refresh yet
    }
  } catch(e) {
    // If first-run check fails, proceed normally
    console.warn('First-run check failed:', e);
  }
  // 拉取 FnLxc 版本号并显示
  try {
    const r = await sys('/version');
    const ver = r.data || r.version || '3.0.2';
    document.getElementById('app-version').textContent = 'v' + ver;
  } catch(e) {
    console.warn('获取版本号失败:', e);
  }

  loadDashboard();
  setupRefreshTriggers();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closeConfirm(); closePrompt(); closeTerminal(); }
});

// ═══════════ LOGS ═══════════
async function loadLogs() {
  document.getElementById('log-loading').style.display = 'block';
  document.getElementById('log-content').style.display = 'none';
  try {
    const r = await sys('/logs');
    const el = document.getElementById('log-content');
    if (r.data && r.data.length > 0) {
      el.textContent = r.data.join('');
    } else {
      el.textContent = r.msg || '日志为空';
    }
    document.getElementById('log-loading').style.display = 'none';
    el.style.display = 'block';
    el.scrollTop = el.scrollHeight;
  } catch(e) {
    document.getElementById('log-loading').innerHTML = '<p style="color:red;">加载失败: ' + esc(e.message) + '</p>';
  }
}

// ═══════════ 主题切换 ═══════════
const THEME_ICONS = {
  // 当前是深色 → 显示太阳，点了变亮
  dark: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  // 当前是亮色 → 显示月亮，点了变暗
  light: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'
};

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function applyThemeIcon() {
  const icon = document.getElementById('theme-icon');
  if (icon) icon.innerHTML = THEME_ICONS[currentTheme()];
}

function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  const root = document.documentElement;
  root.classList.add('theme-anim');
  root.setAttribute('data-theme', next);
  try { localStorage.setItem('fnlxc-theme', next); } catch (e) {}
  applyThemeIcon();
  setTimeout(() => root.classList.remove('theme-anim'), 220);
}

document.addEventListener('DOMContentLoaded', applyThemeIcon);
if (document.readyState !== 'loading') applyThemeIcon();
