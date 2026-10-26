import { ensurePluginRuntime, provides } from "@opencook/plugin/runtime"
import { Plugin, PluginContextProvider, usePlugin } from "@opencook/plugin/tui"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"

ensurePluginRuntime()
ensureRuntimePluginSupport({
  additional: {
    "@opencook/plugin/tui": { Plugin, PluginContextProvider, usePlugin },
  },
  preserve: provides,
})
