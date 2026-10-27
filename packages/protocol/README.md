# Schema and Protocol ownership

`@opencode/schema` owns reusable domain and leaf contracts shared with Core,
Server, and clients. `@opencode/protocol` owns the public HTTP API: routes,
path/query parameters, request payload wrappers, response envelopes, and public
projections of domain values. Compose Protocol contracts from canonical Schema
values rather than copying their definitions or moving domain contracts here
only because an endpoint uses them.

A payload used directly by domain behavior can remain in Schema. An HTTP-only
wrapper belongs beside its endpoint in `src/groups`. Give a wrapper a name when
that makes its role clear or permits reuse; simple inline envelopes need not all
be extracted. A TypeScript export name does not require a new schema identifier:
adding or changing identifiers can change the generated client surface.

## Current group audit

The groups follow these ownership patterns:

- Domain values are reused directly, for example `Agent.Info`, `Model.Info`,
  `Project.Info`, `Permission.Request`, and `Pty.CreateInput` / `Pty.UpdateInput`.
  These contracts stay in Schema even when used as endpoint payloads or results.
- Endpoint-local wrappers compose those values: list envelopes and filters,
  path IDs, query-string coercions, form creation payloads, and session mutation
  payloads stay in Protocol. `project.update` omits `projectID` from the reusable
  `Project.UpdateInput` because the ID comes from the route.
- Public projections, such as `PublicSessionInfo`, `PublicSessionMessage`, and
  inbox move payloads, replace host-local locations with `Location.PublicRef`.
  They stay in Protocol; the underlying domain definitions stay in Schema.
- Transport-specific contracts, including SSE event selection, RPC HTTP
  envelopes, media responses, and stream response declarations, stay in Protocol.

`session.prompt` names its HTTP wrapper `SessionPromptPayload` and its result
`SessionPromptResponse`. The payload composes `PromptInput.Prompt` and the inbox
metadata/delivery contracts with admission options. The response wraps the
canonical `SessionInbox.User` in `{ data }`. Neither wrapper changes the domain
contracts or their encoded shapes.

Keep the same distinction for other session endpoints rather than moving every
inline struct to Schema or renaming all wrappers at once.

## Verification

Run tests and typechecks from the affected packages. After changing the public
Protocol or Server `HttpApi`, run `bun run generate` from `packages/client` and
review the generated diff. A wrapper-only extraction should preserve request
and response types, optional fields, canonical domain schema identities, and wire encodings.
