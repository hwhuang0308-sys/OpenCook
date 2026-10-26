import { Audio, type AudioErrorContext, type AudioPlayOptions, type AudioSound } from "@opentui/core"
import { readFile } from "node:fs/promises"

let audio: Audio | null | undefined
const sounds = new Map<string, Promise<AudioSound | null>>()

function getAudio() {
  if (audio !== undefined) return audio
  try {
    const next = Audio.create({ autoStart: false })
    next.on("error", (error: Error, context: AudioErrorContext) => {
      console.debug("tui audio error", { error, context })
    })
    audio = next
    return next
  } catch (error) {
    console.debug("failed to create tui audio", { error })
    audio = null
    return null
  }
}

export function loadSoundFile(file: string) {
  const current = getAudio()
  if (!current) return Promise.resolve(null)
  const cached = sounds.get(file)
  if (cached) return cached
  const task = readFile(file)
    .then((bytes) => current.loadSound(bytes))
    .catch((error) => {
      console.debug("failed to load tui sound", { file, error })
      return null
    })
  sounds.set(file, task)
  return task
}

export function play(sound: AudioSound, options?: AudioPlayOptions) {
  const current = getAudio()
  if (!current) return null
  if (!current.isStarted() && !current.start()) return null
  return current.play(sound, options)
}

export async function playSpeech(data: Uint8Array, signal: AbortSignal) {
  if (signal.aborted) return
  const current = getAudio()
  if (!current || (!current.isStarted() && !current.start())) throw new Error("无法打开本机音频播放设备")
  const playback = await current.playStream(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data)
        controller.close()
      },
    }),
    { format: "mp3", signal },
  )
  let failure: Error | undefined
  playback.on("error", (error) => {
    failure = error
  })
  try {
    await playback.closed
    if (!signal.aborted && (failure || playback.state === "errored")) throw failure ?? new Error("语音播放失败")
  } finally {
    playback.dispose()
  }
}

export function dispose() {
  audio?.dispose()
  audio = undefined
  sounds.clear()
}
