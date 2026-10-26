import type { EventApi } from "@opencook/client/effect/api"

export interface EventDomain extends Pick<EventApi<unknown>, "subscribe"> {}
