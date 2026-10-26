import { registerCustomTheme } from "@pierre/diffs"
import { OpenCookTheme } from "./marked-theme"

let registered = false

export function registerOpenCookTheme() {
  if (registered) return
  registered = true
  registerCustomTheme("OpenCook", () => Promise.resolve(OpenCookTheme))
}
