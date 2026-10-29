import { describe, expect, it } from "vitest";
import { preferredRemoteUrl, remoteWebUrl } from "./remotes";

describe("remoteWebUrl", () => {
  it.each([
    ["https://github.com/owner/repo.git", "https://github.com/owner/repo"],
    ["http://git.example.com:8080/group/repo.git/", "http://git.example.com:8080/group/repo"],
    ["https://user:password@git.example.com/group/repo", "https://git.example.com/group/repo"],
    ["git@github.com:owner/repo.git", "https://github.com/owner/repo"],
    ["user@git.example.com:group/subgroup/repo.git", "https://git.example.com/group/subgroup/repo"],
    ["ssh://git@git.example.com:2222/group/repo.git", "https://git.example.com/group/repo"],
    ["ssh://git@[::1]:2222/group/repo.git", "https://[::1]/group/repo"],
    [" https://github.com/owner/repo.git ", "https://github.com/owner/repo"],
    [
      "https://dev.azure.com/team/project/_git/repo",
      "https://dev.azure.com/team/project/_git/repo",
    ],
  ])("converts %s to a browser address", (address, expected) => {
    expect(remoteWebUrl(address)).toBe(expected);
  });

  it.each([
    null,
    "",
    " ",
    "not a url",
    "C:/repos/repo.git",
    "C:repo.git",
    "\\\\server\\repo.git",
    "/tmp/repo.git",
    "../repo.git",
    "file:///tmp/repo.git",
    "git://git.example.com/repo.git",
    "javascript:alert(1)",
    "data:text/html,hello",
    "mailto:user@example.com",
    "https://",
    "https://github.com/",
    "ssh://git@host/",
    "https:github.com/owner/repo",
    "ftp://host/repo.git",
  ])("rejects unsupported or invalid address %s", (address) => {
    expect(remoteWebUrl(address)).toBeNull();
  });
});

const remote = (name: string, fetch: string | null, push: string | null = null) => ({
  name,
  fetch,
  push,
});
const origin = remote("origin", "https://github.com/me/repo.git");
const upstream = remote("upstream", "git@github.com:team/repo.git");

describe("preferredRemoteUrl", () => {
  it("prefers the current branch's upstream remote", () => {
    expect(preferredRemoteUrl({ remotes: [origin, upstream], upstream: "upstream/main" })).toBe(
      "https://github.com/team/repo",
    );
  });
  it("prefers origin without a usable upstream", () => {
    expect(preferredRemoteUrl({ remotes: [upstream, origin], upstream: "missing/main" })).toBe(
      "https://github.com/me/repo",
    );
  });
  it("falls back to the first usable remote", () => {
    expect(
      preferredRemoteUrl({
        remotes: [remote("local", "C:/repo"), upstream],
        upstream: null,
      }),
    ).toBe("https://github.com/team/repo");
  });
  it("skips a preferred remote with no web address", () => {
    expect(
      preferredRemoteUrl({
        remotes: [origin, remote("local", "/tmp/repo")],
        upstream: "local/main",
      }),
    ).toBe("https://github.com/me/repo");
  });
  it("prefers fetch over push, with push as a fallback", () => {
    expect(
      preferredRemoteUrl({
        remotes: [remote("origin", origin.fetch, upstream.fetch)],
        upstream: null,
      }),
    ).toBe("https://github.com/me/repo");
    expect(
      preferredRemoteUrl({
        remotes: [remote("origin", "/tmp/repo", upstream.fetch)],
        upstream: null,
      }),
    ).toBe("https://github.com/team/repo");
  });
  it("matches the full remote name when names contain slashes", () => {
    expect(
      preferredRemoteUrl({
        remotes: [remote("team", origin.fetch), remote("team/fork", upstream.fetch)],
        upstream: "team/fork/main",
      }),
    ).toBe("https://github.com/team/repo");
  });
  it("returns no target while loading, without remotes, or without usable addresses", () => {
    expect(preferredRemoteUrl(null)).toBeNull();
    expect(preferredRemoteUrl({ remotes: [], upstream: null })).toBeNull();
    expect(preferredRemoteUrl({ remotes: [remote("origin", null)], upstream: null })).toBeNull();
  });
});
