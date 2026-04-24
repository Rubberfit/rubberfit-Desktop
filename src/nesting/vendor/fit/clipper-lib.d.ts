declare module "clipper-lib" {
  interface IntPoint {
    X: number
    Y: number
  }

  type Path = IntPoint[]
  type Paths = Path[]

  /** Paths constructor (creates an empty array) */
  const Paths: { new (): Paths }

  namespace PolyType {
    const ptSubject: number
    const ptClip: number
  }

  namespace ClipType {
    const ctUnion: number
    const ctDifference: number
    const ctIntersection: number
    const ctXor: number
  }

  namespace PolyFillType {
    const pftNonZero: number
    const pftEvenOdd: number
  }

  namespace JoinType {
    const jtSquare: number
    const jtRound: number
    const jtMiter: number
  }

  namespace EndType {
    const etClosedPolygon: number
    const etClosedLine: number
    const etOpenButt: number
    const etOpenSquare: number
    const etOpenRound: number
  }

  class Clipper {
    constructor()
    AddPath(path: Path, polyType: number, closed: boolean): boolean
    AddPaths(paths: Paths, polyType: number, closed: boolean): boolean
    Execute(clipType: number, solution: Paths, fillType1?: number, fillType2?: number): boolean
    static MinkowskiSum(pattern: Path, path: Path, pathIsClosed: boolean): Paths
    static CleanPolygon(path: Path, distance?: number): Path
    static CleanPolygons(paths: Paths, distance?: number): Paths
    static Area(path: Path): number
  }

  class ClipperOffset {
    constructor(miterLimit?: number, arcTolerance?: number)
    AddPath(path: Path, joinType: number, endType: number): void
    Execute(solution: Paths, delta: number): void
  }
}
