import { expect, test } from "bun:test"
import { cookingDisplay } from "../src/util/cooking-display"
import { stringWidth } from "../src/util/string-width"

test("renders Chinese instructions as large terminal glyphs within the available area", () => {
  const display = cookingDisplay("清洗西红柿", 176, 40)
  expect(display.size).toBeGreaterThanOrEqual(16)
  expect(display.banner).toMatch(/[▀▄█]/)
  expect(display.rows).toBeLessThanOrEqual(40)
  for (const line of display.banner!.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(176)
})

test.each([
  { width: 71, height: 18, length: 120 },
  { width: 38, height: 18, length: 300 },
])(
  "fits a $length character action at $width columns without pagination or truncation",
  ({ width, height, length }) => {
    const text = "将鸡蛋轻轻倒入锅中，等待底部凝固后从锅边向里推，继续翻炒直到完成。".repeat(20).slice(0, length)
    const display = cookingDisplay(text, width, height)
    expect(display.source.replace(/\n/g, "")).toBe(text)
    expect(display.source).not.toContain("…")
    expect(display.rows).toBeLessThanOrEqual(height)
    for (const line of display.source.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(width)
  },
)

test("keeps mixed text and whole emoji when the bitmap font cannot represent a grapheme", () => {
  const text = "👩‍🍳 将鸡蛋搅匀，加入 30 ml 水，保持 140°C。"
  const display = cookingDisplay(text, 38, 12)
  expect(display.banner).toBeUndefined()
  expect(display.source.replace(/\n/g, "")).toBe(text)
  expect(display.source).toContain("👩‍🍳")
})
