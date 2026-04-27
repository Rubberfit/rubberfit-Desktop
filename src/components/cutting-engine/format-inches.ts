/**
 * Shared dimension formatter for sheet/offcut/scrap dimensions across
 * the visualizer, the Reusable Offcuts card, and the PDF report so a
 * 5.875" piece reads identically everywhere ("5.875"") instead of the
 * different precisions we'd get from ad-hoc toFixed() calls.
 *
 * Whole inches drop the decimal; otherwise rounds to three decimals
 * with trailing zeros trimmed (5.875 -> "5.875", 5.5 -> "5.5",
 * 5.875000001 -> "5.875").
 */
export function formatInches(n: number): string {
  if (Number.isInteger(n)) return n.toString()
  return n.toFixed(3).replace(/\.?0+$/, "")
}
