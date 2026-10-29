(() => {
  const root = document.documentElement;
  const systemTheme = matchMedia("(prefers-color-scheme: dark)");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const theme = document.querySelector("#theme");
  const applyTheme = () => {
    root.dataset.theme =
      theme.value === "system" ? (systemTheme.matches ? "dark" : "light") : theme.value;
    root.dataset.themePreference = theme.value;
  };
  if (theme) {
    theme.value = root.dataset.themePreference || "system";
    theme.closest(".theme-control").hidden = false;
    theme.addEventListener("change", () => {
      applyTheme();
      try {
        localStorage.setItem("litecode-theme", theme.value);
      } catch {
        /* Optional persistence. */
      }
    });
    systemTheme.addEventListener("change", applyTheme);
  }

  const menuButton = document.querySelector(".menu-toggle");
  const menu = document.querySelector("#navigation");
  const closeMenu = () => {
    menuButton.setAttribute("aria-expanded", "false");
    document.body.classList.remove("menu-open");
  };
  if (menuButton && menu) {
    menuButton.hidden = false;
    root.classList.add("enhanced");
    menuButton.addEventListener("click", () => {
      const open = menuButton.getAttribute("aria-expanded") !== "true";
      menuButton.setAttribute("aria-expanded", String(open));
      document.body.classList.toggle("menu-open", open);
    });
    menu.addEventListener("click", (event) => {
      if (event.target.closest("a")) {
        closeMenu();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (!document.body.classList.contains("menu-open")) {
        return;
      }
      if (event.key === "Escape") {
        closeMenu();
        menuButton.focus();
      }
      if (event.key === "Tab") {
        const focusable = [
          ...document.querySelectorAll(".site-header a, .site-header select, .site-header button"),
        ].filter((element) => element.getClientRects().length);
        const first = focusable[0],
          last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });
    matchMedia("(min-width: 761px)").addEventListener("change", closeMenu);
  }

  // Everything is readable by default, including when JavaScript or observers fail.
  if ("IntersectionObserver" in window && !reducedMotion.matches) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.remove("is-pending");
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.08 },
    );
    for (const element of document.querySelectorAll("[data-reveal], .statement span")) {
      if (element.getBoundingClientRect().top > innerHeight) {
        element.classList.add("is-pending");
        observer.observe(element);
      }
    }
    reducedMotion.addEventListener("change", () => {
      if (reducedMotion.matches) {
        observer.disconnect();
        document
          .querySelectorAll(".is-pending")
          .forEach((element) => element.classList.remove("is-pending"));
      }
    });
  }
})();
