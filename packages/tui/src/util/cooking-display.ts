import { gunzipSync } from "node:zlib"
import font from "../assets/unifont.json"
import { stringWidth } from "./string-width"

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const glyphs = new Map<string, { width: number; rows: number[] } | undefined>()
let decoded: string | undefined

// Two bitmap rows occupy one terminal cell, preserving square Chinese glyphs.
export function cookingDisplay(text: string, width: number, height: number) {
  const characters = Array.from(segmenter.segment(text.replace(/\r\n?/g, "\n")), (entry) => entry.segment)
  const native = wrap(characters, width, stringWidth)
  const source = native.map((line) => line.join("")).join("\n")
  const supported =
    width >= 32 && height >= 9 && characters.every((character) => character === "\n" || glyph(character))
  if (supported) {
    for (const size of [48, 40, 32, 28, 24, 20, 18, 16, 14, 12]) {
      const pixelWidth = (character: string) => Math.max(1, Math.round((glyph(character)!.width * size) / 16))
      const lines = wrap(characters, width, pixelWidth)
      const rows = lines.length * (Math.ceil(size / 2) + 1) - 1
      if (rows + native.length + 1 > height) continue
      const rendered = lines
        .map((line) => {
          const pixels = line.map((character) => ({ bitmap: glyph(character)!, width: pixelWidth(character) }))
          const left = " ".repeat(Math.floor((width - pixels.reduce((sum, entry) => sum + entry.width, 0)) / 2))
          return Array.from({ length: Math.ceil(size / 2) }, (_, row) => {
            const y = Math.min(15, Math.floor((row * 2 * 16) / size))
            const nextY = Math.min(15, Math.floor(((row * 2 + 1) * 16) / size))
            return (
              left +
              pixels
                .map(({ bitmap, width }) =>
                  Array.from({ length: width }, (_, x) => {
                    const bit = 1 << (bitmap.width - 1 - Math.floor((x * bitmap.width) / width))
                    return [" ", "▀", "▄", "█"][
                      Number(!!(bitmap.rows[y] & bit)) + Number(!!(bitmap.rows[nextY] & bit)) * 2
                    ]
                  }).join(""),
                )
                .join("")
            )
          }).join("\n")
        })
        .join("\n\n")
      return { banner: rendered, source, rows: rows + native.length + 1, size }
    }
  }
  return { banner: undefined, source, rows: native.length, size: 0 }
}

function wrap(characters: string[], width: number, measure: (character: string) => number) {
  const lines: string[][] = [[]]
  let used = 0
  for (const character of characters) {
    if (character === "\n") {
      lines.push([])
      used = 0
      continue
    }
    const cells = measure(character)
    if (used > 0 && used + cells > width) {
      lines.push([])
      used = 0
    }
    lines.at(-1)!.push(character)
    used += cells
  }
  return lines
}

function glyph(character: string) {
  if (glyphs.has(character)) return glyphs.get(character)
  if (Array.from(character).length !== 1) return undefined
  decoded ??= "\n" + gunzipSync(Buffer.from(font.gzip, "base64")).toString("utf8")
  const key = "\n" + character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0") + ":"
  const start = decoded.indexOf(key)
  if (start === -1) {
    glyphs.set(character, undefined)
    return undefined
  }
  const value = decoded.slice(start + key.length, decoded.indexOf("\n", start + 1))
  const digits = value.length / 16
  const bitmap = {
    width: digits * 4,
    rows: Array.from({ length: 16 }, (_, row) => Number.parseInt(value.slice(row * digits, (row + 1) * digits), 16)),
  }
  glyphs.set(character, bitmap)
  return bitmap
}
