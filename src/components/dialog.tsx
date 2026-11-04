import workbenchStyles from "../styles/workbench.module.css";
import { create } from "zustand";
import { useRef } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Icon, IconButton } from "./ui";
import { openUrl } from "@tauri-apps/plugin-opener";
import { notify } from "../store/store";
import { errorMessage } from "../core/bridge";
import type { DialogOptions, DialogRequest, InputAction } from "../types/dialog";

const useDialog = create<{ request: DialogRequest | null }>(() => ({ request: null }));
function updateRequest(patch: Partial<DialogRequest>) {
  useDialog.setState((state) => ({
    request: state.request && { ...state.request, ...patch },
  }));
}
let queue = Promise.resolve();
function showDialog(
  data: Omit<DialogRequest, "resolve">,
  signal?: AbortSignal,
): Promise<{ choice: string | null; value?: string }> {
  return new Promise((resolve) => {
    const show = (parent: DialogRequest | null) =>
      new Promise<void>((next) => {
        if (signal?.aborted) {
          resolve({ choice: null });
          next();
          return;
        }
        let settled = false;
        let working = false;
        const finish = (choice: string | null, value?: string) => {
          if (settled || working) {
            return;
          }
          settled = true;
          signal?.removeEventListener("abort", cancel);
          useDialog.setState({ request: parent });
          resolve({ choice, value });
          next();
        };
        const choose = async (choice: string | null, value?: string) => {
          if (settled || working) {
            return;
          }
          const action = data.action;
          if (
            useDialog.getState().request?.error &&
            action?.retry === false &&
            choice &&
            (typeof action.choice === "string"
              ? choice === action.choice
              : action.choice.includes(choice))
          ) {
            return;
          }
          if (
            choice &&
            action &&
            (typeof action.choice === "string"
              ? choice === action.choice
              : action.choice.includes(choice))
          ) {
            working = true;
            updateRequest({
              working: choice,
              error: undefined,
              value: data.value === undefined ? undefined : value,
            });
            try {
              if ((await action.run(choice, value)) === false) {
                updateRequest({
                  working: undefined,
                  error: "The operation did not complete. Try again or cancel.",
                });
                return;
              }
            } catch (error) {
              updateRequest({ working: undefined, error: errorMessage(error) });
              return;
            } finally {
              working = false;
              if (signal?.aborted) {
                finish(null);
              }
            }
          }
          finish(choice, value);
        };
        const cancel = () => finish(null);
        signal?.addEventListener("abort", cancel, { once: true });
        useDialog.setState({
          request: {
            ...data,
            resolve: (choice, value) => void choose(choice, value),
          },
        });
      });
    const parent = useDialog.getState().request;
    // An action can need another confirmation (for example, administrator save).
    // Show it now and restore the working parent instead of queuing behind it.
    if (parent?.working) {
      void show(parent);
    } else {
      queue = queue.then(() => show(null));
    }
  });
}
export async function ask(
  title: string,
  message: string,
  choices: string[],
  options?: DialogOptions,
): Promise<string | null> {
  return (await showDialog({ title, message, choices, ...options }, options?.signal)).choice;
}
export async function input(
  title: string,
  value = "",
  action?: InputAction,
): Promise<string | null> {
  const result = await showDialog({
    title,
    value,
    choices: ["OK", "Cancel"],
    action: action && {
      choice: "OK",
      label: action.label,
      run: async (_choice, text) => {
        if (!text?.trim()) {
          throw new Error("Enter a value.");
        }
        await action.run(text.trim());
      },
    },
  });
  return result.choice === "OK" ? result.value?.trim() || null : null;
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
          className={`modal-panel fixed top-[50%] left-[50%] bg-widget border border-strong rounded-[6px] w-120 max-w-[90vw] p-6 z-[151] ${workbenchStyles["modal-panel"]}${request?.items ? " move-confirmation ".concat(workbenchStyles["move-confirmation"]) : ""}`}
          initialFocus={request?.defaultChoice ? defaultButton : undefined}
          aria-busy={!!request?.working || undefined}
        >
          {request?.items && (
            <>
              <Icon name="info" className="move-info" />
              <IconButton
                icon="close"
                label="Close"
                className="move-close"
                disabled={!!request.working}
                onClick={() => request.resolve(null)}
              />
            </>
          )}
          <Dialog.Title>{request?.title}</Dialog.Title>
          <Dialog.Description>{request?.message}</Dialog.Description>
          {request?.error && (
            <p role="alert" className="mt-4 text-error">
              {request.error}
            </p>
          )}
          {request?.links && (
            <div className="flex flex-wrap gap-4 mt-4">
              {request.links.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  className="text-focus hover:underline"
                  onClick={(event) => {
                    event.preventDefault();
                    void openUrl(link.url).catch((error) => notify(errorMessage(error)));
                  }}
                >
                  {link.label}
                </a>
              ))}
            </div>
          )}
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
                key={request.title}
                defaultValue={request.value}
                disabled={!!request.working}
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
                  disabled={
                    !!request.working ||
                    (!!request.error &&
                      request.action?.retry === false &&
                      (typeof request.action.choice === "string"
                        ? choice === request.action.choice
                        : request.action.choice.includes(choice)))
                  }
                  aria-busy={request.working === choice || undefined}
                  type={choice === submitChoice ? "submit" : "button"}
                  onClick={choice === submitChoice ? undefined : () => request.resolve(choice)}
                >
                  {request.working === choice && request.action ? (
                    <span className="inline-flex items-center gap-2">
                      <Icon name="loading" className="animate-spin" />
                      {request.action.label}
                    </span>
                  ) : (
                    choice
                  )}
                </button>
              ))}
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
