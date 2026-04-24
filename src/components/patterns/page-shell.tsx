import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * PageShell — top-level layout wrapper every dashboard surface
 * uses. Picks a max-width variant matched to the content type:
 *
 *   - `overview`  (default, 1600px): KPI-dense landing pages,
 *     analytics dashboards, anything with wide multi-column rows.
 *   - `dense`     (1800px): rollups with wide tables where every
 *     pixel of horizontal space earns its keep (jobs list,
 *     purchase-orders master).
 *   - `form`      (760px): single-column forms, settings,
 *     account. Narrow on purpose.
 *   - `workspace` (fluid, full viewport): three-column editor
 *     surfaces that own the whole viewport minus the sidebar —
 *     cutting engine, future free-roam CAD. No max-width cap,
 *     no inner padding; `WorkspaceColumn` children paint
 *     edge-to-edge and own their own gutters.
 *
 * Rationale: centralized widths prevent each surface from picking
 * its own container class and drifting. Also sets section rhythm
 * (`space-y-6` = 24px `content-gap` token) so vertical spacing
 * between cards stays consistent — except on `workspace`, which
 * suppresses vertical rhythm because columns handle their own
 * internal spacing.
 */
const pageShellVariants = cva("w-full", {
  variants: {
    variant: {
      overview: "mx-auto max-w-[1600px] px-6 py-6 lg:px-10 lg:py-10",
      dense: "mx-auto max-w-[1800px] px-6 py-6 lg:px-10 lg:py-10",
      form: "mx-auto max-w-[760px] px-6 py-6 lg:px-10 lg:py-10",
      // Editor canvas — no container chrome, no max width. The
      // three-column layout inside owns all spacing.
      workspace: "flex h-full min-h-0 flex-col",
    },
    spacing: {
      default: "space-y-8",
      tight: "space-y-6",
      loose: "space-y-10",
      // Workspace surfaces manage their own gaps via the column
      // flex; the usual vertical rhythm would conflict.
      none: "space-y-0",
    },
  },
  defaultVariants: {
    variant: "overview",
    spacing: "default",
  },
  compoundVariants: [
    // Workspace implicitly overrides default vertical rhythm unless
    // the caller opts back in explicitly.
    { variant: "workspace", spacing: "default", class: "space-y-0" },
  ],
})

export interface PageShellProps
  extends React.ComponentProps<"div">, VariantProps<typeof pageShellVariants> {}

export function PageShell({ className, variant, spacing, ...props }: PageShellProps) {
  return (
    <div
      data-slot="page-shell"
      data-variant={variant ?? "overview"}
      className={cn(pageShellVariants({ variant, spacing }), className)}
      {...props}
    />
  )
}
