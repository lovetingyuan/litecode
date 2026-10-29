import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";

vi.mock("./monaco", () => ({ monaco: { editor: { createModel: vi.fn() } } }));
vi.mock("@codingame/monaco-vscode-api/monaco", () => ({ createModelReference: vi.fn() }));

import { createModelReference } from "@codingame/monaco-vscode-api/monaco";
import { monaco } from "./monaco";
import { createGitDiffModels } from "./gitDiffModels";

const model = (id: string) =>
  ({ uri: id, dispose: vi.fn() }) as unknown as Monaco.editor.ITextModel;
const content = { before: "base\n", after: "changed\n" };

beforeEach(() => vi.resetAllMocks());

describe("Git diff model ownership", () => {
  it("retains both private models and releases each reference only once", async () => {
    const original = model("original"),
      modified = model("modified");
    const before = { dispose: vi.fn() },
      after = { dispose: vi.fn() };
    vi.mocked(monaco.editor.createModel)
      .mockReturnValueOnce(original)
      .mockReturnValueOnce(modified);
    vi.mocked(createModelReference)
      .mockResolvedValueOnce(before as never)
      .mockResolvedValueOnce(after as never);
    const pair = await createGitDiffModels(content, "plaintext");
    expect(pair).toMatchObject({ original, modified });
    expect(vi.mocked(createModelReference).mock.calls).toEqual([[original.uri], [modified.uri]]);
    expect(before.dispose).not.toHaveBeenCalled();
    pair.dispose();
    pair.dispose();
    expect(before.dispose).toHaveBeenCalledTimes(1);
    expect(after.dispose).toHaveBeenCalledTimes(1);
    expect(original.dispose).not.toHaveBeenCalled();
    expect(modified.dispose).not.toHaveBeenCalled();
  });

  it("leaves the shared working-tree model under document ownership", async () => {
    const original = model("original"),
      shared = model("source");
    const reference = { dispose: vi.fn() };
    vi.mocked(monaco.editor.createModel).mockReturnValue(original);
    vi.mocked(createModelReference).mockResolvedValue(reference as never);
    const pair = await createGitDiffModels(content, "plaintext", shared);
    expect(pair.modified).toBe(shared);
    expect(monaco.editor.createModel).toHaveBeenCalledTimes(1);
    expect(createModelReference).toHaveBeenCalledTimes(1);
    pair.dispose();
    expect(reference.dispose).toHaveBeenCalledTimes(1);
    expect(shared.dispose).not.toHaveBeenCalled();
  });

  it("releases partial initialization when the second reference fails", async () => {
    const original = model("original"),
      modified = model("modified");
    const reference = { dispose: vi.fn() };
    vi.mocked(monaco.editor.createModel)
      .mockReturnValueOnce(original)
      .mockReturnValueOnce(modified);
    vi.mocked(createModelReference)
      .mockResolvedValueOnce(reference as never)
      .mockRejectedValueOnce(new Error("resolve failed"));
    await expect(createGitDiffModels(content, "plaintext")).rejects.toThrow("resolve failed");
    expect(reference.dispose).toHaveBeenCalledTimes(1);
    expect(original.dispose).not.toHaveBeenCalled();
    expect(modified.dispose).toHaveBeenCalledTimes(1);
  });

  it("releases both raw models when the first reference fails", async () => {
    const original = model("original"),
      modified = model("modified");
    vi.mocked(monaco.editor.createModel)
      .mockReturnValueOnce(original)
      .mockReturnValueOnce(modified);
    vi.mocked(createModelReference).mockRejectedValueOnce(new Error("resolve failed"));
    await expect(createGitDiffModels(content, "plaintext")).rejects.toThrow("resolve failed");
    expect(original.dispose).toHaveBeenCalledTimes(1);
    expect(modified.dispose).toHaveBeenCalledTimes(1);
  });

  it("releases the first model if creating the second model fails", async () => {
    const original = model("original");
    vi.mocked(monaco.editor.createModel)
      .mockReturnValueOnce(original)
      .mockImplementationOnce(() => {
        throw new Error("create failed");
      });
    await expect(createGitDiffModels(content, "plaintext")).rejects.toThrow("create failed");
    expect(original.dispose).toHaveBeenCalledTimes(1);
  });
});
