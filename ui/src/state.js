/* state.js —— 单一状态对象 + 订阅通知。禁止各模块自持数据副本 */

const state = {
  /** 'containers' | 'dashboard' | 'create' | 'templates' | 'settings' | 'logs' */
  page: 'containers',
  /** 当前选中容器名，null 表示无 */
  selected: null,
  /** 详情页 tab：'overview' | 'settings' | 'network' | 'data' */
  detailTab: 'overview',
  /** 容器列表（GET /api/lxc/list 的 data） */
  containers: [],
  /** 选中容器的 info（GET .../info），null 表示加载中/未加载 */
  info: null,
  /** 全局统计（GET /api/stats） */
  stats: null,
  version: '',
  /** 全局 UI 提示，由 toast 消费 */
  toast: null, // {type:'ok'|'err', text}
};

const subs = new Set(); // fn(newState, changedKeys)

/** 订阅状态变化。返回取消函数 */
export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

/**
 * 更新状态并通知。patch 为对象时浅合并；changedKeys 传被改的键名数组（可省略，默认全部键）。
 * 同一轮多次 set 合并到最后一次通知。
 */
let notifyQueued = false;
let lastPatchKeys = [];
export function setState(patch, changedKeys) {
  Object.assign(state, patch);
  lastPatchKeys.push(...(changedKeys || Object.keys(patch)));
  if (!notifyQueued) {
    notifyQueued = true;
    queueMicrotask(() => {
      notifyQueued = false;
      const keys = [...new Set(lastPatchKeys)];
      lastPatchKeys = [];
      subs.forEach((fn) => fn(state, keys));
    });
  }
}

/** 只读访问当前状态 */
export function getState() {
  return state;
}

/** toast 便捷方法 */
export function toastOk(text) { setState({ toast: { type: 'ok', text } }, ['toast']); }
export function toastErr(text) { setState({ toast: { type: 'err', text } }, ['toast']); }

export default state;
