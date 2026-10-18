import { create } from 'zustand';
import { Dialog } from '@base-ui/react/dialog';

type Request = { title: string; message?: string; value?: string; choices: string[]; resolve: (choice: string | null, value?: string) => void };
const useDialog = create<{ request: Request | null }>(() => ({ request: null }));
let queue = Promise.resolve();
export function ask(title: string, message: string, choices: string[]): Promise<string | null> {
  return new Promise(resolve => {
    queue = queue.then(() => new Promise<void>(next => {
      useDialog.setState({ request: { title, message, choices, resolve: choice => { useDialog.setState({ request: null }); resolve(choice); next(); } } });
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
    <Dialog.Portal><Dialog.Backdrop className="modal-backdrop" /><Dialog.Popup className="modal-panel">
      <Dialog.Title>{request?.title}</Dialog.Title>
      <Dialog.Description>{request?.message}</Dialog.Description>
      <form onSubmit={e => { e.preventDefault(); const text = new FormData(e.currentTarget).get('value'); request?.resolve(request.choices[0], typeof text === 'string' ? text : undefined); }}>
        {request?.value !== undefined && <input name="value" defaultValue={request.value} autoFocus aria-label={request.title} />}
        <div className="modal-actions">{request?.choices.map((choice, i) => <button className={i === 0 ? 'primary' : ''} key={choice} type={i === 0 ? 'submit' : 'button'} onClick={i === 0 ? undefined : () => request.resolve(choice)}>{choice}</button>)}</div>
      </form>
    </Dialog.Popup></Dialog.Portal>
  </Dialog.Root>;
}
