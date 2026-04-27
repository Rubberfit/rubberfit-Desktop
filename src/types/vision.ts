// Ported from rema-portal src/application/vision/types.ts and extended
// for desktop's multi-shape spreadsheet importer (rectangle, cylinder,
// cone, trapezoid). Discriminated on `shapeType` so consumers can
// branch without "is this rectangle data?" checks.

export type ExtractedShapeType = "rectangle" | "cylinder" | "cone" | "trapezoid"

interface ExtractedShapeBase {
  shapeType: ExtractedShapeType
  partNumber?: string
  quantity: number
  confidence: number
}

export interface ExtractedRectangle extends ExtractedShapeBase {
  shapeType: "rectangle"
  width: number
  length: number
}

export interface ExtractedCylinder extends ExtractedShapeBase {
  shapeType: "cylinder"
  diameter: number
  height: number
}

export interface ExtractedCone extends ExtractedShapeBase {
  shapeType: "cone"
  innerRadius: number
  outerRadius: number
  arcDegrees: number
}

export interface ExtractedTrapezoid extends ExtractedShapeBase {
  shapeType: "trapezoid"
  topWidth: number
  bottomWidth: number
  height: number
}

export type ExtractedPart =
  | ExtractedRectangle
  | ExtractedCylinder
  | ExtractedCone
  | ExtractedTrapezoid

export interface VisionExtractionResponse {
  parts: ExtractedPart[]
  warnings: string[]
  stockWidth?: number
}
