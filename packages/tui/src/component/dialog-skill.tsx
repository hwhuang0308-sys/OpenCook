import { TextAttributes } from "@opentui/core"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { createResource, createMemo, createSignal, Match, Switch } from "solid-js"
import { DIALOG_LIST_INSET, useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { errorMessage } from "../util/error"
import { useData } from "../context/data"
import type { LocationRef } from "@opencook/client"

export type DialogSkillProps = {
  location?: LocationRef
  onSelect: (skill: string) => void
}

export function DialogSkill(props: DialogSkillProps) {
  const dialog = useDialog()
  const data = useData()
  const theme = useTheme()
  dialog.setSize("large")

  const [loadError, setLoadError] = createSignal<unknown>()

  const [skills] = createResource(() =>
    Promise.resolve()
      .then(async () => {
        const current = data.location.skill.list(props.location)
        if (current) return current
        await data.location.skill.sync(props.location)
        return data.location.skill.list(props.location) ?? []
      })
      // Catch so the rejected resource never reaches the memo below: reading
      // skills() in an errored state re-throws and tears down the dialog.
      .catch((error) => {
        setLoadError(error)
        return undefined
      }),
  )

  const showError = createMemo(() => Boolean(loadError()))

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    if (showError()) return []
    const list = skills() ?? []
    const maxWidth = Math.max(0, ...list.map((s) => s.name.length))
    return list.map((skill) => ({
      title: skill.name.padEnd(maxWidth),
      description: skill.description?.replace(/\s+/g, " ").trim(),
      value: skill.id,
      onSelect: () => {
        props.onSelect(skill.id)
        dialog.clear()
      },
    }))
  })

  return (
    <DialogSelect
      title="Skills 技能"
      options={options()}
      renderFilter={!showError() && !skills.loading}
      locked={showError() || skills.loading}
      emptyView={
        <Switch
          fallback={
            <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
              <text fg={theme.text.muted}>No skills available 暂无可用技能</text>
            </box>
          }
        >
          <Match when={showError()}>
            <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
              <text fg={theme.text.feedback.error.base} attributes={TextAttributes.BOLD}>
                Could not load skills 无法加载技能
              </text>
              <text fg={theme.text.muted}>{errorMessage(loadError())}</text>
              <text fg={theme.text.muted}>Close and reopen Skills to try again. 关闭后重新打开技能页面重试。</text>
            </box>
          </Match>
          <Match when={skills.loading}>
            <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
              <text fg={theme.text.muted}>Loading skills… 正在加载技能…</text>
            </box>
          </Match>
        </Switch>
      }
      noMatchView={
        <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
          <text fg={theme.text.muted}>No skills found 未找到匹配技能</text>
        </box>
      }
    />
  )
}
