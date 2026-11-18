/* confirm.js —— 确认对话框，返回 Promise<boolean>
 * 用法：if (await confirm({title, text, danger: true})) { … }
 */

import { openModal } from './modal.js';

export function confirm({ title = '确认操作', text = '', danger = false, okLabel = '确定' }) {
  return new Promise((resolve) => {
    const m = openModal({
      title,
      body: `<p style="font-size:13.5px;line-height:1.7">${text}</p>`,
      actions: [
        { label: '取消', onClick: (close) => { close(); resolve(false); } },
        { label: okLabel, cls: danger ? 'danger' : 'primary', onClick: (close) => { close(); resolve(true); } },
      ],
      onClose: () => resolve(false),
    });
    // onClose 也会在点取消时触发，用标志避免双 resolve 无害（Promise 忽略重复）
    void m;
  });
}
