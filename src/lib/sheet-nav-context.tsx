// Cross-cutting registry for "currently rendered Auto Nest anchors".
// AutoNest publishes page sections plus one entry per packed sheet after
// the pack gate flips to "done"; AppSidebar consumes those lists and
// renders clickable jump links so operators can navigate a tall job
// without manually scrolling.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"

export interface SheetNavEntry {
  /** DOM id of the sheet container; passed to scrollIntoView. */
  id: string
  /** Sidebar label, e.g. "Sheet 1 of 3" or "Offcut from Sheet 2 (24" × 18")". */
  label: string
  /** Drives the icon / grouping in the sidebar. */
  kind: "standard" | "offcut-extract"
}

export interface SectionNavEntry {
  /** DOM id of the Auto Nest section container; passed to scrollIntoView. */
  id: string
  /** Sidebar label, e.g. "Stock" or "Graph". */
  label: string
  /** Drives the icon in the sidebar. */
  kind: "upload" | "stock" | "parts" | "settings" | "graph" | "offcuts"
}

interface SheetNavContextValue {
  entries: SheetNavEntry[]
  sections: SectionNavEntry[]
  /** Called by pages/components that own a packed graph — overwrites the registry. */
  publish: (entries: SheetNavEntry[]) => void
  /** Called by pages/components that own page section anchors. */
  publishSections: (entries: SectionNavEntry[]) => void
  /** Smooth-scrolls the document to the sheet container with this id, if present. */
  scrollTo: (id: string) => void
}

const SheetNavContext = createContext<SheetNavContextValue | null>(null)

export function SheetNavProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<SheetNavEntry[]>([])
  const [sections, setSections] = useState<SectionNavEntry[]>([])

  const publish = useCallback((next: SheetNavEntry[]) => {
    setEntries((prev) => (sameNavEntries(prev, next) ? prev : next))
  }, [])

  const publishSections = useCallback((next: SectionNavEntry[]) => {
    setSections((prev) => (sameNavEntries(prev, next) ? prev : next))
  }, [])

  const scrollTo = useCallback((id: string) => {
    const el = document.getElementById(id)
    if (!el) return
    el.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [])

  const value = useMemo<SheetNavContextValue>(
    () => ({ entries, sections, publish, publishSections, scrollTo }),
    [entries, sections, publish, publishSections, scrollTo]
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

function sameNavEntries<T extends { id: string; label: string; kind: string }>(
  a: T[],
  b: T[]
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].label !== b[i].label || a[i].kind !== b[i].kind) return false
  }
  return true
}
