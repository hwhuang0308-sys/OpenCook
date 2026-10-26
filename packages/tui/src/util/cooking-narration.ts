import type { Cooking } from "@opencook/schema/cooking"

type Utterance = { request: Cooking.SpeechRequest; key: string }

export class CookingNarration {
  private key = ""
  private pending?: Utterance
  private controller?: AbortController
  private worker?: Promise<void>
  private disposed = false

  constructor(
    private readonly io: {
      synthesize: (request: Cooking.SpeechRequest, signal: AbortSignal) => Promise<Cooking.Speech>
      play: (audio: Uint8Array, signal: AbortSignal) => Promise<void>
      error: (error: unknown) => void
    },
  ) {}

  update(run: Cooking.Run | null, muted = false, replay = 0) {
    if (this.disposed) return
    if (!run || (run.status !== "running" && !(run.status === "paused" && run.emergency)) || muted) {
      this.cancel()
      return
    }
    const kind = run.emergency ? "emergency" : run.warning ? "warning" : "step"
    const key = `${run.id}/${run.index}/${kind}/${run.warning ?? ""}/${run.emergency?.id ?? ""}/${run.emergency?.index ?? ""}/${replay}`
    if (key === this.key) return
    this.key = key
    this.pending = {
      key,
      request: {
        session_id: run.session_id,
        run_id: run.id,
        index: run.index,
        kind,
        emergency_id: run.emergency?.id,
        emergency_index: run.emergency?.index,
      },
    }
    this.controller?.abort()
    this.start()
  }

  cancel() {
    this.key = ""
    this.pending = undefined
    this.controller?.abort()
  }

  dispose() {
    this.disposed = true
    this.cancel()
    return this.worker ?? Promise.resolve()
  }

  private start() {
    if (this.worker || !this.pending || this.disposed) return
    this.worker = this.drain().finally(() => {
      this.worker = undefined
      this.start()
    })
  }

  private async drain() {
    while (this.pending && !this.disposed) {
      const current = this.pending
      this.pending = undefined
      const controller = new AbortController()
      this.controller = controller
      try {
        const result = await this.io.synthesize(current.request, controller.signal)
        if (controller.signal.aborted || this.key !== current.key || result.status !== "ready") continue
        await this.io.play(Uint8Array.from(Buffer.from(result.audio, "base64")), controller.signal)
      } catch (error) {
        if (!controller.signal.aborted && !this.disposed) this.io.error(error)
      } finally {
        if (this.controller === controller) this.controller = undefined
      }
    }
  }
}
