import type { GitInfo } from "../types/types";

export function commitWebUrl(
  info: Pick<GitInfo, "remotes" | "upstream"> | null,
  sha: string,
): string | null {
  const address = preferredRemoteUrl(info);
  if (!address || !/^[a-f\d]{40}$/i.test(sha)) {
    return null;
  }
  const url = new URL(address);
  let path: string;
  switch (url.hostname) {
    case "github.com":
    case "gitee.com":
      path = "commit";
      break;
    case "gitlab.com":
      path = "-/commit";
      break;
    case "bitbucket.org":
      path = "commits";
      break;
    default:
      return null;
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path}/${sha}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

export function remoteWebUrl(address: string | null): string | null {
  if (!address) {
    return null;
  }
  const value = address.trim();
  // A drive letter or filesystem path is not an scp-style Git remote.
  if (/^[a-z]:/i.test(value) || value.includes("\\")) {
    return null;
  }
  const scp = !value.includes("://") && value.match(/^[^@/:\s]+@([^/:\s]+):([^\s]+)$/);
  if (!scp && !/^(?:https?|ssh):\/\//i.test(value)) {
    return null;
  }
  try {
    let url = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : value);
    if (
      !["http:", "https:", "ssh:"].includes(url.protocol) ||
      !url.hostname ||
      !url.pathname.replace(/^\/+|\/+$/g, "")
    ) {
      return null;
    }
    if (url.protocol === "ssh:") {
      // SSH transport ports do not identify the web server's port.
      url = new URL(`https://${url.hostname}${url.pathname}`);
    }
    url.username = "";
    url.password = "";
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
    return url.href;
  } catch {
    return null;
  }
}

export function preferredRemoteUrl(
  info: Pick<GitInfo, "remotes" | "upstream"> | null,
): string | null {
  if (!info) {
    return null;
  }
  const upstream = info.remotes
    .filter((remote) => info.upstream?.startsWith(`${remote.name}/`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  const origin = info.remotes.find((remote) => remote.name === "origin");
  for (const remote of [upstream, origin, ...info.remotes]) {
    if (remote) {
      const url = remoteWebUrl(remote.fetch) ?? remoteWebUrl(remote.push);
      if (url) {
        return url;
      }
    }
  }
  return null;
}
