import { startupMark, waitForStartupPaint } from "./core/startup";

startupMark("entry-evaluated");

document.addEventListener("contextmenu", (event) => event.preventDefault());

async function start() {
  // Let the HTML spinner paint before importing the workbench's JS and CSS.
  // A static import would load/evaluate Monaco before this entry point can run.
  await waitForStartupPaint();
  startupMark("loading-painted");
  await import("./workbench");
  startupMark("workbench-module-loaded");
}

void start().catch((error: unknown) => {
  startupMark("failed");
  console.error("Could not start LiteCode", error);
  const loading = document.querySelector(".startup-loading");
  if (loading) {
    loading.classList.add("startup-failed");
    loading.setAttribute("role", "alert");
    loading.removeAttribute("aria-label");
    const message = document.createElement("p");
    message.textContent = "Could not start LiteCode. Please reload to try again.";
    const reload = document.createElement("button");
    reload.textContent = "Reload";
    reload.onclick = () => location.reload();
    loading.append(message, reload);
  }
});
