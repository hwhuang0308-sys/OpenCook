import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"

test.each([
  { width: 160, height: 50 },
  { width: 100, height: 30 },
  { width: 44, height: 24 },
  { width: 60, height: 16 },
])("keeps the real home composer usable at $width×$height", async ({ width, height }) => {
  await using app = await createAppFixture({ width, height, config: { animations: false } })
  await app.ready
  await app.waitForFrame(
    () =>
      app.renderer.root.findDescendantById("home-brand") !== undefined &&
      app.renderer.currentFocusedEditor instanceof TextareaRenderable,
  )
  const brand = app.renderer.root.findDescendantById("home-brand")!
  const editor = app.renderer.currentFocusedEditor!
  expect(brand.x).toBeGreaterThanOrEqual(0)
  expect(brand.x + brand.width).toBeLessThanOrEqual(width)
  expect(editor.y).toBeGreaterThanOrEqual(brand.y + brand.height)
  expect(editor.y + editor.height).toBeLessThanOrEqual(height)
  expect(app.renderer.root.findDescendantById("kitchen-home-topics")).toBeUndefined()
  await app.mockInput.typeText("今晚想吃点清淡的")
  await app.waitForFrame((frame) => frame.includes("今晚想吃点清淡的"))
  app.mockInput.pressKey("p", { ctrl: true })
  await app.waitForFrame(
    (frame) => frame.includes("Commands 命令") && app.renderer.currentFocusedEditor instanceof InputRenderable,
  )
  app.mockInput.pressEscape()
  await app.waitForFrame(
    (frame) => frame.includes("今晚想吃点清淡的") && app.renderer.currentFocusedEditor instanceof TextareaRenderable,
  )
})

test.each(["技能", "输入", "主题", "设置"])("finds the real bilingual Ctrl+P command using %s", async (query) => {
  await using app = await createAppFixture({ width: 100, height: 32, config: { animations: false } })
  await app.ready
  await app.waitForFrame(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  app.mockInput.pressKey("p", { ctrl: true })
  await app.waitForFrame(
    (frame) => frame.includes("Commands 命令") && app.renderer.currentFocusedEditor instanceof InputRenderable,
  )
  await app.mockInput.typeText(query)
  await app.waitForFrame((frame) => frame.includes(query))
  expect(app.captureCharFrame()).toContain(
    query === "技能" || query === "输入"
      ? "Skills 技能"
      : query === "主题"
        ? "Switch theme 切换主题"
        : "Open settings 打开设置",
  )
  if (query === "技能") {
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("No skills available 暂无可用技能"))
  }
})

test("turns off the home animation through the real bilingual settings entry", async () => {
  await using app = await createAppFixture({ width: 100, height: 32, config: { animations: true } })
  await app.ready
  await app.waitForFrame(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  app.mockInput.pressKey("p", { ctrl: true })
  await app.waitForFrame(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
  await app.mockInput.typeText("动画")
  await app.waitForFrame((frame) => frame.includes("Animations 动画"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("Settings 设置") && frame.includes("Animations 动画"))
  app.mockInput.pressEnter()
  await app.waitFor(() => app.config().animations === false)
  app.mockInput.pressEscape()
  await app.waitForFrame((frame) => frame.includes("OpenCooK"))
})
