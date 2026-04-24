import { Outlet } from "react-router-dom"
import { AppSidebar } from "@/components/app-sidebar"

export function AppLayout() {
  return (
    <div className="flex h-screen w-screen bg-background text-foreground">
      <AppSidebar />
      <main className="flex-1 overflow-auto p-8">
        <Outlet />
      </main>
    </div>
  )
}
