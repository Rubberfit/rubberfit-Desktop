import type XorShift from "./xorshift"

const PI2 = Math.PI * 2

export function stdSeed(rnd: XorShift, mu = 0, sigma = 1): number {
  const u1 = rnd.randFloat()
  const u2 = rnd.randFloat()
  const randStdNormal = Math.sqrt(-2.0 * Math.log(u1)) * Math.sin(PI2 * u2)
  return mu + sigma * randStdNormal
}
