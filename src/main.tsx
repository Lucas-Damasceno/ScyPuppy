import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";

async function bootstrap() {
  if (import.meta.env.DEV) {
    const { installDocsPreview } = await import("./dev/docsPreview");
    installDocsPreview();
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
