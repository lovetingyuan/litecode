import { call } from "../core/bridge";
import { ask } from "../components/dialog";
import type { SaveDocumentRequest } from "../types/types";

export async function saveWithElevation(
  request: SaveDocumentRequest,
  options: { automatic: boolean; isCurrent: () => boolean },
): Promise<string> {
  try {
    return await call<string>("save_document", { ...request });
  } catch (error) {
    if (
      options.automatic ||
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "elevationRequired"
    ) {
      throw error;
    }
    let revision: string | undefined;
    const answer = await ask(
      "Administrator permission required",
      `Unable to save to:\n${request.path}\n\nSave this file as administrator? Windows will ask for permission.`,
      ["Save as Administrator", "Cancel"],
      {
        defaultChoice: "Cancel",
        action: {
          choice: "Save as Administrator",
          label: "Saving…",
          run: async () => {
            if (!options.isCurrent()) {
              throw {
                code: "stale",
                message: "The document changed while awaiting confirmation. Save again.",
              };
            }
            revision = await call<string>("save_document", { ...request, elevate: true });
          },
        },
      },
    );
    if (answer !== "Save as Administrator") {
      throw {
        code: "elevationCancelled",
        message: "Administrator save cancelled. The file has not been saved.",
      };
    }
    if (revision === undefined) {
      throw {
        code: "io",
        message: "The file has not been saved. Save again.",
      };
    }
    return revision;
  }
}
