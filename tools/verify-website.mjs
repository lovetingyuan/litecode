import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve("website");
const output = path.resolve(".verification/website-review");
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
    if (pathname.startsWith("/litecode/")) pathname = pathname.slice("/litecode".length);
    let file = path.resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
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
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  page.on("request", (request) => {
    if (!request.url().startsWith(base))
      errors.push(`Unexpected external request: ${request.url()}`);
  });

  for (const prefix of ["/", "/litecode/"]) {
    for (const language of ["", "en/"]) {
      await page.goto(base + prefix + language);
      const lang = language ? "en" : "zh-CN";
      assert.equal(await page.getAttribute("html", "lang"), lang);
      assert.equal(await page.locator("h1").count(), 1);
      assert.equal(await page.locator(".feature").count(), 5);
      assert.equal(await page.locator(".getting-started, #faq, a[href='#faq']").count(), 0);
      assert.equal(
        await page.getAttribute('link[rel="canonical"]', "href"),
        `https://litecode.tingyuan.in/${language}`,
      );
      assert.equal(await page.locator('link[rel="alternate"][hreflang]').count(), 3);
      const schema = JSON.parse(
        await page.locator('script[type="application/ld+json"]').textContent(),
      );
      assert.equal(schema.operatingSystem, "Windows 11 x64");
      assert.equal(schema.downloadUrl, "https://github.com/lovetingyuan/litecode/releases");
      assert.ok((await page.getAttribute('meta[name="description"]', "content")).length > 40);
      const downloads = await page
        .locator(".button-primary")
        .evaluateAll((nodes) => nodes.map((node) => node.href));
      assert.deepEqual(
        downloads,
        Array(2).fill("https://github.com/lovetingyuan/litecode/releases"),
      );
      const resources = await page
        .locator(
          'img, script[src], link[rel="stylesheet"], link[rel="icon"], link[rel="apple-touch-icon"]',
        )
        .evaluateAll((nodes) => nodes.map((node) => node.src || node.href));
      for (const resource of resources) assert.equal((await fetch(resource)).status, 200, resource);
      for (const link of await page
        .locator('a[href^="#"]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href").slice(1))))
        assert.equal(await page.locator(`[id="${link}"]`).count(), 1, `Anchor ${link}`);
      const alternate = await page.getAttribute(".language-link", "href");
      assert.equal((await fetch(new URL(alternate, page.url()))).status, 200);

      for (const width of [360, 768, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const theme of ["light", "dark"]) {
          await page.locator("#theme").selectOption(theme);
          assert.equal(await page.getAttribute("html", "data-theme"), theme);
          assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            `${lang} ${width} ${theme} overflows`,
          );
        }
      }
      await page.reload();
      assert.equal(await page.locator("#theme").inputValue(), "dark");
      await page.locator("#theme").selectOption("system");
      await page.emulateMedia({ colorScheme: "light" });
      await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
      checks.push(
        `${prefix + language}: metadata, links, assets, 360/768/1440px, explicit/system/persisted themes`,
      );
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + "/en/");
  await page.locator(".menu-toggle").click();
  assert.equal(await page.getAttribute(".menu-toggle", "aria-expanded"), "true");
  assert.ok(await page.locator("#navigation").isVisible());
  await page.keyboard.press("Escape");
  assert.equal(await page.getAttribute(".menu-toggle", "aria-expanded"), "false");
  assert.ok(await page.locator(".menu-toggle").evaluate((node) => node === document.activeElement));
  await page.locator(".menu-toggle").click();
  await page.locator('#navigation a[href="#features"]').click();
  assert.equal(await page.getAttribute(".menu-toggle", "aria-expanded"), "false");
  await page.goto(base + "/");
  await page.keyboard.press("Tab");
  assert.ok(await page.locator(".skip-link").evaluate((node) => node === document.activeElement));
  await page.keyboard.press("Enter");
  assert.ok(page.url().endsWith("#main"));
  assert.equal(await page.locator(".is-pending").count(), 0);
  checks.push(
    "Mobile menu, Escape/focus return, section navigation, keyboard skip link, reduced motion",
  );

  const noScript = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
  });
  const plain = await noScript.newPage();
  for (const language of ["", "en/"]) {
    await plain.goto(base + "/" + language);
    assert.ok(await plain.locator("h1").isVisible());
    assert.ok(await plain.locator("#navigation").isVisible());
    assert.equal(await plain.locator(".feature").count(), 5);
    assert.equal(await plain.locator(".is-pending").count(), 0);
    assert.ok(await plain.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await noScript.close();
  const blocked = await browser.newContext({ locale: "zh-CN", colorScheme: "light" });
  await blocked.addInitScript(() =>
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Storage disabled", "SecurityError");
      },
    }),
  );
  const privatePage = await blocked.newPage();
  privatePage.on("pageerror", (error) => errors.push(String(error)));
  await privatePage.goto(base + "/");
  await privatePage.locator("#theme").selectOption("dark");
  assert.equal(await privatePage.getAttribute("html", "data-theme"), "dark");
  await blocked.close();
  checks.push("Both languages without JavaScript; themes with local storage blocked");

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
        if (request.isNavigationRequest()) navigations++;
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

  for (const [name, language, width, theme] of [
    ["desktop", "", 1440, "light"],
    ["desktop-dark", "", 1440, "dark"],
    ["tablet", "en/", 768, "light"],
    ["mobile", "", 390, "light"],
    ["mobile-en-dark", "en/", 390, "dark"],
  ]) {
    await page.setViewportSize({ width, height: width > 760 ? 1000 : 844 });
    await page.goto(base + "/" + language);
    await page.locator("#theme").selectOption(theme);
    // Load lazy images before a full-page capture and verify real image dimensions.
    await page
      .locator("img")
      .evaluateAll((images) => images.forEach((image) => (image.loading = "eager")));
    await page.waitForFunction(() =>
      [...document.images].every((image) => image.complete && image.naturalWidth > 0),
    );
    await page.evaluate(() => document.fonts.ready);
    await page
      .locator("img")
      .evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
    // Chromium may defer painting decoded offscreen images. Visit every real
    // screenshot before capturing the whole page, rather than certifying blanks.
    for (const image of await page.locator(".screenshot img").all()) {
      await image.scrollIntoViewIfNeeded();
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    }
    await page.evaluate(() => scrollTo(0, 0));
    const images = await page
      .locator(".screenshot img")
      .evaluateAll((nodes) => nodes.map((image) => [image.naturalWidth, image.naturalHeight]));
    assert.deepEqual(
      images,
      Array.from({ length: 6 }, () => [1280, 820]),
    );
    await page.screenshot({ path: path.join(output, name + ".png"), fullPage: true });
    if (name === "desktop" || name === "mobile")
      await page.screenshot({ path: path.join(output, name + "-viewport.png") });
  }
  const sitemap = await readFile(path.join(root, "sitemap.xml"), "utf8");
  assert.equal((sitemap.match(/<loc>/g) || []).length, 2);
  assert.match(
    await readFile(path.join(root, "robots.txt"), "utf8"),
    /Sitemap: https:\/\/litecode.tingyuan.in\/sitemap.xml/,
  );
  const missing = await fetch(base + "/nested/missing/page");
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /https:\/\/litecode.tingyuan.in\/en\//);
  checks.push(
    "Five visual captures, six real 1280×820 images per page, sitemap/robots and nested 404",
  );
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, "results.json"), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors, output }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
