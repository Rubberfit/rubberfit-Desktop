import { HashRouter, Navigate, Route, Routes } from "react-router-dom"
import { AppLayout } from "@/layouts/AppLayout"
import { AutoNestPage } from "@/pages/AutoNest"
import { FreeRoamPage } from "@/pages/FreeRoam"

function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Navigate to="/auto-nest" replace />} />
          <Route path="/auto-nest" element={<AutoNestPage />} />
          <Route path="/free-roam" element={<FreeRoamPage />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}

export default App
