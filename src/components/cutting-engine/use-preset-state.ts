import { useEffect, useMemo, useRef, useState } from "react"
import {
  getLocalStorageValue,
  removeLocalStorageValue,
  setLocalStorageValue,
} from "@/lib/stubs/local-storage"

import type {
  PartTemplate,
  CustomPartDrafts,
  CustomTemplateMap,
  SupportedPartType,
  TemplateCategory,
} from "./preset-template-data"
import {
  PART_OPTIONS,
  PART_TEMPLATES,
  DEFAULT_CUSTOM_DRAFTS,
  EMPTY_CUSTOM_TEMPLATES,
  CUSTOM_TEMPLATE_STORAGE_KEY,
  LEGACY_CUSTOM_TEMPLATE_STORAGE_KEY,
} from "./preset-template-data"
import {
  buildCustomTemplate,
  templateToDraft,
  getTemplateAreaSqFt,
  getTemplateBoundingBox,
  templateFitsStock,
  formatInches,
} from "./preset-utils"

/** Mirrors PartCustomDimensions from the infrastructure layer — kept local to
 *  avoid coupling this component file to the database model. */
interface DimensionSet {
  width?: number
  length?: number
  diameter?: number
  height?: number
  topWidth?: number
  bottomWidth?: number
  innerRadius?: number
  outerRadius?: number
  arcDegrees?: number
}

const MAX_TEMPLATE_QUANTITY = 1000

export interface LoadedSelection {
  /** Part type tab to switch to */
  partType: SupportedPartType
  /** Labels from part_selected_size_text — used to match PART_TEMPLATES by label */
  labels: string[]
  /** Increment to force the effect to re-run even when partType + labels are identical */
  nonce: number
  /**
   * Explicit per-template dimension data from part_custom_dimensions.
   * Legacy fallback: only used when prebuiltTemplates is absent or empty.
   */
  customDimensions?: DimensionSet[]
  /**
   * Fully-constructed PartTemplates for every size text that was recorded with
   * the cut.  The selector matches built-in presets by label first; anything
   * unmatched is created as a custom template from this array and auto-checked.
   * Index 0 also pre-fills the custom-size form so the user can inspect / tweak
   * it and optionally save it as a permanent preset.
   */
  prebuiltTemplates?: PartTemplate[]
  /**
   * Per-template quantities (same order as `labels` / `customDimensions`).
   * Recorded for auto-nest reloads so multi-template cuts re-pack with the
   * exact original inputs instead of collapsing to a single `cut_amount`
   * scalar. Written by `handleLoadCut` when `cut.layout_json.kind === "auto"`.
   */
  perTemplateQuantities?: number[]
}

/** Returns the first template whose dimensions exactly match the stored dimension set. */
function findMatchingTemplate(
  templates: PartTemplate[],
  dims: DimensionSet,
  partType: SupportedPartType
): PartTemplate | null {
  return (
    templates.find((t) => {
      if (t.partType !== partType) return false
      switch (partType) {
        case "rectangle":
          return t.width === dims.width && t.length === dims.length
        case "cylinder":
          return t.diameter === dims.diameter && t.height === dims.height
        case "cone":
          return (
            t.innerRadius === dims.innerRadius &&
            t.outerRadius === dims.outerRadius &&
            t.arcDegrees === dims.arcDegrees
          )
        case "trapezoid":
          return (
            t.topWidth === dims.topWidth &&
            t.bottomWidth === dims.bottomWidth &&
            t.height === dims.height
          )
        default:
          return false
      }
    }) ?? null
  )
}

/** Build a PartTemplate directly from stored dimensions — same ID/label
 *  format as buildCustomTemplate() so identical templates deduplicate. */
function templateFromDims(partType: SupportedPartType, dims: DimensionSet): PartTemplate | null {
  switch (partType) {
    case "rectangle": {
      if (dims.width == null || dims.length == null) return null
      return {
        id: `custom-rectangle-${dims.width}-${dims.length}`,
        partType,
        label: `${dims.width}" × ${dims.length}"`,
        summary: "Custom rectangular cut",
        quantity: 1,
        category: "custom",
        isCustom: true,
        width: dims.width,
        length: dims.length,
      }
    }
    case "cylinder": {
      if (dims.diameter == null || dims.height == null) return null
      return {
        id: `custom-cylinder-${dims.diameter}-${dims.height}`,
        partType,
        label: `Ø${dims.diameter}" × ${dims.height}"`,
        summary: "Custom cylinder wrap",
        quantity: 1,
        category: "custom",
        isCustom: true,
        diameter: dims.diameter,
        height: dims.height,
      }
    }
    case "cone": {
      if (dims.arcDegrees == null || dims.innerRadius == null || dims.outerRadius == null)
        return null
      return {
        id: `custom-cone-${dims.innerRadius}-${dims.outerRadius}-${dims.arcDegrees}`,
        partType,
        label: `${dims.arcDegrees}° • R${dims.innerRadius}" to R${dims.outerRadius}"`,
        summary: "Custom cone spread",
        quantity: 1,
        category: "custom",
        isCustom: true,
        arcDegrees: dims.arcDegrees,
        innerRadius: dims.innerRadius,
        outerRadius: dims.outerRadius,
      }
    }
    case "trapezoid": {
      if (dims.topWidth == null || dims.bottomWidth == null || dims.height == null) return null
      return {
        id: `custom-trapezoid-${dims.topWidth}-${dims.bottomWidth}-${dims.height}`,
        partType,
        label: `${dims.topWidth}" / ${dims.bottomWidth}" × ${dims.height}"`,
        summary: "Custom hopper panel",
        quantity: 1,
        category: "custom",
        isCustom: true,
        topWidth: dims.topWidth,
        bottomWidth: dims.bottomWidth,
        height: dims.height,
      }
    }
    default:
      return null
  }
}

function hydrateCustomTemplates(
  raw: string
): { hydrated: CustomTemplateMap; maxId: number } | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CustomTemplateMap>
    const hydrated: CustomTemplateMap = {
      rectangle: Array.isArray(parsed.rectangle) ? parsed.rectangle : [],
      cylinder: Array.isArray(parsed.cylinder) ? parsed.cylinder : [],
      cone: Array.isArray(parsed.cone) ? parsed.cone : [],
      trapezoid: Array.isArray(parsed.trapezoid) ? parsed.trapezoid : [],
    }
    const maxId = Object.values(hydrated)
      .flat()
      .reduce((highest, template) => {
        const match = template.id.match(/custom-[a-z-]+-(\d+)$/)
        const numericId = match ? Number.parseInt(match[1] ?? "0", 10) : 0
        return Number.isFinite(numericId) ? Math.max(highest, numericId) : highest
      }, 0)
    return { hydrated, maxId }
  } catch (_error) {
    return null
  }
}

export function usePresetState(
  onApply?: (templates: PartTemplate[]) => void,
  rollWidth?: number,
  rollLength?: number,
  loadedSelection?: LoadedSelection | null
) {
  const [selectedPart, setSelectedPart] = useState<SupportedPartType>("rectangle")
  const [checked, setChecked] = useState<Set<string>>(new Set())
  /** When true the next onApply call is skipped (used when no preset match exists). */
  const suppressNextApplyRef = useRef(false)
  const [filter, setFilter] = useState<"all" | TemplateCategory>("all")
  const [customDrafts, setCustomDrafts] = useState<CustomPartDrafts>(DEFAULT_CUSTOM_DRAFTS)
  const [customTemplates, setCustomTemplates] = useState<CustomTemplateMap>(EMPTY_CUSTOM_TEMPLATES)
  const [nextCustomId, setNextCustomId] = useState(1)
  const [editingCustomId, setEditingCustomId] = useState<string | null>(null)
  const [quantities, setQuantities] = useState<Map<string, number>>(new Map())

  useEffect(() => {
    let raw = getLocalStorageValue(CUSTOM_TEMPLATE_STORAGE_KEY)
    if (!raw) {
      raw = getLocalStorageValue(LEGACY_CUSTOM_TEMPLATE_STORAGE_KEY)
      if (raw) {
        setLocalStorageValue(CUSTOM_TEMPLATE_STORAGE_KEY, raw)
        removeLocalStorageValue(LEGACY_CUSTOM_TEMPLATE_STORAGE_KEY)
      }
    }
    if (!raw) return
    const result = hydrateCustomTemplates(raw)
    if (!result) {
      removeLocalStorageValue(CUSTOM_TEMPLATE_STORAGE_KEY)
      return
    }
    // Defer to avoid React state updates during the initial render phase
    queueMicrotask(() => {
      setCustomTemplates(result.hydrated)
      setNextCustomId(result.maxId + 1)
    })
  }, [])

  useEffect(() => {
    setLocalStorageValue(CUSTOM_TEMPLATE_STORAGE_KEY, JSON.stringify(customTemplates))
  }, [customTemplates])

  const sizeOptions = useMemo(
    () => [
      ...PART_TEMPLATES.filter((template) => template.partType === selectedPart),
      ...customTemplates[selectedPart],
    ],
    [customTemplates, selectedPart]
  )

  const availableCategories = useMemo(() => {
    const categories = new Set<TemplateCategory>()
    sizeOptions.forEach((template) => categories.add(template.category))
    return ["all", ...Array.from(categories)] as Array<"all" | TemplateCategory>
  }, [sizeOptions])

  const visible =
    filter === "all" ? sizeOptions : sizeOptions.filter((template) => template.category === filter)

  const allTemplates = useMemo(
    () => [
      ...PART_TEMPLATES,
      ...customTemplates.rectangle,
      ...customTemplates.cylinder,
      ...customTemplates.cone,
      ...customTemplates.trapezoid,
    ],
    [customTemplates]
  )

  const selectedTemplates = useMemo(
    () =>
      Array.from(checked)
        .map((id) => allTemplates.find((template) => template.id === id) ?? null)
        .filter((template): template is PartTemplate => template !== null)
        .map((template) => ({
          ...template,
          quantity: quantities.get(template.id) ?? template.quantity,
        })),
    [checked, allTemplates, quantities]
  )

  const selectionCounts = useMemo(() => {
    const idToType = new Map(allTemplates.map((t) => [t.id, t.partType]))
    const counts = new Map<string, number>()
    for (const id of checked) {
      const partType = idToType.get(id)
      if (partType) counts.set(partType, (counts.get(partType) ?? 0) + 1)
    }
    return counts
  }, [checked, allTemplates])

  const pendingCustomTemplate = useMemo(
    () => buildCustomTemplate(selectedPart, customDrafts),
    [customDrafts, selectedPart]
  )

  // If stock dimensions are provided and the pending template's bounding box
  // exceeds the stock in both orientations, surface a clear error so the user
  // can't add a part that would render as a blank sheet.
  const customTemplateError = useMemo<string | null>(() => {
    if (!pendingCustomTemplate || rollWidth == null || rollLength == null) return null
    if (templateFitsStock(pendingCustomTemplate, rollWidth, rollLength)) return null
    const { width, height } = getTemplateBoundingBox(pendingCustomTemplate)
    return `Bounding box ${formatInches(width)}\u2033 \u00d7 ${formatInches(height)}\u2033 is larger than the ${formatInches(rollWidth)}\u2033 \u00d7 ${formatInches(rollLength)}\u2033 stock — won't fit on the sheet.`
  }, [pendingCustomTemplate, rollWidth, rollLength])

  // Per-template stock-fit check for the grid. When stock dims are unknown
  // we treat everything as fitting (back-compat — no callers without dims yet).
  const fitsStock = useMemo(() => {
    return (template: PartTemplate): boolean => {
      if (rollWidth == null || rollLength == null) return true
      return templateFitsStock(template, rollWidth, rollLength)
    }
  }, [rollWidth, rollLength])

  const totalArea = selectedTemplates.reduce(
    (acc, template) => acc + getTemplateAreaSqFt(template),
    0
  )

  // Effect: respond to an external load trigger (e.g. loading a recorded cut)
  const lastLoadedNonceRef = useRef<number>(0)
  useEffect(() => {
    if (!loadedSelection) return
    // Dedupe by nonce so adding/removing templates inside this effect
    // (which mutates `customTemplates` — a dep) can't re-enter this
    // effect for the same load. Without this guard, `setCustomTemplates`
    // triggers a re-render → effect re-runs → sets customTemplates again
    // → infinite. Nonce is stamped fresh by every `handleLoadCut` call.
    if (lastLoadedNonceRef.current === loadedSelection.nonce) return
    lastLoadedNonceRef.current = loadedSelection.nonce
    const { partType, labels, customDimensions } = loadedSelection

    setSelectedPart(partType)
    setFilter("all")
    setEditingCustomId(null)

    if (customDimensions && customDimensions.length > 0) {
      // ── Path A: explicit dimension data is available ───────────────────────
      // All state updates happen in the effect body (pure), NOT inside
      // a setState reducer (which would double-fire under StrictMode).
      // React batches these into one render commit — `allTemplates`
      // rebuilds and `checked` settles in the same pass, so no
      // transient "allTemplates changed but checked still empty"
      // window exists for the onApply effect to misfire into.
      const builtinForType = PART_TEMPLATES.filter((t) => t.partType === partType)
      const existingCustom = customTemplates[partType]
      const allForType = [...builtinForType, ...existingCustom]
      const seenIds = new Set(allForType.map((t) => t.id))

      const idsToCheck: string[] = []
      const toAdd: PartTemplate[] = []
      for (const dims of customDimensions) {
        const match = findMatchingTemplate(allForType, dims, partType)
        if (match) {
          idsToCheck.push(match.id)
        } else {
          const newTemplate = templateFromDims(partType, dims)
          if (newTemplate && !seenIds.has(newTemplate.id)) {
            toAdd.push(newTemplate)
            seenIds.add(newTemplate.id)
            allForType.push(newTemplate)
          }
          if (newTemplate) idsToCheck.push(newTemplate.id)
        }
      }

      if (toAdd.length > 0) {
        setCustomTemplates({ ...customTemplates, [partType]: [...existingCustom, ...toAdd] })
      }

      if (idsToCheck.length === 0) {
        suppressNextApplyRef.current = true
        setChecked(new Set())
      } else {
        setChecked(new Set(idsToCheck))
      }

      // Propagate per-template quantities from the loaded cut into
      // the quantities Map so multi-template cuts re-pack with the
      // original per-row counts (cut_history's scalar `cut_amount`
      // can't represent them). Always reset the map on load — if we
      // skip this when the payload has no perQty, stale counts from a
      // previous load silently carry into the new selection.
      const perQty = loadedSelection.perTemplateQuantities
      const nextQty = new Map<string, number>()
      if (perQty && perQty.length > 0) {
        idsToCheck.forEach((id, i) => {
          const q = perQty[i]
          if (Number.isFinite(q) && q > 1) nextQty.set(id, q)
        })
      }
      setQuantities(nextQty)

      const d = customDimensions[0]
      if (d) {
        setCustomDrafts((draftPrev) => {
          switch (partType) {
            case "rectangle":
              return {
                ...draftPrev,
                rectangle: { width: String(d.width ?? ""), length: String(d.length ?? "") },
              }
            case "cylinder":
              return {
                ...draftPrev,
                cylinder: {
                  diameter: String(d.diameter ?? ""),
                  height: String(d.height ?? ""),
                },
              }
            case "cone":
              return {
                ...draftPrev,
                cone: {
                  innerRadius: String(d.innerRadius ?? ""),
                  outerRadius: String(d.outerRadius ?? ""),
                  arcDegrees: String(d.arcDegrees ?? ""),
                },
              }
            case "trapezoid":
              return {
                ...draftPrev,
                trapezoid: {
                  topWidth: String(d.topWidth ?? ""),
                  bottomWidth: String(d.bottomWidth ?? ""),
                  height: String(d.height ?? ""),
                },
              }
            default:
              return draftPrev
          }
        })
      }
    } else {
      // ── Path B: no stored dimensions — fall back to label matching ─────────
      const existingCustom = customTemplates[partType]
      const allForType = [
        ...PART_TEMPLATES.filter((t) => t.partType === partType),
        ...existingCustom,
      ]
      const matchedIds = new Set(
        allForType.filter((t) => labels.includes(t.label)).map((t) => t.id)
      )
      if (matchedIds.size === 0) {
        suppressNextApplyRef.current = true
      }
      setChecked(matchedIds)
    }
  }, [loadedSelection, customTemplates])

  useEffect(() => {
    if (suppressNextApplyRef.current) {
      suppressNextApplyRef.current = false
      return
    }
    onApply?.(selectedTemplates)
  }, [onApply, selectedTemplates])

  const handlePartChange = (partType: SupportedPartType) => {
    setSelectedPart(partType)
    setFilter("all")
    setEditingCustomId(null)
  }

  const handleQuantityChange = (templateId: string, qty: number) => {
    const clamped = Number.isFinite(qty)
      ? Math.max(1, Math.min(MAX_TEMPLATE_QUANTITY, Math.round(qty)))
      : 1
    setQuantities((previous) => {
      const next = new Map(previous)
      if (clamped <= 1) {
        next.delete(templateId)
      } else {
        next.set(templateId, clamped)
      }
      return next
    })
  }

  const handleToggle = (templateId: string) => {
    setChecked((previous) => {
      const next = new Set(previous)
      if (next.has(templateId)) {
        next.delete(templateId)
        setQuantities((prev) => {
          const nextQ = new Map(prev)
          nextQ.delete(templateId)
          return nextQ
        })
      } else {
        // Block adding a preset whose bounding box exceeds the stock — it
        // would render as a blank sheet.
        const template = allTemplates.find((t) => t.id === templateId)
        if (template && !fitsStock(template)) return previous
        next.add(templateId)
      }
      return next
    })
  }

  const handleSelectAll = () => {
    setChecked((previous) => {
      const next = new Set(previous)
      for (const template of sizeOptions) {
        if (fitsStock(template)) next.add(template.id)
      }
      return next
    })
  }

  // If the stock shrinks below an already-selected preset, drop it from the
  // selection so the layout doesn't silently break.
  useEffect(() => {
    setChecked((previous) => {
      let mutated = false
      const next = new Set(previous)
      for (const id of previous) {
        const template = allTemplates.find((t) => t.id === id)
        if (template && !fitsStock(template)) {
          next.delete(id)
          mutated = true
        }
      }
      return mutated ? next : previous
    })
  }, [allTemplates, fitsStock])

  const handleClearAll = () => {
    setChecked(new Set())
    setQuantities(new Map())
  }

  const customDraft = customDrafts[selectedPart]
  const selectedPartLabel =
    PART_OPTIONS.find((part) => part.partType === selectedPart)?.label ?? "Part"
  const savedCustomCount = customTemplates[selectedPart].length

  const handleAddCustomSize = () => {
    if (!pendingCustomTemplate || customTemplateError) return

    if (editingCustomId) {
      const customTemplate: PartTemplate = {
        ...pendingCustomTemplate,
        id: editingCustomId,
      }

      setCustomTemplates((previous) => ({
        ...previous,
        [selectedPart]: previous[selectedPart].map((template) =>
          template.id === editingCustomId ? customTemplate : template
        ),
      }))
      setEditingCustomId(null)
    } else {
      const id = `custom-${selectedPart}-${nextCustomId}`
      const customTemplate: PartTemplate = {
        ...pendingCustomTemplate,
        id,
      }

      setCustomTemplates((previous) => ({
        ...previous,
        [selectedPart]: [...previous[selectedPart], customTemplate],
      }))
      setChecked((previous) => {
        const next = new Set(previous)
        next.add(id)
        return next
      })
      setNextCustomId((previous) => previous + 1)
    }

    setFilter("all")
    setCustomDrafts((previous) => ({
      ...previous,
      [selectedPart]: DEFAULT_CUSTOM_DRAFTS[selectedPart],
    }))
  }

  const editCustomTemplate = (template: PartTemplate) => {
    setEditingCustomId(template.id)
    setFilter("all")
    setCustomDrafts((previous) => ({
      ...previous,
      [selectedPart]: templateToDraft(template),
    }))
  }

  const removeCustomTemplate = (templateId: string) => {
    setCustomTemplates((previous) => ({
      ...previous,
      [selectedPart]: previous[selectedPart].filter((template) => template.id !== templateId),
    }))
    setChecked((previous) => {
      const next = new Set(previous)
      next.delete(templateId)
      return next
    })
    if (editingCustomId === templateId) {
      setEditingCustomId(null)
      setCustomDrafts((previous) => ({
        ...previous,
        [selectedPart]: DEFAULT_CUSTOM_DRAFTS[selectedPart],
      }))
    }
  }

  return {
    selectedPart,
    checked,
    filter,
    setFilter,
    customDrafts,
    setCustomDrafts,
    editingCustomId,
    setEditingCustomId,
    availableCategories,
    visible,
    selectedTemplates,
    pendingCustomTemplate,
    customTemplateError,
    fitsStock,
    totalArea,
    customDraft,
    selectedPartLabel,
    savedCustomCount,
    quantities,
    selectionCounts,
    handlePartChange,
    handleToggle,
    handleQuantityChange,
    handleSelectAll,
    handleClearAll,
    handleAddCustomSize,
    editCustomTemplate,
    removeCustomTemplate,
  }
}
