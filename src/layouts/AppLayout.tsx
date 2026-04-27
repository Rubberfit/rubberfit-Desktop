import { Outlet } from "react-router-dom"
import { AppSidebar } from "@/components/app-sidebar"
import { SheetNavProvider } from "@/lib/sheet-nav-context"

export function AppLayout() {
  return (
    <SheetNavProvider>
      <div className="flex h-full w-full bg-background text-foreground">
        <AppSidebar />
        <main className="flex-1 overflow-y-auto overflow-x-hidden p-8">
          <Outlet />
        </main>
      </div>
    </SheetNavProvider>
  )
}
