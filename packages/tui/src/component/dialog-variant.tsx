import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useNewDesigns } from "../config"

export function DialogVariant() {
  const local = useLocal()
  const dialog = useDialog()
  const newDesigns = useNewDesigns()

  const options = createMemo(() => [
    {
      value: "default",
      title: "Default 默认",
      onSelect: () => {
        dialog.clear()
        local.model.variant.set(undefined)
      },
    },
    ...local.model.variant
      .list()
      .filter((variant) => variant !== "default")
      .map((variant) => ({
        value: variant,
        title: variant,
        onSelect: () => {
          dialog.clear()
          local.model.variant.set(variant)
        },
      })),
  ])

  return (
    <DialogSelect<string>
      options={options()}
      title={"Select variant 选择模型变体"}
      renderFilter={!newDesigns()}
      current={local.model.variant.current() ?? "default"}
      flat={true}
    />
  )
}
