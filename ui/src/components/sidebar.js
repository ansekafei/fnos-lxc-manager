/* sidebar.js —— 左侧导航栏：页面切换、高亮、容器列表挂载 */

import { getState, setState } from '../state.js';
import * as roster from '../views/roster.js';

export function init(navEl, rosterEl) {
  // roster.init 由 main.js 统一调用，sidebar 只管导航事件
  navEl.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-page]');
    if (!a) return;
    const page = a.dataset.page;
    // #10 修复：selected 变化也要通知订阅者
    const newSelected = page === 'containers' ? getState().selected : null;
    setState({ page, selected: newSelected }, ['page', 'selected']);
  });
}

export function update(navEl, page) {
  navEl.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.page === page));
}