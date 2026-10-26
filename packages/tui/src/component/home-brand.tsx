import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useConfig } from "../config"
import { contrast } from "../theme/color"
import { useTheme } from "../context/theme"

const letters = [
  [" ████ ", "██  ██", "██  ██", "██  ██", " ████ "],
  ["      ", "█████ ", "██  ██", "█████ ", "██    "],
  ["      ", " ████ ", "██▄▄██", "██    ", " ▀▀▀▀ "],
  ["      ", "█████ ", "██  ██", "██  ██", "██  ██"],
  [" █████", "██    ", "██    ", "██    ", " █████"],
  ["      ", " ████ ", "██  ██", "██  ██", " ████ "],
  ["      ", " ████ ", "██  ██", "██  ██", " ████ "],
  ["██  ██", "██ ██ ", "████  ", "██ ██ ", "██  ██"],
]
const compactLetters = [
  ["█▀█", "█ █", "▀▀▀"],
  ["█▀█", "█▀▀", "█  "],
  ["█▀▀", "█▀▀", "▀▀▀"],
  ["█▀█", "█ █", "█ █"],
  ["█▀▀", "█  ", "▀▀▀"],
  ["█▀█", "█ █", "▀▀▀"],
  ["█▀█", "█ █", "▀▀▀"],
  ["█ █", "██ ", "█ █"],
]
const steam = ["   ·   ╭    ·   ╭   ", "   ╭   ·    ╭   ·   ", "   ·   ╯    ·   ╯   ", "   ╯   ·    ╯   ·   "]

export function HomeBrand() {
  const theme = useTheme()
  const config = useConfig().data
  const ink = createMemo(() =>
    contrast(theme.text.brand, theme.background.base) >= 3 ? theme.text.brand : theme.text.base,
  )
  const dimensions = useTerminalDimensions()
  const [frame, setFrame] = createSignal(0)
  const tiny = () => dimensions().width < 36 || dimensions().height < 16
  const narrow = () => dimensions().width < 64 || dimensions().height < 22
  const large = () => dimensions().width >= 128 && dimensions().height >= 36
  const decorated = () => !tiny() && dimensions().height >= 26
  const lines = createMemo(() => {
    const glyphs = narrow() ? compactLetters : letters
    const scale = large() ? 2 : 1
    return Array.from({ length: glyphs[0].length }, (_, row) => ({
      open: glyphs
        .slice(0, 4)
        .map((glyph) => glyph[row])
        .join(" "),
      cook: glyphs
        .slice(4)
        .map((glyph) => glyph[row])
        .join(" "),
    })).flatMap((line) =>
      Array.from({ length: scale }, () => ({
        open: Array.from(line.open, (char) => char.repeat(scale)).join(""),
        cook: Array.from(line.cook, (char) => char.repeat(scale)).join(""),
        gap: " ".repeat(scale),
      })),
    )
  })
  createEffect(() => {
    if (!(config.animations ?? true) || !decorated()) {
      setFrame(0)
      return
    }
    const timer = setInterval(() => setFrame((value) => (value + 1) % steam.length), 900)
    onCleanup(() => clearInterval(timer))
  })
  return (
    <box id="home-brand" flexShrink={0} alignItems="center" gap={decorated() ? 1 : 0}>
      <Show when={decorated()}>
        <box alignItems="center" flexShrink={0}>
          <text id="home-brand-steam" fg={ink()} selectable={false} wrapMode="none">
            {steam[frame()]}
          </text>
          <text fg={theme.text.muted} selectable={false} wrapMode="none">
            {"─┄─────────╮  ╭─────────┄─"}
          </text>
        </box>
      </Show>
      <Show
        when={!tiny()}
        fallback={
          <text fg={ink()} attributes={TextAttributes.BOLD}>
            OpenCooK
          </text>
        }
      >
        <box id="home-brand-wordmark" flexShrink={0}>
          <For each={lines()}>
            {(line) => (
              <text wrapMode="none" selectable={false}>
                <span style={{ fg: theme.text.base }}>
                  {line.open}
                  {line.gap}
                </span>
                <span style={{ fg: ink() }}>{line.cook}</span>
              </text>
            )}
          </For>
        </box>
        <Show when={dimensions().height >= 22}>
          <text fg={theme.text.muted} wrapMode="none">
            OpenCooK · 从想吃，到上桌
          </text>
        </Show>
      </Show>
    </box>
  )
}
