import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Portal from "./Portal";
import Connect from "./Connect";
import "./styles.css";

const RootApp = window.location.pathname.startsWith("/connect")
  ? Connect
  : window.location.pathname.startsWith("/portal") ? Portal : App;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootApp />
  </StrictMode>,
);
