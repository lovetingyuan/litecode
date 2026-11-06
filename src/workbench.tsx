import ReactDOM from "react-dom/client";
import App from "./components/App";
import { logError } from "./core/logging";
import { FileIconSprite } from "./components/ui";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement, {
  onUncaughtError: (error, info) =>
    logError("react_uncaught_error", error, { stack: info.componentStack ?? undefined }),
  onCaughtError: (error, info) =>
    logError("react_caught_error", error, { stack: info.componentStack ?? undefined }),
  onRecoverableError: (error, info) =>
    logError("react_recoverable_error", error, { stack: info.componentStack ?? undefined }),
}).render(
  <>
    <FileIconSprite />
    <App />
  </>,
);
