/* main.js —— 入口：挂载各 view、统一事件委托（全站无内联 onclick） */

import { getState, setState, subscribe } from './state.js';
import './components/toast.js'; // 激活全局 toast
import { listContainers } from './api/containers.js';
import { getVersion } from './api/system.js';
import { toastErr } from './state.js';

import * as sidebar from './components/sidebar.js';
import * as topbar from './components/topbar.js';

import * as roster from './views/roster.js';
import * as overview from './views/detail/overview.js';
import * as dsettings from './views/detail/settings.js';
import * as dnetwork from './views/detail/network.js';
import * as ddata from './views/detail/data.js';
import * as dterminal from './views/detail/terminal.js';
import * as dashboard from './views/dashboard.js';
import * as create from './views/create.js';
import * as templates from './views/templates.js';
import * as settings from './views/settings.js';
import * as logs from './views/logs.js';

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

/* ---- 初始化组件与 view ---- */
const topbarRefs = topbar.init(el.title, el.pill, el.foot);
sidebar.init(el.nav, el.roster);

roster.init(el.roster);
overview.init(el.detail);
// #1 修复：注入 renderDetailTab 回调，启停后在非概览 tab 也能正确重绘 body
overview.setRenderDetailTab(renderDetailTab);
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

  sidebar.update(el.nav, page);
  topbar.update(topbarRefs, s);

  if (isContainers) {
    if (s.selected) overview.load();
    else overview.render();
  } else {
    // #2 修复：离开容器页时销毁终端
    dterminal.destroy();
    ({ dashboard, create, templates, settings, logs })[page]?.load?.();
  }
}

/* ---- 状态订阅：统一重绘 ---- */
subscribe((state, keys) => {
  if (keys.includes('page')) showPage(state.page);
  if (keys.includes('selected') && state.page === 'containers') {
    // #2 修复：切容器时销毁旧终端
    dterminal.destroy();
    roster.render();
    overview.load();
  }
  if (keys.includes('containers') && !keys.includes('selected')) roster.render();
  if (keys.includes('detailTab') && state.page === 'containers') renderDetailTab();
  if (keys.includes('info') && state.page === 'containers' && state.detailTab === 'overview') overview.render();
  if (keys.includes('stats') && state.page === 'dashboard') dashboard.render();
  topbar.update(topbarRefs, state);
});

/* tab 内容分发：tab 条在 overview.render() 里画，body 按 detailTab 填充 */
function renderDetailTab() {
  const { detailTab } = getState();
  // #2 修复：切走终端 tab 时销毁终端实例
  if (detailTab !== 'terminal') dterminal.destroy();
  overview.render(); // 画头部 + tab 条 + overview body（若是 overview）
  const body = document.getElementById('detail-body');
  if (!body || detailTab === 'overview') return;
  body.innerHTML = '';
  ({ settings: dsettings, network: dnetwork, data: ddata, terminal: dterminal })[detailTab]?.render(body);
}

/* ---- 全局事件委托（杜绝内联 onclick） ---- */
document.addEventListener('click', async (e) => {
  /* 容器列表选中 */
  const ct = e.target.closest(roster.onClickSelector);
  if (ct) {
    setState({ selected: ct.dataset.name, detailTab: 'overview' }, ['selected', 'detailTab']);
    return;
  }

  /* 详情 tab 切换 */
  const tab = e.target.closest('.detail .tabs a[data-tab]');
  if (tab) return overview.onTabClick(tab.dataset.tab);

  /* 详情头部动作（启动/停止/重启/删除） */
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
    topbar.update(topbarRefs, getState());
    showPage(getState().page);
  } catch (e) {
    toastErr(`初始化失败：${e.message}`);
    showPage('containers');
  }
}

boot();