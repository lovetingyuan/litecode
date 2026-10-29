// Resolve the default entry before CSS loads. Explicit language URLs stay usable.
(() => {
  const key = "litecode-language";
  const current = document.documentElement.lang.toLowerCase().startsWith("zh") ? "zh" : "en";
  const valid = (value) => value === "zh" || value === "en";
  const remember = (language) => {
    try {
      localStorage.setItem(key, language);
    } catch {
      /* URL intent also works without storage. */
    }
  };
  const requested = new URLSearchParams(location.search).get("lang");
  const explicit = valid(requested) ? requested : null;
  if (explicit) {
    remember(explicit);
  }

  // Native links, including new tabs and JavaScript-off visits, carry the intent.
  document.addEventListener("DOMContentLoaded", () => {
    const link = document.querySelector(".language-link");
    if (!link) {
      return;
    }
    const language = link.hreflang.toLowerCase().startsWith("zh") ? "zh" : "en";
    const updateLink = () => {
      const target = new URL(link.href);
      target.search = location.search;
      target.searchParams.set("lang", language);
      target.hash = location.hash;
      link.href = target.href;
    };
    updateLink();
    addEventListener("hashchange", updateLink);
    addEventListener("pageshow", updateLink);
    link.addEventListener("click", () => {
      updateLink();
      remember(language);
    });
  });

  // Leave static language documents in place for common search/share crawlers.
  if (/bot|crawler|spider|slurp|facebookexternalhit/i.test(navigator.userAgent)) {
    return;
  }
  if (!explicit && current === "en") {
    return;
  }
  if (!/^https?:$/.test(location.protocol)) {
    return;
  }

  let preferred = explicit;
  if (!preferred) {
    try {
      const saved = localStorage.getItem(key);
      if (valid(saved)) {
        preferred = saved;
      }
    } catch {
      /* Private browsing may deny all storage access. */
    }
  }
  if (!preferred) {
    const languages = [...(navigator.languages || []), navigator.language];
    for (const language of languages) {
      if (typeof language !== "string") {
        continue;
      }
      const match = /^(zh|en)(?:-|$)/i.exec(language.trim().replaceAll("_", "-"));
      if (match) {
        preferred = match[1].toLowerCase();
        break;
      }
    }
  }
  preferred ||= "en";
  if (preferred === current) {
    return;
  }

  // Script-relative URLs support /, /litecode/, index.html, and custom domains.
  const base = new URL("../", document.currentScript.src);
  const target = new URL(preferred === "zh" ? "./" : "en/", base);
  target.search = location.search;
  target.hash = location.hash;
  location.replace(target.href);
})();
