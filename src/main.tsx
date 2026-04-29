import React from "react"
import ReactDOM from "react-dom/client"
import { invoke } from "@tauri-apps/api/core"
import App from "./App"
import "./index.css"

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

requestAnimationFrame(() => {
  invoke("close_splashscreen").catch(() => {})
})
