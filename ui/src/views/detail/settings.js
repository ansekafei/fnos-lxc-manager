/* detail/settings.js —— 容器详情 · 设置 tab：资源限制 / 元数据 / 原始配置
 * 423 locked 时提示"停止容器后可编辑"（client.js 已抛 ApiError.locked）。
 */

import { getState, toastErr, toastOk } from '../../state.js';
import { getConfig, updateConfig, setLimits, setDescription, deleteDescription, setAutostart, setOrder, setMac } from '../../api/config.js';
import { field, input, textarea } from '../../components/field.js';
import { confirm } from '../../components/confirm.js';
import { ApiError } from '../../api/client.js';

export function render(body) {
  const { info, selected } = getState();
  if (!info) { body.innerHTML = '<div class="loading">加载中…</div>'; return; }

  body.innerHTML = `
    <div class="grid2">
      <div class="panel"><div class="ph">资源限制<span>运行期锁定，停止后可编辑</span></div><div class="pb" id="st-limits"></div></div>
      <div class="panel"><div class="ph">元数据</div><div class="pb" id="st-meta"></div></div>
    </div>
    <div class="panel"><div class="ph">原始配置（config）</div><div class="pb" id="st-config"></div></div>`;

  renderLimits(body.querySelector('#st-limits'), info);
  renderMeta(body.querySelector('#st-meta'), info);
  loadRawConfig(body.querySelector('#st-config'), selected);
}

function renderLimits(el, info) {
  const cpuIn = input({ value: info.cpu_limit ?? info.cpus ?? '' , placeholder: '如 2 或 0-3' });
  const memIn = input({ value: info.memory_limit ? Math.round(info.memory_limit / 1024 / 1024) : '', placeholder: 'MB' });
  const save = document.createElement('button');
  save.className = 'btn primary'; save.textContent = '保存限制'; save.dataset.stAct = 'save-limits';
  save.dataset.cpuIn = '1'; save.dataset.memIn = '1';
  el.append(
    field('CPU 核心数', cpuIn, { hint: '数字或 cpuset 形式（0-3 / 0,2）' }),
    field('内存（MB）', memIn),
    save,
  );
  el._inputs = { cpuIn, memIn };
}

function renderMeta(el, info) {
  const descIn = textarea({ value: info.description || '', rows: 3 });
  const autoIn = input({ value: info.autostart ? 'true' : 'false' });
  const orderIn = input({ value: info.order ?? '', type: 'number' });
  const macIn = input({ value: info.mac || '' });
  const save = document.createElement('button');
  save.className = 'btn primary'; save.textContent = '保存元数据'; save.dataset.stAct = 'save-meta';
  el.append(
    field('描述', descIn),
    field('开机自启', autoIn, { hint: 'true / false' }),
    field('启动顺序', orderIn),
    field('MAC 地址', macIn),
    save,
  );
  el._inputs = { descIn, autoIn, orderIn, macIn };
}

async function loadRawConfig(el, name) {
  try {
    const lines = await getConfig(name);
    const ta = textarea({ value: (lines || []).join('\n'), rows: 10 });
    const save = document.createElement('button');
    save.className = 'btn'; save.textContent = '保存配置'; save.dataset.stAct = 'save-config';
    el.append(field('lxc 配置行', ta), save);
    el._inputs = { ta };
  } catch (e) {
    el.innerHTML = '';
    if (e instanceof ApiError && e.locked) {
      el.innerHTML = `<div class="empty">⚠️ ${e.message}</div>`;
    } else {
      el.innerHTML = `<div class="empty">${e.message}</div>`;
    }
  }
}

/* main.js 委托转发：click 在 [data-st-act] 上 */
export async function onAction(act, btn) {
  const { selected, info } = getState();
  if (!selected || !btn) return;
  const panel = btn.closest('.pb');
  const inputs = panel?._inputs || {};
  try {
    if (act === 'save-limits') {
      const cpu = inputs.cpuIn.value.trim();
      const mem = inputs.memIn.value.trim();
      await setLimits(selected, { cpu: cpu || undefined, memory: mem ? Number(mem) : undefined });
      toastOk('资源限制已保存');
    } else if (act === 'save-meta') {
      const desc = inputs.descIn.value;
      const auto = inputs.autoIn.value.trim().toLowerCase() === 'true';
      const order = inputs.orderIn.value ? Number(inputs.orderIn.value) : undefined;
      const mac = inputs.macIn.value.trim();
      if (desc) await setDescription(selected, desc); else await deleteDescription(selected).catch(() => {});
      await setAutostart(selected, auto);
      if (order !== undefined) await setOrder(selected, order);
      if (mac) await setMac(selected, mac);
      toastOk('元数据已保存');
    } else if (act === 'save-config') {
      const ok = await confirm({ title: '写入原始配置', text: '将按行覆盖写入容器 config。错误的配置可能导致容器无法启动，确定继续吗？', danger: true, okLabel: '写入' });
      if (!ok) return;
      const updates = {};
      for (const line of inputs.ta.value.split('\n')) {
        const m = line.match(/^\s*(lxc\.[\w.]+)\s*=\s*(.*)$/);
        if (m) updates[m[1]] = m[2].trim();
      }
      await updateConfig(selected, updates);
      toastOk('配置已写入');
    }
  } catch (e) {
    toastErr(e instanceof ApiError && e.locked ? e.message : `保存失败：${e.message}`);
  }
  void info;
}
