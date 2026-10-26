import { Slug } from "@opencook/core/util/slug"
import { useNewDesigns } from "../config"
import { type DialogContext } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"

export function DialogWorktreeName(props: { onConfirm: (name: string) => void }) {
  const newDesigns = useNewDesigns()
  return (
    <DialogPrompt
      title="Name worktree 命名工作树"
      placeholder="Worktree name 工作树名称"
      onConfirm={(value) => props.onConfirm(slugify(value) || Slug.create())}
      actions={[
        {
          title: newDesigns() ? "generate name 生成名称" : "generate one 自动生成",
          command: "dialog.worktree.generate",
          commandTitle: "Generate worktree name 生成工作树名称",
          onTrigger: (prompt) => prompt.setValue(Slug.create()),
        },
      ]}
    />
  )
}

DialogWorktreeName.show = (dialog: DialogContext) =>
  new Promise<string | null>((resolve) => {
    dialog.replace(
      () => <DialogWorktreeName onConfirm={resolve} />,
      () => resolve(null),
    )
  })

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}
