/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { RGBA, TextRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { HomeBrand } from "../../../src/component/home-brand"
import { ConfigProvider, useConfig } from "../../../src/config"
import { ThemeProvider, useTheme, useThemes } from "../../../src/context/theme"
import { getOpenCookTheme } from "../../../src/theme"
import { resolveThemeDocument } from "@opencook/theme/tui"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

for (const mode of ["dark", "light"] as const) {
  test.each([
    { width: 160, height: 50 },
    { width: 100, height: 32 },
    { width: 68, height: 24 },
    { width: 44, height: 20 },
    { width: 30, height: 14 },
  ])(`fits the OpenCooK wordmark and composer in ${mode} at $width×$height`, async ({ width, height }) => {
    await using temporary = await tmpdir()
    let theme: ReturnType<typeof useTheme> | undefined
    function View() {
      theme = useTheme()
      return (
        <box flexGrow={1} alignItems="center" justifyContent="center" gap={1}>
          <HomeBrand />
          <box id="composer-fixture" width={Math.min(75, width - 4)} height={4} border borderColor={theme.border.base}>
            <text fg={theme.text.base}>Chat 聊天</text>
          </box>
        </box>
      )
    }
    const app = await testRender(
      () => (
        <TestTuiContexts paths={{ home: temporary.path, state: temporary.path }}>
          <ConfigProvider config={createTuiResolvedConfig({ animations: false, theme: { name: "opencook", mode } })}>
            <ThemeProvider mode={mode} source={emptyThemeSource}>
              <View />
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width, height },
    )
    app.renderer.start()
    try {
      await app.waitForFrame((frame) => frame.includes("Chat 聊天"))
      const brand = app.renderer.root.findDescendantById("home-brand")!
      const composer = app.renderer.root.findDescendantById("composer-fixture")!
      expect(brand.width).toBeLessThanOrEqual(width)
      expect(brand.x).toBeGreaterThanOrEqual(0)
      expect(brand.x + brand.width).toBeLessThanOrEqual(width)
      expect(brand.y + brand.height).toBeLessThanOrEqual(composer.y)
      expect(composer.y + composer.height).toBeLessThanOrEqual(height)
      expect(app.captureCharFrame()).toContain("Chat 聊天")
      expect(theme!.text.brand.equals(resolveThemeDocument(getOpenCookTheme(), mode).text.brand)).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })
}

test("reacts to theme changes and keeps old custom themes valid without a brand token", async () => {
  await using temporary = await tmpdir()
  const custom = {
    ...getOpenCookTheme(),
    base: { ...getOpenCookTheme().base, text: { ...getOpenCookTheme().base.text, brand: undefined } },
  }
  const lowContrast = {
    ...custom,
    base: { ...custom.base, text: { ...custom.base.text, brand: "$background.base" } },
    light: { ...custom.light, text: { ...custom.light?.text, brand: "$background.base" } },
  }
  let themes!: ReturnType<typeof useThemes>
  let config!: ReturnType<typeof useConfig>
  let theme!: ReturnType<typeof useTheme>
  function View() {
    themes = useThemes()
    config = useConfig()
    theme = useTheme()
    return <HomeBrand />
  }
  const preferences = { animations: false }
  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: temporary.path }}>
        <ConfigProvider
          config={createTuiResolvedConfig(preferences)}
          service={{
            get: async () => preferences,
            update: async (mutate) => {
              const next = { ...preferences }
              mutate(next)
              Object.assign(preferences, next)
              return next
            },
          }}
        >
          <ThemeProvider
            mode="dark"
            source={{ discover: async () => ({ "custom-without-brand": custom, "low-contrast-brand": lowContrast }) }}
          >
            <View />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 32 },
  )
  app.renderer.start()
  try {
    await app.waitFor(() => themes?.has("custom-without-brand"))
    expect(themes.set("custom-without-brand")).toBe(true)
    await app.waitFor(() => themes.selected === "custom-without-brand")
    expect(theme.text.brand.equals(theme.text.base)).toBe(true)
    const original = theme.text.brand
    expect(themes.setMode("light")).toBe(true)
    await app.waitFor(() => themes.mode() === "light")
    expect(theme.text.brand.equals(original)).toBe(false)
    await app.waitForFrame((frame) => frame.includes("OpenCooK") && frame.includes("╭"))
    const steam = app.renderer.root.findDescendantById("home-brand-steam")
    expect(steam instanceof TextRenderable).toBe(true)
    expect((steam as TextRenderable).plainText).toContain("╭")
    await config.update((draft) => {
      draft.animations = true
    })
    await config.update((draft) => {
      draft.animations = false
    })
    await app.waitForFrame((frame) => frame.includes("╭"))
    expect((steam as TextRenderable).plainText).toContain("╭")
    expect(theme.text.brand instanceof RGBA).toBe(true)
    expect(themes.set("low-contrast-brand")).toBe(true)
    await app.waitForFrame(
      () => themes.selected === "low-contrast-brand" && (steam as TextRenderable).fg.equals(theme.text.base),
    )
    expect((steam as TextRenderable).fg.equals(theme.text.base)).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test.each(["dark", "light"] as const)("keeps both built-in brand palettes legible in %s mode", async (mode) => {
  const { getOpenCook2Theme } = await import("../../../src/theme")
  const { contrast } = await import("../../../src/theme/color")
  for (const document of [getOpenCookTheme(), getOpenCook2Theme()]) {
    const theme = resolveThemeDocument(document, mode)
    expect(contrast(theme.text.brand, theme.background.base)).toBeGreaterThanOrEqual(3)
  }
})
