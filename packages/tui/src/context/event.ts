import type { OpenCookEvent } from "@opencook/client"
import { useClient } from "./client"

type EventMetadata = {
  directory: string | undefined
}
type OpenCookEventMap = { [Type in OpenCookEvent["type"]]: Extract<OpenCookEvent, { type: Type }> }

export function useEvent() {
  const client = useClient()

  function subscribe(handler: (event: OpenCookEvent, metadata: EventMetadata) => void) {
    return client.event.listen(({ details }) => {
      if (details.type === "server.connected") return
      handler(details, { directory: details.location?.directory })
    })
  }

  function on<T extends OpenCookEvent["type"]>(
    type: T,
    handler: (event: OpenCookEventMap[T], metadata: EventMetadata) => void,
  ) {
    return client.event.on(type, (event) => {
      handler(event, { directory: event.location?.directory })
    })
  }

  return {
    subscribe,
    on,
  }
}
