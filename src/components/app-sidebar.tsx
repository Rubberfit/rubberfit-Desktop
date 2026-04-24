import { Grid3x3, Layers } from "lucide-react"
import { NavLink } from "react-router-dom"
import { cn } from "@/lib/utils"

interface NavItem {
  to: string
  label: string
  Icon: typeof Layers
}

const NAV_ITEMS: NavItem[] = [
  { to: "/auto-nest", label: "Auto Nest", Icon: Layers },
  { to: "/free-roam", label: "Free Roam", Icon: Grid3x3 },
]

export function AppSidebar() {
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
        <div className="size-6 rounded bg-sidebar-primary" />
        <span className="text-sm font-semibold tracking-tight">RubberFit</span>
      </div>
      <nav className="flex-1 space-y-1 p-2">
        {NAV_ITEMS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-primary text-sidebar-primary-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )
            }
          >
            <Icon className="size-4 shrink-0" />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-sidebar-border px-4 py-3 text-xs text-muted-foreground">
        v0.1.0
      </div>
    </aside>
  )
}
