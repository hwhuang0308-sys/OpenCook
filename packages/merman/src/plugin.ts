import { Plugin } from "@opencook/plugin/tui"
import { createMermaidCodeBlockRenderer } from "./markdown.js"
import { resolveOpenCookDiagramPalette } from "./palette.js"

export default Plugin.define({
  id: "opencook.merman",
  setup(context) {
    context.markdown.registerCodeBlockRenderer(
      "mermaid",
      createMermaidCodeBlockRenderer(context.renderer, () => ({
        colors: resolveOpenCookDiagramPalette(context.theme, context.themeMode),
      })),
    )
  },
})
