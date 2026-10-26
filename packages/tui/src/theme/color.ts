import { RGBA } from "@opentui/core"

export function ansiToRgba(code: number): RGBA {
  if (code < 16) {
    const ansiColors = [
      "#000000",
      "#800000",
      "#008000",
      "#808000",
      "#000080",
      "#800080",
      "#008080",
      "#c0c0c0",
      "#808080",
      "#ff0000",
      "#00ff00",
      "#ffff00",
      "#0000ff",
      "#ff00ff",
      "#00ffff",
      "#ffffff",
    ]
    return RGBA.fromHex(ansiColors[code] ?? "#000000")
  }

  if (code < 232) {
    const index = code - 16
    const b = index % 6
    const g = Math.floor(index / 6) % 6
    const r = Math.floor(index / 36)
    const val = (x: number) => (x === 0 ? 0 : x * 40 + 55)
    return RGBA.fromInts(val(r), val(g), val(b))
  }

  if (code < 256) {
    const gray = (code - 232) * 10 + 8
    return RGBA.fromInts(gray, gray, gray)
  }

  return RGBA.fromInts(0, 0, 0)
}

export function tint(base: RGBA, overlay: RGBA, alpha: number): RGBA {
  const r = base.r + (overlay.r - base.r) * alpha
  const g = base.g + (overlay.g - base.g) * alpha
  const b = base.b + (overlay.b - base.b) * alpha
  return RGBA.fromInts(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255))
}

/** Contrast after compositing a translucent foreground over its surface. */
export function contrast(foreground: RGBA, background: RGBA) {
  const luminance = (values: readonly number[]) =>
    values
      .map((value) => (value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)))
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
  const back = [background.r, background.g, background.b]
  const front = luminance(
    [foreground.r, foreground.g, foreground.b].map(
      (value, index) => value * foreground.a + back[index] * (1 - foreground.a),
    ),
  )
  const base = luminance(back)
  return (Math.max(front, base) + 0.05) / (Math.min(front, base) + 0.05)
}
