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
    const answer = await ask(
      "Administrator permission required",
      `Unable to save to:\n${request.path}\n\nSave this file as administrator? Windows will ask for permission.`,
      ["Save as Administrator", "Cancel"],
      { defaultChoice: "Cancel" },
    );
    if (answer !== "Save as Administrator") {
      throw {
        code: "elevationCancelled",
        message: "Administrator save cancelled. The file has not been saved.",
      };
    }
    if (!options.isCurrent()) {
      throw {
        code: "stale",
        message: "The document changed while awaiting confirmation. Save again.",
      };
    }
    return call<string>("save_document", { ...request, elevate: true });
  }
}
