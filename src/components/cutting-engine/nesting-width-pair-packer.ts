// Width-aware pairing pre-pass for MaxRects packer
//
// Groups items by similar width and pairs them side-by-side as virtual
// rectangles before packing through MaxRects. For 78" stock with 35.5"-wide
// items, two items fit side-by-side (71" total, 7" residual) — a layout
// MaxRects can't discover when treating items individually.

import {
  MaxRectBin,
  batchFillBin,
  type HeuristicType,
  type PackableItem,
  type Placement,
} from "./nesting-global-packer"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WidthGroup {
  /** Representative width for this group */
  width: number
  /** Indices into the items array */
  members: number[]
}

interface WidthPair {
  left: number // item index
  right: number // item index
}

// ---------------------------------------------------------------------------
// Group items by width
// ---------------------------------------------------------------------------

/**
 * Sort items by width and sweep to create groups within ±tolerance.
 * Items wider than binWidth/2 are excluded (can't pair).
 */
function groupItemsByWidth(items: PackableItem[], binWidth: number, tolerance = 1.0): WidthGroup[] {
  const maxPairableWidth = binWidth / 2

  // Collect eligible indices sorted by width
  const eligible = items
    .map((item, i) => ({ i, w: item.w }))
    .filter((e) => e.w <= maxPairableWidth + 0.001)
    .sort((a, b) => a.w - b.w)

  if (eligible.length < 2) return []

  const groups: WidthGroup[] = []
  let current: WidthGroup = { width: eligible[0].w, members: [eligible[0].i] }

  for (let k = 1; k < eligible.length; k++) {
    if (eligible[k].w - current.width <= tolerance + 0.001) {
      current.members.push(eligible[k].i)
    } else {
      if (current.members.length >= 2) groups.push(current)
      current = { width: eligible[k].w, members: [eligible[k].i] }
    }
  }
  if (current.members.length >= 2) groups.push(current)

  // Sort by member count descending (largest groups first)
  groups.sort((a, b) => b.members.length - a.members.length)
  return groups
}

// ---------------------------------------------------------------------------
// Build pairs from a width group
// ---------------------------------------------------------------------------

/**
 * Pair consecutive items by length descending (longest with next-longest).
 * Verify each pair's combined width fits in binWidth.
 */
function buildWidthPairs(
  items: PackableItem[],
  group: WidthGroup,
  binWidth: number
): { pairs: WidthPair[]; unpaired: number[] } {
  // Sort members by height descending
  const sorted = [...group.members].sort(
    (a, b) => items[b].h - items[a].h || items[b].w - items[a].w
  )

  const pairs: WidthPair[] = []
  const unpaired: number[] = []

  for (let i = 0; i < sorted.length; i += 2) {
    if (i + 1 < sorted.length) {
      const left = sorted[i]
      const right = sorted[i + 1]
      if (items[left].w + items[right].w <= binWidth + 0.001) {
        pairs.push({ left, right })
      } else {
        unpaired.push(left, right)
      }
    } else {
      unpaired.push(sorted[i])
    }
  }

  return { pairs, unpaired }
}

// ---------------------------------------------------------------------------
// Width-pair packing
// ---------------------------------------------------------------------------

/**
 * Pack items using width-aware pairing:
 * 1. Group by width → build pairs
 * 2. Create virtual items (pair → single rect)
 * 3. Pack via batch fill
 * 4. Unpack pair placements back to individual items
 */
export function globalWidthPairPack(
  items: PackableItem[],
  binW: number,
  binH: number,
  maxBins: number,
  heuristic: HeuristicType
): { placements: Placement[]; bins: MaxRectBin[] } {
  const groups = groupItemsByWidth(items, binW)
  if (groups.length === 0) {
    // No pairable items — return empty so Modes 1/2 handle everything.
    // This function supplements (does not replace) standard packing.
    return { placements: [], bins: [] }
  }

  // Track which items are paired
  const pairedSet = new Set<number>()
  const allPairs: WidthPair[] = []

  for (const group of groups) {
    // Only consider members not already paired by a previous group
    const available = group.members.filter((m) => !pairedSet.has(m))
    if (available.length < 2) continue

    const subGroup: WidthGroup = { width: group.width, members: available }
    const { pairs, unpaired: _ } = buildWidthPairs(items, subGroup, binW)

    for (const pair of pairs) {
      pairedSet.add(pair.left)
      pairedSet.add(pair.right)
      allPairs.push(pair)
    }
  }

  if (allPairs.length === 0) {
    // No pairs formed — Modes 1/2 will pack all items individually
    return { placements: [], bins: [] }
  }

  // Build virtual packable items:
  // - Each pair becomes one virtual rectangle
  // - Unpaired items stay as-is
  const virtualItems: PackableItem[] = []
  // Map from virtual index → pair (or null for unpaired)
  const virtualMap: Array<{ type: "pair"; pair: WidthPair } | { type: "single"; itemIdx: number }> =
    []

  for (const pair of allPairs) {
    const left = items[pair.left]
    const right = items[pair.right]
    virtualItems.push({
      index: virtualItems.length,
      w: left.w + right.w,
      h: Math.max(left.h, right.h),
      item: left.item, // Only .w/.h/.index consumed by batchFillBin; .item unused for pairs
    })
    virtualMap.push({ type: "pair", pair })
  }

  for (let i = 0; i < items.length; i++) {
    if (!pairedSet.has(i)) {
      virtualItems.push({
        index: virtualItems.length,
        w: items[i].w,
        h: items[i].h,
        item: items[i].item,
      })
      virtualMap.push({ type: "single", itemIdx: i })
    }
  }

  // Pack virtual items using batch fill
  const bins: MaxRectBin[] = []
  const virtualPlacements: Placement[] = []
  const remaining = new Set(virtualItems.map((_, i) => i))

  while (remaining.size > 0 && bins.length < maxBins) {
    const bin = new MaxRectBin(bins.length, binW, binH)
    const placed = batchFillBin(bin, virtualItems, remaining, heuristic)
    if (placed.length === 0) break
    bins.push(bin)
    virtualPlacements.push(...placed)
  }

  // Unpack virtual placements back to individual item placements
  const finalPlacements: Placement[] = []

  for (const vp of virtualPlacements) {
    const entry = virtualMap[vp.itemIndex]
    if (entry.type === "single") {
      finalPlacements.push({
        binIndex: vp.binIndex,
        x: vp.x,
        y: vp.y,
        w: vp.w,
        h: vp.h,
        rotated: vp.rotated,
        itemIndex: entry.itemIdx,
      })
    } else {
      const { pair } = entry
      const left = items[pair.left]
      const right = items[pair.right]

      if (vp.rotated) {
        // Virtual rect was rotated: original (leftW+rightW, maxH) became (maxH, leftW+rightW).
        // Stack items vertically within the rotated placement.
        finalPlacements.push({
          binIndex: vp.binIndex,
          x: vp.x,
          y: vp.y,
          w: left.h,
          h: left.w,
          rotated: true,
          itemIndex: pair.left,
        })
        finalPlacements.push({
          binIndex: vp.binIndex,
          x: vp.x,
          y: vp.y + left.w,
          w: right.h,
          h: right.w,
          rotated: true,
          itemIndex: pair.right,
        })
      } else {
        // Normal orientation: items side by side
        finalPlacements.push({
          binIndex: vp.binIndex,
          x: vp.x,
          y: vp.y,
          w: left.w,
          h: left.h,
          rotated: false,
          itemIndex: pair.left,
        })
        finalPlacements.push({
          binIndex: vp.binIndex,
          x: vp.x + left.w,
          y: vp.y,
          w: right.w,
          h: right.h,
          rotated: false,
          itemIndex: pair.right,
        })
      }
    }
  }

  return { placements: finalPlacements, bins }
}
