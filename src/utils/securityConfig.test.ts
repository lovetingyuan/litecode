import { describe, expect, it } from "vitest";
import config from "../../src-tauri/tauri.conf.json";

describe("application CSP", () => {
  it("keeps the development server out of the production policy", () => {
    const { csp, devCsp } = config.app.security;
    expect(csp).not.toContain("localhost:1420");
    expect(devCsp).toContain("http://localhost:1420");
    expect(devCsp).toContain("ws://localhost:1420");
    expect(csp).toContain("ipc: http://ipc.localhost");
  });

  it("restricts HTTP images to the local media protocol", () => {
    for (const policy of [config.app.security.csp, config.app.security.devCsp]) {
      const images = policy.split(";").find((directive) => directive.trim().startsWith("img-src"))!.trim().split(/\s+/);
      expect(images).not.toContain("http:");
      expect(images).toContain("http://media.localhost");
      expect(images).toContain("https:");
    }
  });
});
