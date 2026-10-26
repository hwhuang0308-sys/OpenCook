export * as TemperatureSensor from "./temperature.js"

export const regions = ["中心", "左上", "右上", "左下", "右下"] as const
export type Region = (typeof regions)[number]

export function topMean(values: ArrayLike<number>, ratio: number) {
  if (ratio <= 0 || ratio > 1) throw new Error("ratio 必须在 (0, 1]")
  const sorted = Array.from(values).sort((a, b) => a - b)
  const k = Math.max(Math.trunc(sorted.length * ratio), 1)
  return sorted.slice(-k).reduce((sum, value) => sum + value, 0) / k
}

export function analyzeRegions(matrix: Float32Array) {
  const values: Record<Region, number[]> = { 中心: [], 左上: [], 右上: [], 左下: [], 右下: [] }
  const cy = 23 / 2,
    cx = 31 / 2,
    ry = 24 * 0.35,
    rx = 32 * 0.35
  const center = Math.min(rx, ry) * 0.5
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 32; x++) {
      // np.mgrid in the source is float32: retain that arithmetic for masks.
      const dy = Math.fround(y - cy),
        dx = Math.fround(x - cx)
      const ellipse = Math.fround(Math.fround(Math.fround(dy / ry) ** 2) + Math.fround(Math.fround(dx / rx) ** 2)) <= 1
      if (!ellipse) continue
      const region: Region =
        Math.fround(Math.fround(dy * dy) + Math.fround(dx * dx)) <= center * center
          ? "中心"
          : y < cy
            ? x < cx
              ? "左上"
              : "右上"
            : x < cx
              ? "左下"
              : "右下"
      values[region].push(matrix[y * 32 + x])
    }
  const scores = Object.fromEntries(
    regions.map((region) => [region, values[region].length ? topMean(values[region], 0.15) : -Infinity]),
  ) as Record<Region, number>
  const hottest = regions.reduce(
    (best, region) => (scores[region] > scores[best] ? region : best),
    regions[0] as Region,
  )
  return { hottest, scores, counts: Object.fromEntries(regions.map((region) => [region, values[region].length])) }
}

export class Monitor {
  private history: Region[] = []
  process(matrix: Float32Array) {
    const result = analyzeRegions(matrix)
    this.history.push(result.hottest)
    if (this.history.length > 6) this.history.shift()
    const counts = new Map<Region, number>()
    for (const region of this.history) counts.set(region, (counts.get(region) ?? 0) + 1)
    const dominant = [...counts.keys()].reduce(
      (best, region) => (counts.get(region)! > counts.get(best)! ? region : best),
      this.history[0],
    )
    const ratio = counts.get(dominant)! / this.history.length
    return { ...result, dominant, ratio, persistent: this.history.length === 6 && ratio >= 1 }
  }
}
