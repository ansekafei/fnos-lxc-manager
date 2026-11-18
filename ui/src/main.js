/* main.js —— 入口：挂载各 view、统一事件委托（全站无内联 onclick） */

import { getState, setState, subscribe } from './state.js';
import './components/toast.js'; // 激活全局 toast
import { listContainers } from './api/containers.js';
import { getVersion } from './api/system.js';
import { toastErr } from './state.js';

import * as roster from './views/roster.js';
import * as overview from './views/detail/overview.js';
import * as dsettings from './views/detail/settings.js';
import * as dnetwork from './views/detail/network.js';
import * as ddata from './views/detail/data.js';
import * as dashboard from './views/dashboard.js';
import * as create from './views/create.js';
import * as templates from './views/templates.js';
import * as settings from './views/settings.js';
import * as logs from './views/logs.js';

const PAGE_TITLES = { dashboard: '仪表盘', containers: '容器管理', create: '创建容器', templates: '模板', settings: '设置', logs: '日志' };

const $ = (sel) => document.querySelector(sel);
const el = {
  nav: $('#nav'),
  title: $('#page-title'),
  pill: $('#stats-pill'),
  right: $('#topbar-right'),
  master: $('#master-col'),
  detail: $('#detail-col'),
  page: $('#page'),
  roster: $('#roster'),
  foot: $('#foot'),
};

/* ---- 初始化各 view ---- */
roster.init(el.roster);
overview.init(el.detail);
dashboard.init(el.page);
create.init(el.page);
templates.init(el.page);
settings.init(el.page);
logs.init(el.page);

/* ---- 页面切换 ---- */
function showPage(page) {
  const s = getState();
  const isContainers = page === 'containers';
  el.master.style.display = isContainers ? '' : 'none';
  el.detail.style.display = isContainers ? '' : 'none';
  el.page.style.display = isContainers ? 'none' : '';
  el.title.textContent = PAGE_TITLES[page] || page;

  el.nav.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.page === page));

  if (isContainers) {
    overview.render();
    if (s.selected) overview.load();
  } else {
    ({ dashboard, create, templates, settings, logs })[page]?.load?.();
  }
  void s;
}

function switchPage(page) {
  setState({ page, selected: page === 'containers' ? getState().selected : null }, ['page']);
}

/* ---- 状态订阅：统一重绘 ---- */
subscribe((state, keys) => {
  if (keys.includes('page')) showPage(state.page);
  if (keys.includes('selected') && state.page === 'containers') {
    roster.render();
    overview.load();
  }
  if (keys.includes('containers') && !keys.includes('selected')) roster.render();
  if (keys.includes('detailTab') && state.page === 'containers') renderDetailTab();
  if (keys.includes('info') && state.page === 'containers' && state.detailTab === 'overview') overview.render();
  if (keys.includes('stats') && state.page === 'dashboard') dashboard.render();
  renderTopbar(state);
});

/* tab 内容分发：tab 条在 overview.render() 里画，body 按 detailTab 填充 */
function renderDetailTab() {
  const { detailTab } = getState();
  overview.render(); // 画头部 + tab 条 + overview body（若是 overview）
  const body = document.getElementById('detail-body');
  if (!body || detailTab === 'overview') return;
  body.innerHTML = '';
  ({ settings: dsettings, network: dnetwork, data: ddata })[detailTab]?.render(body);
}

function renderTopbar(state) {
  if (state.page === 'containers' && state.containers.length) {
    const run = state.containers.filter((c) => (c.state || '').toLowerCase() === 'running').length;
    el.pill.style.display = '';
    el.pill.textContent = `${run} 运行中 · ${state.containers.length - run} 已停止`;
  } else {
    el.pill.style.display = 'none';
  }
  if (state.version) el.foot.textContent = `v${state.version} · fnOS`;
}

/* ---- 全局事件委托（杜绝内联 onclick） ---- */
document.addEventListener('click', async (e) => {
  /* 侧边导航 */
  const navA = e.target.closest('#nav a[data-page]');
  if (navA) return switchPage(navA.dataset.page);

  /* 容器列表选中 */
  const ct = e.target.closest(roster.onClickSelector);
  if (ct) {
    setState({ selected: ct.dataset.name, detailTab: 'overview' }, ['selected', 'detailTab']);
    return;
  }

  /* 详情 tab 切换 */
  const tab = e.target.closest('.detail .tabs a[data-tab]');
  if (tab) return overview.onTabClick(tab.dataset.tab);

  /* 详情头部动作（启动/停止/重启/终端/删除） */
  const act = e.target.closest('.detail .d-head [data-act]');
  if (act) return overview.onAction(act.dataset.act);

  /* 设置 tab 动作 */
  const stAct = e.target.closest('[data-st-act]');
  if (stAct) return dsettings.onAction(stAct.dataset.stAct, stAct);

  /* 网络 tab 动作 */
  const nwAct = e.target.closest('[data-nw-act]');
  if (nwAct) return dnetwork.onAction(nwAct.dataset.nwAct, nwAct);

  /* 数据 tab 动作 */
  const dtAct = e.target.closest('[data-dt-act]');
  if (dtAct) return ddata.onAction(dtAct.dataset.dtAct, dtAct);

  /* 创建页动作 */
  const crAct = e.target.closest('[data-cr-act]');
  if (crAct) return create.onAction(crAct.dataset.crAct);

  /* 模板页动作 */
  const tpAct = e.target.closest('[data-tp-act]');
  if (tpAct) return templates.onAction(tpAct.dataset.tpAct, tpAct);

  /* 设置页动作 */
  const seAct = e.target.closest('[data-se-act]');
  if (seAct) return settings.onAction(seAct.dataset.seAct);
});

/* ---- 启动 ---- */
async function boot() {
  try {
    const [containers, version] = await Promise.all([listContainers(), getVersion().catch(() => '')]);
    setState({ containers: containers || [], version: version?.version || '' }, ['containers', 'version']);
    renderTopbar(getState());
    showPage(getState().page);
  } catch (e) {
    toastErr(`初始化失败：${e.message}`);
    showPage('containers');
  }
}

boot();
