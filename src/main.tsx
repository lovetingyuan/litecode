import ReactDOM from "react-dom/client";
import App from "./components/App";

document.addEventListener("contextmenu", (event) => event.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
