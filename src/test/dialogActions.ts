import type { DialogOptions } from "../types/dialog";

// Service tests select a dialog answer directly; execute its work before resolving
// so they exercise the same operation ordering as the real dialog host.
export async function completeDialogAction(choice: string | null, options?: DialogOptions) {
  const action = options?.action;
  if (choice && action && [action.choice].flat().includes(choice)) {
    await action.run(choice);
  }
  return choice;
}
