/** 轻量模态框:集中处理表单类交互 */
export const modal = {
  open(title: string, bodyHtml: string, onConfirm: () => Promise<void> | void): void {
    const root = document.getElementById('modal-root')!;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<div class="modal">
      <h3>${title}</h3>
      <div class="modal-body">${bodyHtml}</div>
      <div class="actions">
        <button id="m-cancel">取消</button>
        <button class="primary" id="m-ok">确定</button>
      </div></div>`;
    root.appendChild(backdrop);
    const close = (): void => backdrop.remove();
    backdrop.querySelector('#m-cancel')!.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.querySelector('#m-ok')!.addEventListener('click', async () => {
      try {
        await onConfirm();
        close();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  },
};
