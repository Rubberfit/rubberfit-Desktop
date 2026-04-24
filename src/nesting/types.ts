/** A 2D point */
export interface Point2D {
  x: number
  y: number
}

/** A polygon defined by its vertices (CCW winding) */
export interface Polygon2D {
  id: string
  points: Point2D[]
  /** How many discrete rotation steps to allow (4 = 0/90/180/270) */
  rotationSteps?: number
}

/** A single part to nest */
export interface NestingPart {
  id: string
  polygon: Polygon2D
  quantity: number
  /** Index of the originating UI spec */
  sourceSpecIndex?: number
  /** Piece index within a split fabrication strategy */
  pieceIndex?: number
  /** Total number of pieces required for one finished unit */
  piecesPerUnit?: number
  /** Original shape type for rendering */
  renderShape: "rect" | "circle" | "trapezoid" | "sector"
  /** Original shape fields preserved for rendering */
  originalSpec: Record<string, unknown>
}

/** Input to the nesting engine */
export interface NestingInput {
  /** Bin (stock sheet) width in inches */
  binWidth: number
  /** Bin (stock sheet) height in inches */
  binHeight: number
  /** Parts to place */
  parts: NestingPart[]
  /** Spacing/kerf between parts (inches) */
  spacing: number
  /** Discrete rotation steps (4 = 0/90/180/270, default: 4) */
  rotationSteps: number
  /** GA population size (default: 10) */
  populationSize?: number
  /** GA mutation rate 0-1 (default: 0.2) */
  mutationRate?: number
  /** GA generations (default: 30) */
  generations?: number
  /** PRNG seed */
  seed?: number
}

/** A single placed part */
export interface Placement2D {
  partId: string
  /** Position of the part origin after placement */
  x: number
  y: number
  /** Bounding box of the placed part */
  width: number
  height: number
  /** True polygon area of the placed part */
  polygonArea: number
  /** Bounding-box area of the placed part */
  boundingBoxArea: number
  /** Rotation in radians */
  rotation: number
  /** The actual polygon vertices after placement + rotation */
  placedPolygon: Point2D[]
  /** Whether the part was flipped (~180° rotation) for rendering compatibility */
  flipped: boolean
}

/** Result from the nesting engine */
export interface NestingResult {
  placements: Placement2D[]
  /** Number of parts successfully placed */
  placed: number
  /** Number of parts that didn't fit */
  overflow: number
  /** Total true polygon area occupied by placed parts */
  usedArea: number
  /** Bounding-box area of the overall placed layout */
  occupiedArea: number
  /** Bounding box of all placed parts */
  occupiedWidth: number
  occupiedHeight: number
  /** Area of the stock/bin used for the nesting run */
  stockArea: number
  /** Unused stock area based on true polygon usage */
  wasteArea: number
  /** Optimization quality metric (0-100) */
  efficiency: number
  /** Whether this is a heuristic or optimized result */
  source: "heuristic" | "optimized"
}
