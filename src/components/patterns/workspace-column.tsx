import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * WorkspaceColumn — single column inside a `PageShell variant="workspace"`
 * layout. Composes three ways: `left` (fixed ~320px rail),
 * `center` (flex-1 canvas), `right` (fixed ~340px rail). Any
 * three-column editor surface — cutting engine, future free-roam
 * CAD, side-by-side diff viewer — uses these.
 *
 * The component is intentionally minimal: it only picks a width
 * + a vertical overflow mode. Internal content (headers, panels,
 * toolbars) uses regular shadcn/pattern-library components.
 *
 * **Rail vs canvas width:** fixed 320 / 340 px on `left` / `right`
 * matches the user-approved cutting-engine mock. The numbers are
 * not tokens because they're layout constants, not design tokens
 * — if they change, they change per-surface.
 */
const workspaceColumnVariants = cva("flex min-h-0 flex-col border-border-subtle bg-background", {
  variants: {
    column: {
      left: "w-[320px] shrink-0 border-r",
      center: "flex-1 min-w-0 overflow-hidden",
      right: "w-[340px] shrink-0 border-l",
    },
    scroll: {
      // Most panels want scrollable content, but the canvas
      // column almost always owns its own overflow (Konva stage
      // renders into fixed bounds). Leave it off by default.
      none: "overflow-hidden",
      y: "overflow-y-auto",
    },
  },
  defaultVariants: {
    scroll: "none",
  },
})

export interface WorkspaceColumnProps
  extends React.ComponentProps<"div">, VariantProps<typeof workspaceColumnVariants> {}

export function WorkspaceColumn({ className, column, scroll, ...props }: WorkspaceColumnProps) {
  // Default to the canvas column so the caller picks up the
  // `flex-1 min-w-0 overflow-hidden` width class instead of rendering
  // a zero-width element when `column` is omitted. Earlier revision
  // fell through to no class selection — flagged by CodeRabbit as a
  // false-default.
  const resolvedColumn = column ?? "center"
  return (
    <div
      data-slot="workspace-column"
      data-column={resolvedColumn}
      className={cn(workspaceColumnVariants({ column: resolvedColumn, scroll }), className)}
      {...props}
    />
  )
}

/**
 * WorkspaceRow — horizontal flex wrapper that holds three
 * `WorkspaceColumn` children. A separate component (rather than
 * a wrapper div inline in each page) so future changes to
 * column-gap, border behaviour, or responsive collapse land in
 * one place.
 */
export function WorkspaceRow({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="workspace-row" className={cn("flex min-h-0 flex-1", className)} {...props} />
  )
}
