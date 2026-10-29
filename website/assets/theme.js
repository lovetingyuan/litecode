// Run before the stylesheet so a remembered dark theme never flashes light.
(() => {
  let preference = "system";
  try {
    const saved = localStorage.getItem("litecode-theme");
    if (["light", "dark", "system"].includes(saved)) { preference = saved; }
  } catch { /* Browsing with storage disabled still supports themes. */ }
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = preference === "system" ? (dark ? "dark" : "light") : preference;
  document.documentElement.dataset.themePreference = preference;
})();
