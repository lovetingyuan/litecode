import workbenchStyles from "../styles/workbench.module.css";
import { create } from "zustand";
import { useRef } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Icon, IconButton } from "./ui";

type Request = {
  title: string;
  message?: string;
  items?: string[];
  itemsLabel?: string;
  value?: string;
  choices: string[];
  defaultChoice?: string;
  resolve: (choice: string | null, value?: string) => void;
};
const useDialog = create<{ request: Request | null }>(() => ({ request: null }));
let queue = Promise.resolve();
export function ask(
  title: string,
  message: string,
  choices: string[],
  options?: { items?: string[]; itemsLabel?: string; signal?: AbortSignal; defaultChoice?: string },
): Promise<string | null> {
  return new Promise((resolve) => {
    queue = queue.then(
      () =>
        new Promise<void>((next) => {
          if (options?.signal?.aborted) {
            resolve(null);
            next();
            return;
          }
          let settled = false;
          const finish = (choice: string | null) => {
            if (settled) {
              return;
            }
            settled = true;
            options?.signal?.removeEventListener("abort", cancel);
            useDialog.setState({ request: null });
            resolve(choice);
            next();
          };
          const cancel = () => finish(null);
          options?.signal?.addEventListener("abort", cancel, { once: true });
          useDialog.setState({
            request: {
              title,
              message,
              items: options?.items,
              itemsLabel: options?.itemsLabel,
              choices,
              defaultChoice: options?.defaultChoice,
              resolve: finish,
            },
          });
        }),
    );
  });
}
export function input(title: string, value = ""): Promise<string | null> {
  return new Promise((resolve) => {
    queue = queue.then(
      () =>
        new Promise<void>((next) => {
          useDialog.setState({
            request: {
              title,
              value,
              choices: ["OK", "Cancel"],
              resolve: (choice, text) => {
                useDialog.setState({ request: null });
                resolve(choice === "OK" ? text?.trim() || null : null);
                next();
              },
            },
          });
        }),
    );
  });
}
export function DialogHost() {
  const request = useDialog((s) => s.request);
  const defaultButton = useRef<HTMLButtonElement>(null);
  const submitChoice = request?.defaultChoice ?? request?.choices[0];
  return (
    <Dialog.Root
      open={!!request}
      onOpenChange={(open) => {
        if (!open) {
          request?.resolve(null);
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop fixed inset-0 bg-backdrop z-[150]" />
        <Dialog.Popup
          className={`modal-panel fixed top-[50%] left-[50%] bg-widget border border-strong rounded-[6px] w-120 max-w-[90vw] p-6 z-[151] ${workbenchStyles["modal-panel"]}${request?.items ? ` move-confirmation ${workbenchStyles["move-confirmation"]}` : ""}`}
          initialFocus={request?.defaultChoice ? defaultButton : undefined}
        >
          {request?.items && (
            <>
              <Icon name="info" className="move-info" />
              <IconButton
                icon="close"
                label="Close"
                className="move-close"
                onClick={() => request.resolve(null)}
              />
            </>
          )}
          <Dialog.Title>{request?.title}</Dialog.Title>
          <Dialog.Description>{request?.message}</Dialog.Description>
          {request?.items && (
            <ul className="move-items" aria-label={request.itemsLabel ?? "Items to move"}>
              {request.items.map((item, i) => (
                <li key={`${i}:${item}`} title={item}>
                  {item}
                </li>
              ))}
            </ul>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const text = new FormData(e.currentTarget).get("value");
              request?.resolve(
                submitChoice ?? request.choices[0],
                typeof text === "string" ? text : undefined,
              );
            }}
          >
            {request?.value !== undefined && (
              <input
                name="value"
                defaultValue={request.value}
                autoFocus
                aria-label={request.title}
              />
            )}
            <div
              className={`modal-actions flex justify-end gap-2 mt-6 ${workbenchStyles["modal-actions"]}`}
            >
              {request?.choices.map((choice, i) => (
                <button
                  ref={choice === request.defaultChoice ? defaultButton : undefined}
                  autoFocus={
                    request.defaultChoice
                      ? choice === request.defaultChoice
                      : !!request.items && i === 0
                  }
                  className={
                    i === 0
                      ? `primary bg-focus text-foreground-strong rounded-[2px] py-[5px] px-[14px] ${workbenchStyles["primary"]}`
                      : ""
                  }
                  key={choice}
                  type={choice === submitChoice ? "submit" : "button"}
                  onClick={choice === submitChoice ? undefined : () => request.resolve(choice)}
                >
                  {choice}
                </button>
              ))}
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
