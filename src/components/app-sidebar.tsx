import { FileStack, Grid3x3, Layers, Recycle, Ruler, Settings2, Shapes, Upload } from "lucide-react"
import { NavLink } from "react-router-dom"
import { cn } from "@/lib/utils"
import { useSheetNav, type SectionNavEntry } from "@/lib/sheet-nav-context"

interface NavItem {
  to: string
  label: string
  Icon: typeof Layers
}

const NAV_ITEMS: NavItem[] = [
  { to: "/auto-nest", label: "Auto Nest", Icon: Layers },
  { to: "/free-roam", label: "Free Roam", Icon: Grid3x3 },
]

const SECTION_ICONS: Record<SectionNavEntry["kind"], typeof Layers> = {
  upload: Upload,
  stock: Ruler,
  parts: Shapes,
  settings: Settings2,
  graph: Layers,
  offcuts: Recycle,
}

export function AppSidebar() {
  const { entries, sections, scrollTo } = useSheetNav()
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
        <div className="size-6 rounded bg-sidebar-primary" />
        <span className="text-sm font-semibold tracking-tight">RubberFit</span>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
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
        {sections.length > 0 && (
          <div className="pt-4">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Sections
            </div>
            <div className="space-y-0.5">
              {sections.map((section) => {
                const Icon = SECTION_ICONS[section.kind]
                return (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => scrollTo(section.id)}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  >
                    <Icon className="size-3.5 shrink-0" />
                    <span className="truncate" title={section.label}>
                      {section.label}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
        {entries.length > 0 && (
          <div className="pt-4">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Sheets
            </div>
            <div className="space-y-0.5">
              {entries.map((e) => {
                const Icon = e.kind === "offcut-extract" ? Recycle : FileStack
                return (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => scrollTo(e.id)}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  >
                    <Icon
                      className={cn(
                        "size-3.5 shrink-0",
                        e.kind === "offcut-extract" ? "text-amber-600" : ""
                      )}
                    />
                    <span className="truncate" title={e.label}>
                      {e.label}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </nav>
      <div className="border-t border-sidebar-border px-4 py-3 text-xs text-muted-foreground">
        v0.1.0
      </div>
    </aside>
  )
}
