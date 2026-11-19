/* topbar.js —— 顶栏：页面标题、运行统计 pill、版本号 */

import { getState } from '../state.js';

const PAGE_TITLES = { dashboard: '仪表盘', containers: '容器管理', create: '创建容器', templates: '模板', settings: '设置', logs: '日志' };

export function init(titleEl, pillEl, footEl) {
  return {
    title: titleEl,
    pill: pillEl,
    foot: footEl,
  };
}

export function update(refs, state) {
  const { title, pill, foot } = refs;
  title.textContent = PAGE_TITLES[state.page] || state.page;

  if (state.page === 'containers' && state.containers.length) {
    const run = state.containers.filter((c) => (c.state || '').toLowerCase() === 'running').length;
    pill.style.display = '';
    pill.textContent = `${run} 运行中 · ${state.containers.length - run} 已停止`;
  } else {
    pill.style.display = 'none';
  }

  if (state.version) foot.textContent = `v${state.version} · fnOS`;
}