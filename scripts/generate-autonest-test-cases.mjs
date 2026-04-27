// Generate autonest-test-cases.xlsx — a manual test runbook for the
// AutoNest packer across rectangle / circle / cylinder / cone /
// trapezoid / mixed / edge-case fixtures.
//
// Usage:
//   node scripts/generate-autonest-test-cases.mjs
//
// Writes ./autonest-test-cases.xlsx at the repo root. Re-runnable —
// overwrites in place.

import * as XLSX from "xlsx"
import { writeFileSync } from "node:fs"

const HEADER = [
  "Test ID",
  "Stock (W × L in)",
  "Kerf (in)",
  "Parts (qty × dims)",
  "Expected behavior",
  "Pass / Fail",
  "Sheets observed",
  "Notes / issue ref",
]

const sheets = {
  Overview: {
    rows: [
      ["AutoNest Manual Test Runbook"],
      [],
      ["How to use"],
      [
        "1. Open AutoNest in `npm run tauri dev`. For each row, set the Stock card (Width / Length / Kerf) and add the listed parts.",
      ],
      ["2. Press Pack. Visually compare the rendered layout to the Expected column."],
      [
        "3. Mark Pass / Fail in column F, write the actual sheet count in G, and any notes (or link to a GitHub issue) in H.",
      ],
      [
        "4. Flag-worthy regressions: amber offcut bbox overlapping a part polygon (Issue A), sparse multi-sheet when consolidation should fit (Issue B), pack > 6s on under ~30 parts (Issue #17), zero placements on a fixture you'd expect to succeed.",
      ],
      [],
      ["Tabs"],
      ["Rectangles", "Most validated path post wall-flush + configurable kerf"],
      ["Cylinders", "Unrolled to flat rectangle (π·d × h)"],
      ["Circles"],
      ["Cones", "Annular sector — known offcut overlap issue (see Issue A)"],
      ["Trapezoids"],
      ["Mixed shapes", "Cross-shape regression / coexistence checks"],
      ["Edge cases", "Forced-overflow, stress, tiny / huge parts"],
      ["Kerf round-trip", "Verify same fixture re-packs correctly when kerf changes"],
    ],
  },
  Rectangles: {
    rows: [
      HEADER,
      [
        "R1",
        "24 × 24",
        "0.125",
        "qty 4 × (6 × 6)",
        "1 sheet, 2×2 grid flush to corner, big L-shape offcut",
      ],
      ["R2", "24 × 24", "0.125", "qty 9 × (6 × 6)", "1 sheet, packed tight, minimal offcut"],
      [
        "R3",
        "24 × 24",
        "0.125",
        "qty 30 × (6 × 6)",
        "3-4 sheets, each filled before next opens (consolidation)",
      ],
      [
        "R4",
        "24 × 24",
        "0",
        "qty 4 × (6 × 6)",
        "Parts touch each other AND walls — no red strips anywhere",
      ],
      [
        "R5",
        "24 × 24",
        "0.5",
        "qty 4 × (6 × 6)",
        "Visible 0.5″ red kerf between parts, still flush to walls",
      ],
      [
        "R6",
        "48 × 96",
        "0.125",
        "qty 1 × (44 × 92)",
        "Fits flush in one sheet, leaving a thin L-shape offcut. (Note: a tighter near-bin-size fit like 47×95 may render as an empty sheet — Issue #18, LBF probabilistic sampler can't reliably find tight corner positions.)",
      ],
      [
        "R7",
        "24 × 24",
        "0.125",
        "qty 1 × (24 × 24)",
        "Should fit (wall-flush makes the exact fit work)",
      ],
      [
        "R8",
        "24 × 24",
        "0.125",
        "qty 6 × (8 × 4) strips",
        "Tests rotation — should auto-rotate to fit row of 3",
      ],
    ],
  },
  Cylinders: {
    rows: [
      HEADER,
      [
        "Cy1",
        "48 × 96",
        "0.125",
        "qty 1 × (Ø6 × h12) → ≈18.85 × 12 flat",
        "1 sheet, flush rectangle",
      ],
      [
        "Cy2",
        "48 × 96",
        "0.125",
        "qty 4 × (Ø3 × h8) → ≈9.42 × 8 flat",
        "1 sheet, multiple unrolls packed",
      ],
      [
        "Cy3",
        "24 × 24",
        "0.125",
        "qty 2 × (Ø7 × h10) → ≈21.99 × 10 flat",
        "Should fit on 1 sheet (1 per row, 2 rows)",
      ],
    ],
  },
  Circles: {
    rows: [
      HEADER,
      ["C1", "24 × 24", "0.125", "qty 1 × Ø10", "1 sheet, circle flush in corner of bbox"],
      [
        "C2",
        "24 × 24",
        "0.125",
        "qty 4 × Ø10",
        "1 sheet, 2×2 packing — circles touch the bin edges (bbox flush, curves visible)",
      ],
      ["C3", "24 × 24", "0.125", "qty 9 × Ø7", "1-2 sheets, dense packing"],
      [
        "C4",
        "24 × 24",
        "0.5",
        "qty 4 × Ø10",
        "Bigger gaps between circles, still flush bbox to walls",
      ],
    ],
  },
  Cones: {
    rows: [
      HEADER,
      [
        "Co1",
        "24 × 24",
        "0.125",
        "qty 1 × cone (R3 → R8, 90°)",
        "1 sheet — sanity check single cone renders correctly",
      ],
      [
        "Co2",
        "48 × 48",
        "0.125",
        "qty 4 × cone (R5 → R12, 90°)",
        "1 sheet — flag any reusable-offcut bbox visually overlapping a cone polygon (Issue A)",
      ],
      [
        "Co3",
        "24 × 24",
        "0.125",
        "qty 6 × cone (R2 → R6, 60°)",
        "Multi-sheet expected — confirm consolidation doesn't spread sparsely",
      ],
      [
        "Co4",
        "48 × 96",
        "0.125",
        "qty 3 × cone (R8 → R20, 180°) half-disk",
        "Tests large concave shape — check no overlap with offcut classifier",
      ],
      [
        "Co5",
        "24 × 24",
        "0.125",
        "qty 1 × cone (R3 → R10, 320°)",
        "Wide near-full sweep — exercises the upper bound of the cone form. Note: arcDegrees > 320 and innerRadius == 0 are both rejected by the form (preset-utils.ts:62-72). Full disks belong in the Circle template, not Cone.",
      ],
    ],
  },
  Trapezoids: {
    rows: [
      HEADER,
      ["T1", "24 × 24", "0.125", "qty 1 × trap (top=4, bot=10, h=12)", "1 sheet, flush bbox"],
      [
        "T2",
        "24 × 24",
        "0.125",
        "qty 4 × trap (top=3, bot=6, h=8)",
        "1 sheet — alternating orientation should pack tight (rotation 0/90/180/270 allowed)",
      ],
      [
        "T3",
        "48 × 96",
        "0.125",
        "qty 6 × trap (top=8, bot=14, h=20)",
        "Multi-sheet, consolidation check",
      ],
    ],
  },
  "Mixed shapes": {
    rows: [
      HEADER,
      [
        "M1",
        "48 × 96",
        "0.125",
        "2 × (6 × 6) rect + 1 × Ø8 circle + 1 × cone (R3 → R8, 90°)",
        "All 4 fit on 1 sheet, kerf maintained between",
      ],
      [
        "M2",
        "24 × 24",
        "0.125",
        "4 × (5 × 5) rect + 2 × Ø4 circle",
        "1 sheet, mixed packing",
      ],
      [
        "M3",
        "24 × 24",
        "0",
        "2 × (6 × 6) rect + 1 × Ø6 circle",
        "Parts butt up against each other AND walls",
      ],
    ],
  },
  "Edge cases": {
    rows: [
      HEADER,
      [
        "E1",
        "24 × 24",
        "0.125",
        "qty 1 × (30 × 30) rect",
        "0 placed, 'couldn't fit on 50 sheets' toast, no crash",
      ],
      [
        "E2",
        "24 × 24",
        "0.125",
        "qty 100 × (2 × 2) rect",
        "Auto-fill estimates a few sheets, all 100 fit, no over-allocation visible",
      ],
      [
        "E3",
        "24 × 24",
        "0.125",
        "qty 1 × (0.5 × 0.5) rect",
        "Tiny part — confirm placement and offcut classification still sane",
      ],
      [
        "E4",
        "96 × 120",
        "0.0625",
        "qty 50 × (8 × 8) rect",
        "Large stock + many parts + fine kerf — performance/stress test (flag if slow → Issue #17)",
      ],
    ],
  },
  "Kerf round-trip": {
    rows: [
      [
        "Test ID",
        "Stock (W × L in)",
        "Parts",
        "Sequence",
        "Expected",
        "Pass / Fail",
        "Notes",
      ],
      [
        "K1",
        "24 × 24",
        "qty 4 × (6 × 6) rect",
        "kerf 0 → 0.125 → 0.5 → 0.125",
        "0: parts flush, no red strips. 0.125: thin red strips. 0.5: thick red strips. Returning to 0.125 matches first observation.",
      ],
      [
        "K2",
        "24 × 24",
        "qty 4 × Ø10 circle",
        "kerf 0 → 0.125 → 0.5",
        "Same pattern as K1 but with circles.",
      ],
      [
        "K3",
        "48 × 96",
        "qty 4 × cone (R5 → R12, 90°)",
        "kerf 0.125 → 0.5",
        "Cone gaps widen, no overlap with reusable offcut classifier introduced.",
      ],
    ],
  },
}

const wb = XLSX.utils.book_new()
for (const [name, { rows }] of Object.entries(sheets)) {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  // Reasonable column widths — varies by sheet so set generous defaults.
  ws["!cols"] = [
    { wch: 9 }, // Test ID
    { wch: 16 }, // Stock
    { wch: 9 }, // Kerf
    { wch: 42 }, // Parts
    { wch: 70 }, // Expected
    { wch: 12 }, // Pass / Fail
    { wch: 16 }, // Sheets observed
    { wch: 30 }, // Notes
  ]
  XLSX.utils.book_append_sheet(wb, ws, name)
}

const outPath = "autonest-test-cases.xlsx"
const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" })
writeFileSync(outPath, buf)
console.log(`Wrote ${outPath}`)
