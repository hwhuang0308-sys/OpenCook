import { expect, test } from "bun:test"
import { selectTheme, selectThemeMode, supportsThemeMode, themeModes } from "@opencook/theme/tui"
import { getOpenCookTheme } from "../../../src/theme"

test("selects complete light and dark themes independently", () => {
  const light = selectTheme(getOpenCookTheme(), "light")
  const dark = selectTheme(getOpenCookTheme(), "dark")
  expect(selectTheme(getOpenCookTheme())).toEqual(light)
  expect(light.hue).toEqual(getOpenCookTheme().light.hue)
  expect(dark.text).toEqual(getOpenCookTheme().base.text)
  expect(dark.hue).toEqual(getOpenCookTheme().dark.hue)
  expect(selectThemeMode(getOpenCookTheme(), "dark")).toEqual({ theme: dark, mode: "dark" })
})

test("selects the available mode when the requested mode is missing", () => {
  const lightOnly = { base: getOpenCookTheme().base, light: getOpenCookTheme().light } as const
  const darkOnly = { base: getOpenCookTheme().base, dark: getOpenCookTheme().dark } as const

  expect(themeModes(lightOnly)).toEqual(["light"])
  expect(themeModes(darkOnly)).toEqual(["dark"])
  expect(supportsThemeMode(lightOnly, "light")).toBeTrue()
  expect(supportsThemeMode(lightOnly, "dark")).toBeFalse()
  expect(selectThemeMode(lightOnly, "dark")).toEqual({ theme: selectTheme(getOpenCookTheme(), "light"), mode: "light" })
  expect(selectThemeMode(darkOnly, "light")).toEqual({ theme: selectTheme(getOpenCookTheme(), "dark"), mode: "dark" })
})
