/* settings.js —— 全局设置页 */

import { toastErr, toastOk } from '../state.js';
import { getSettings, saveSettings, listStoragePools, listInterfaces, factoryReset } from '../api/system.js';
import { field, input, select } from '../components/field.js';
import { confirm } from '../components/confirm.js';

let root = null;

export function init(mountEl) { root = mountEl; }

export async function load() {
  if (!root) return;
  root.innerHTML = '<div class="loading">加载中…</div>';
  try {
    const [settings, pools, nics] = await Promise.all([
      getSettings(),
      listStoragePools().catch(() => []),
      listInterfaces().catch(() => []),
    ]);
    render(settings || {}, pools || [], nics || []);
  } catch (e) {
    root.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

function render(s, pools, nics) {
  root.innerHTML = '<h1 style="font-size:var(--fs-xl);margin-bottom:18px">设置</h1>';
  const grid = document.createElement('div');
  grid.className = 'grid2';

  const p1 = document.createElement('div');
  p1.className = 'panel';
  p1.innerHTML = '<div class="ph">存储</div><div class="pb"></div>';
  const pb1 = p1.querySelector('.pb');
  const lxcPath = input({ value: s.lxc_path || '' });
  const bakPath = input({ value: s.backup_path || '' });
  const cacheDir = input({ value: s.cache_dir || '' });
  const pool = select([{ value: '', label: '自动识别' }, ...pools.map((v) => ({ value: v.name || v, label: `${v.name || v}${v.mount ? ' · ' + v.mount : ''}` }))], s.zfs_pool || '');
  pb1.append(field('容器存储目录', lxcPath), field('备份目录', bakPath), field('模板缓存目录', cacheDir), field('存储卷（btrfs）', pool));

  const p2 = document.createElement('div');
  p2.className = 'panel';
  p2.innerHTML = '<div class="ph">备份与网络</div><div class="pb"></div>';
  const pb2 = p2.querySelector('.pb');
  const keep = input({ value: s.backup_keep ?? '', type: 'number' });
  const maxPer = input({ value: s.backup_max_per_container ?? '', type: 'number' });
  const comp = input({ value: s.backup_compression ?? '', type: 'number' });
  const threads = input({ value: s.backup_threads ?? '', type: 'number' });
  const useSnap = select([{ value: 'false', label: '关闭' }, { value: 'true', label: '开启' }], String(s.backup_use_snapshot || 'false'));
  const mirror = input({ value: s.lxc_mirror || '' });
  const stopTimeout = input({ value: s.stop_timeout ?? '', type: 'number' });
  const netType = select(['lxcbr0', 'macvlan', 'none'], s.network_type || 'lxcbr0');
  const defNic = select([{ value: '', label: '无' }, ...nics.map((n) => ({ value: n.name, label: n.name }))], s.default_interface || '');
  pb2.append(
    field('备份保留份数', keep), field('每容器最大备份', maxPer),
    field('xz 压缩等级', comp, { hint: '1-9' }), field('压缩线程', threads),
    field('备份前先打快照', useSnap), field('镜像源', mirror),
    field('停止超时（秒）', stopTimeout), field('默认网络模式', netType), field('默认桥接网卡', defNic),
  );

  grid.append(p1, p2);
  root.appendChild(grid);

  const save = document.createElement('button');
  save.className = 'btn primary';
  save.textContent = '保存设置';
  save.dataset.seAct = 'save';
  save.style.marginRight = '10px';
  const reset = document.createElement('button');
  reset.className = 'btn danger';
  reset.textContent = '恢复出厂';
  reset.dataset.seAct = 'reset';
  root.append(save, reset);

  root._inputs = { lxcPath, bakPath, cacheDir, pool, keep, maxPer, comp, threads, useSnap, mirror, stopTimeout, netType, defNic };
}

/* main.js 委托转发 */
export async function onAction(act) {
  const I = root._inputs;
  if (!I) return;
  if (act === 'save') {
    try {
      await saveSettings({
        lxc_path: I.lxcPath.value.trim(),
        backup_path: I.bakPath.value.trim(),
        cache_dir: I.cacheDir.value.trim(),
        zfs_pool: I.pool.value,
        backup_keep: num(I.keep.value),
        backup_max_per_container: num(I.maxPer.value),
        backup_compression: num(I.comp.value),
        backup_threads: num(I.threads.value),
        backup_use_snapshot: I.useSnap.value === 'true',
        lxc_mirror: I.mirror.value.trim(),
        stop_timeout: num(I.stopTimeout.value),
        network_type: I.netType.value,
        default_interface: I.defNic.value,
      });
      toastOk('设置已保存');
    } catch (e) { toastErr(`保存失败：${e.message}`); }
  } else if (act === 'reset') {
    const ok = await confirm({ title: '恢复出厂', text: '将停止全部容器、删除配置并在下次启动进入初始化向导。确定继续吗？', danger: true, okLabel: '恢复出厂' });
    if (!ok) return;
    try { await factoryReset(); toastOk('已恢复出厂'); await load(); }
    catch (e) { toastErr(`操作失败：${e.message}`); }
  }
}
const num = (v) => (v === '' || v == null ? undefined : Number(v));
