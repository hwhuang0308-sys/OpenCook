import type { EventApi } from "@opencook/client/promise/api"

export interface EventDomain extends Pick<EventApi, "subscribe"> {}
