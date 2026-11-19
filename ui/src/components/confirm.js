/* confirm.js —— 确认对话框，返回 Promise<boolean>
 * 用法：if (await confirm({title, text, danger: true})) { … }
 */

import { openModal } from './modal.js';

export function confirm({ title = '确认操作', text = '', danger = false, okLabel = '确定' }) {
  return new Promise((resolve) => {
    // #6 修复：text 用 textContent 注入，防止快照名/备份文件名中的 HTML 被执行
    const p = document.createElement('p');
    p.style.cssText = 'font-size:13.5px;line-height:1.7';
    p.textContent = text;

    const m = openModal({
      title,
      body: p,
      actions: [
        { label: '取消', onClick: (close) => { close(); resolve(false); } },
        { label: okLabel, cls: danger ? 'danger' : 'primary', onClick: (close) => { close(); resolve(true); } },
      ],
      onClose: () => resolve(false),
    });
    void m;
  });
}