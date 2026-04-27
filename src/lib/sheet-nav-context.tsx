// Cross-cutting registry for "currently rendered packed sheets".
// AutoNest publishes one entry per sheet card after the pack gate
// flips to "done"; AppSidebar consumes the list and renders clickable
// jump-to-sheet links so operators can navigate a tall multi-sheet
// graph without manually scrolling.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"

export interface SheetNavEntry {
  /** DOM id of the sheet container; passed to scrollIntoView. */
  id: string
  /** Sidebar label, e.g. "Sheet 1 of 3" or "Offcut from Sheet 2 (24" × 18")". */
  label: string
  /** Drives the icon / grouping in the sidebar. */
  kind: "standard" | "offcut-extract"
}

interface SheetNavContextValue {
  entries: SheetNavEntry[]
  /** Called by pages/components that own a packed graph — overwrites the registry. */
  publish: (entries: SheetNavEntry[]) => void
  /** Smooth-scrolls the document to the sheet container with this id, if present. */
  scrollTo: (id: string) => void
}

const SheetNavContext = createContext<SheetNavContextValue | null>(null)

export function SheetNavProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<SheetNavEntry[]>([])

  const publish = useCallback((next: SheetNavEntry[]) => {
    setEntries((prev) => (sameEntries(prev, next) ? prev : next))
  }, [])

  const scrollTo = useCallback((id: string) => {
    const el = document.getElementById(id)
    if (!el) return
    el.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [])

  const value = useMemo<SheetNavContextValue>(
    () => ({ entries, publish, scrollTo }),
    [entries, publish, scrollTo]
  )
  return <SheetNavContext.Provider value={value}>{children}</SheetNavContext.Provider>
}

export function useSheetNav(): SheetNavContextValue {
  const ctx = useContext(SheetNavContext)
  if (!ctx) {
    throw new Error("useSheetNav must be called inside <SheetNavProvider>.")
  }
  return ctx
}

function sameEntries(a: SheetNavEntry[], b: SheetNavEntry[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].label !== b[i].label || a[i].kind !== b[i].kind) return false
  }
  return true
}
