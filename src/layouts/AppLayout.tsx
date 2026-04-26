import { Outlet } from "react-router-dom"
import { AppSidebar } from "@/components/app-sidebar"

export function AppLayout() {
  return (
    <div className="flex h-full w-full bg-background text-foreground">
      <AppSidebar />
      <main className="flex-1 overflow-y-auto overflow-x-hidden p-8">
        <Outlet />
      </main>
    </div>
  )
}
