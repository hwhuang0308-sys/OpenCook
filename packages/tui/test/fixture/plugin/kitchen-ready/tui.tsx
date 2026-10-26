import { Plugin } from "@opencook/plugin/tui"

export default Plugin.define({
  id: "fixture.kitchen-ready",
  async setup(context) {
    await context.data.location.sync()
    context.ui.toast.show({ message: "Kitchen catalog ready" })
  },
})
