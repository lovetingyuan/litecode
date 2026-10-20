import { create } from 'zustand';
import { Dialog } from '@base-ui/react/dialog';
import { Icon, IconButton } from './ui';

type Request = { title: string; message?: string; items?: string[]; value?: string; choices: string[]; resolve: (choice: string | null, value?: string) => void };
const useDialog = create<{ request: Request | null }>(() => ({ request: null }));
let queue = Promise.resolve();
export function ask(title: string, message: string, choices: string[], options?: { items?: string[]; signal?: AbortSignal }): Promise<string | null> {
  return new Promise(resolve => {
    queue = queue.then(() => new Promise<void>(next => {
      if (options?.signal?.aborted) { resolve(null); next(); return; }
      let settled = false;
      const finish = (choice: string | null) => {
        if (settled) return;
        settled = true;
        options?.signal?.removeEventListener('abort', cancel);
        useDialog.setState({ request: null }); resolve(choice); next();
      };
      const cancel = () => finish(null);
      options?.signal?.addEventListener('abort', cancel, { once: true });
      useDialog.setState({ request: { title, message, items: options?.items, choices, resolve: finish } });
    }));
  });
}
export function input(title: string, value = ''): Promise<string | null> {
  return new Promise(resolve => {
    queue = queue.then(() => new Promise<void>(next => {
      useDialog.setState({ request: { title, value, choices: ['OK', 'Cancel'], resolve: (choice, text) => { useDialog.setState({ request: null }); resolve(choice === 'OK' ? text?.trim() || null : null); next(); } } });
    }));
  });
}
export function DialogHost() {
  const request = useDialog(s => s.request);
  return <Dialog.Root open={!!request} onOpenChange={open => { if (!open) request?.resolve(null); }}>
    <Dialog.Portal><Dialog.Backdrop className="modal-backdrop" /><Dialog.Popup className={`modal-panel${request?.items ? ' move-confirmation' : ''}`}>
      {request?.items && <><Icon name="info" className="move-info" /><IconButton icon="close" label="Close" className="move-close" onClick={() => request.resolve(null)} /></>}
      <Dialog.Title>{request?.title}</Dialog.Title>
      <Dialog.Description>{request?.message}</Dialog.Description>
      {request?.items && <ul className="move-items" aria-label="Items to move">{request.items.map((item, i) => <li key={`${i}:${item}`} title={item}>{item}</li>)}</ul>}
      <form onSubmit={e => { e.preventDefault(); const text = new FormData(e.currentTarget).get('value'); request?.resolve(request.choices[0], typeof text === 'string' ? text : undefined); }}>
        {request?.value !== undefined && <input name="value" defaultValue={request.value} autoFocus aria-label={request.title} />}
        <div className="modal-actions">{request?.choices.map((choice, i) => <button autoFocus={!!request.items && i === 0} className={i === 0 ? 'primary' : ''} key={choice} type={i === 0 ? 'submit' : 'button'} onClick={i === 0 ? undefined : () => request.resolve(choice)}>{choice}</button>)}</div>
      </form>
    </Dialog.Popup></Dialog.Portal>
  </Dialog.Root>;
}
