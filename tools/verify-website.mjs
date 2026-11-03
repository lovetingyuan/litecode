import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve("website");
const output = path.resolve("tmp/verification/website");
await mkdir(output, { recursive: true });
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
  ".txt": "text/plain",
};
const server = createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pathname.startsWith("/litecode/")) {
      pathname = pathname.slice("/litecode".length);
    }
    let file = path.resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    if ((await stat(file)).isDirectory()) {
      file = path.join(file, "index.html");
    }
    res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(await readFile(path.join(root, "404.html")));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
// Use the repository's existing Playwright dependency and an installed browser.
let executablePath = process.env.WEBSITE_BROWSER;
if (!executablePath && process.platform === "win32") {
  for (const candidate of [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ]) {
    if (
      await access(candidate)
        .then(() => true)
        .catch(() => false)
    ) {
      executablePath = candidate;
      break;
    }
  }
}
let browser;
const checks = [],
  errors = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1440, height: 1000 },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on("request", (request) => {
    if (!request.url().startsWith(base)) {
      errors.push(`Unexpected external request: ${request.url()}`);
    }
  });

  for (const prefix of ["/", "/litecode/"]) {
    for (const language of ["", "en/"]) {
      await page.goto(base + prefix + language);
      const lang = language ? "en" : "zh-CN";
      assert.equal(await page.getAttribute("html", "lang"), lang);
      const resources = await page
        .locator(
          'img, script[src], link[rel="stylesheet"], link[rel="icon"], link[rel="apple-touch-icon"]',
        )
        .evaluateAll((nodes) => nodes.map((node) => node.src || node.href));
      for (const resource of resources) {
        assert.equal((await fetch(resource)).status, 200, resource);
      }
      for (const link of await page
        .locator('a[href^="#"]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href").slice(1)))) {
        assert.equal(await page.locator(`[id="${link}"]`).count(), 1, `Anchor ${link}`);
      }
      const alternate = await page.getAttribute(".language-link", "href");
      assert.equal((await fetch(new URL(alternate, page.url()))).status, 200);

      checks.push(`${prefix + language}: assets, anchors and language links`);
    }
  }

  const languageCases = [
    { languages: ["zh-CN"], expected: "zh" },
    { languages: ["zh-TW"], expected: "zh" },
    { languages: ["zh-Hant-HK"], expected: "zh" },
    { languages: ["ZH_hant_TW"], expected: "zh" },
    { languages: ["en-US"], expected: "en" },
    { languages: ["en-GB", "zh-CN"], expected: "en" },
    { languages: ["fr-FR", "zh-Hant", "en"], expected: "zh" },
    { languages: ["ja-JP", "de-DE"], expected: "en" },
    { languages: [], browserLanguage: "zh-MO", expected: "zh" },
    { languages: [null, "", "zhang", "english", "zh-SG"], expected: "zh" },
    { languages: ["en"], saved: "zh", expected: "zh" },
    { languages: ["zh"], saved: "en", expected: "en" },
    { languages: ["zh"], saved: "invalid", expected: "zh" },
    { languages: ["en"], saved: "en", query: "?lang=zh", expected: "zh" },
    { languages: ["zh"], saved: "zh", query: "?lang=en", expected: "en" },
    { languages: ["en"], query: "?lang=invalid", expected: "en" },
    { languages: ["en"], storageBlocked: true, expected: "en" },
    { languages: ["zh"], saved: "zh", route: "en/", expected: "en" },
    { languages: ["en"], route: "en/", query: "?lang=zh", expected: "zh" },
    { languages: ["en"], crawler: true, expected: "zh" },
  ];
  for (const prefix of ["/", "/litecode/"]) {
    for (const test of languageCases) {
      const languageContext = await browser.newContext({
        locale: "en-US",
        ...(test.crawler ? { userAgent: "Googlebot" } : {}),
      });
      await languageContext.addInitScript((options) => {
        Object.defineProperty(navigator, "languages", { get: () => options.languages });
        Object.defineProperty(navigator, "language", {
          get: () => options.browserLanguage || "fr-FR",
        });
        if (options.saved) {
          localStorage.setItem("litecode-language", options.saved);
        }
        if (options.storageBlocked) {
          Object.defineProperty(window, "localStorage", {
            get() {
              throw new DOMException("Storage disabled", "SecurityError");
            },
          });
        }
      }, test);
      const languagePage = await languageContext.newPage();
      languagePage.on("pageerror", (error) => errors.push(String(error)));
      let navigations = 0;
      languagePage.on("request", (request) => {
        if (request.isNavigationRequest()) {
          navigations++;
        }
      });
      const query = test.query || "?utm_source=language-check";
      await languagePage.goto(base + prefix + (test.route || "") + query + "#idea");
      const expectedPath = prefix + (test.expected === "en" ? "en/" : "");
      await languagePage.waitForURL((target) => target.pathname === expectedPath);
      assert.equal(
        await languagePage.getAttribute("html", "lang"),
        test.expected === "zh" ? "zh-CN" : "en",
        JSON.stringify(test),
      );
      assert.equal(new URL(languagePage.url()).search, query);
      assert.equal(new URL(languagePage.url()).hash, "#idea");
      assert.ok(navigations <= 2, `Language redirect loop: ${JSON.stringify(test)}`);
      await languageContext.close();
    }
  }
  checks.push(
    "40 real-browser language cases: region tags, ordered preferences, fallbacks, saved/URL intent, blocked storage, crawlers, subpaths, query/anchor preservation and no loops",
  );

  const manual = await browser.newContext({ locale: "en-US" });
  const manualPage = await manual.newPage();
  manualPage.on("pageerror", (error) => errors.push(String(error)));
  await manualPage.goto(base + "/litecode/index.html?source=manual#features");
  await manualPage.waitForURL(base + "/litecode/en/?source=manual#features");
  await manualPage.locator('#navigation a[href="#idea"]').click();
  await manualPage.waitForURL(base + "/litecode/en/?source=manual#idea");
  await manualPage.locator(".language-link").click();
  await manualPage.waitForURL(base + "/litecode/?source=manual&lang=zh#idea");
  await manualPage.goto(base + "/litecode/");
  assert.equal(await manualPage.getAttribute("html", "lang"), "zh-CN");
  await manualPage.locator(".language-link").click();
  await manualPage.waitForURL(base + "/litecode/en/?lang=en");
  await manualPage.goto(base + "/litecode/");
  await manualPage.waitForURL(base + "/litecode/en/");
  await manual.close();

  const noLanguageStorage = await browser.newContext({ locale: "en-US" });
  await noLanguageStorage.addInitScript(() =>
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Storage disabled", "SecurityError");
      },
    }),
  );
  const fallbackPage = await noLanguageStorage.newPage();
  fallbackPage.on("pageerror", (error) => errors.push(String(error)));
  await fallbackPage.goto(base + "/");
  await fallbackPage.waitForURL(base + "/en/");
  await fallbackPage.locator(".language-link").click();
  await fallbackPage.waitForURL(base + "/?lang=zh");
  await fallbackPage.reload();
  assert.equal(await fallbackPage.getAttribute("html", "lang"), "zh-CN");
  await noLanguageStorage.close();

  const staticLanguages = await browser.newContext({ locale: "en-US", javaScriptEnabled: false });
  const staticPage = await staticLanguages.newPage();
  await staticPage.goto(base + "/");
  assert.equal(await staticPage.getAttribute("html", "lang"), "zh-CN");
  await staticPage.locator(".language-link").click();
  assert.equal(await staticPage.getAttribute("html", "lang"), "en");
  await staticPage.locator(".language-link").click();
  assert.equal(await staticPage.getAttribute("html", "lang"), "zh-CN");
  await staticLanguages.close();
  checks.push(
    "Manual language switches persist, index.html selects correctly, storage-blocked switches survive reload, and native links switch both ways without JavaScript",
  );

  const sitemap = await readFile(path.join(root, "sitemap.xml"), "utf8");
  assert.equal((sitemap.match(/<loc>/g) || []).length, 2);
  assert.match(
    await readFile(path.join(root, "robots.txt"), "utf8"),
    /Sitemap: https:\/\/litecode.tingyuan.in\/sitemap.xml/,
  );
  const missing = await fetch(base + "/nested/missing/page");
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /https:\/\/litecode.tingyuan.in\/en\//);
  checks.push("Sitemap, robots and nested 404 routing");
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, "results.json"), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors, output }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
