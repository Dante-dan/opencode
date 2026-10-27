export * as SessionError from "./session-error.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema.js"

/** Payload-free progress from one provider response, before any retry. */
export const StreamProgress = Schema.Struct({
  chunks: NonNegativeInt.pipe(optional),
  bytes: NonNegativeInt.pipe(optional),
  elapsedMs: NonNegativeInt.pipe(optional),
  decodedEvents: NonNegativeInt.pipe(optional),
  /** Last normalized LLM event type, never a provider-controlled event name. */
  lastEventType: Schema.String.pipe(optional),
  terminal: Schema.Boolean.pipe(optional),
  contentType: Schema.Literals([
    "text/event-stream",
    "application/json",
    "application/x-ndjson",
    "application/octet-stream",
  ]).pipe(optional),
  encoding: Schema.Literals(["identity", "gzip", "deflate", "br", "zstd"]).pipe(optional),
}).annotate({ identifier: "Session.ProviderStreamProgress" })

export interface Error extends Schema.Schema.Type<typeof Error> {}
export const Error = Schema.Struct({
  type: Schema.String,
  message: Schema.String,
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })).pipe(optional),
  response: Schema.Struct({ body: Schema.String }).pipe(optional),
  /** How long the provider asked to wait before trying again, counted from when the failure was recorded. */
  retryAfterMs: NonNegativeInt.pipe(optional),
  stream: StreamProgress.pipe(optional),
}).annotate({ identifier: "Session.StructuredError" })
