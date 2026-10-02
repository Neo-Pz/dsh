# Network mechanisms to borrow, without moving the privacy boundary

Source review: 2026-09-05. Local OpenClaw checkout `b5f9636c`, EigenFlux
checkout `8d9679a7`. Neither reference project was modified, installed or run.
Source inspection is not a claim of interoperability or two-Node acceptance.

## Three different responsibilities

| Reference | Useful mechanism | iFlow owner |
|---|---|---|
| OpenClaw `extensions/a2a/src/channel.ts`, `inbound.ts` | Shared ingress/egress and session routing | Runtime adapter / Conversation Service |
| EigenFlux `rpc/pm/handler.go` | Participant-based thread reuse; first-contact controls distinct from ongoing chat | Local Conversation bindings and pair permission |
| EigenFlux `rpc/sort/handler.go` | Recall, rank, deduplicate, then apply delivery policies | Discovery projection, never an authorization engine |
| EigenFlux `rpc/notification/dal/delivery.go` | Recipient-scoped delivery records with conflict-safe insertion | Notification delivery bookkeeping, separate from business acceptance |

## Conversation slice in this working tree

`src/conversation/service.ts` owns exact participant matching, active-thread
selection, paused/closed-thread rejection and selected-signer checks. Tools,
encrypted Web send/draft confirmation and outbound relay messages use that
policy. Permission is read again after asynchronous preparation; a previously
selected thread is not a permanent permission token.

`sendAgentConversation` in `src/index.ts` now orchestrates tool, Web Direct,
draft confirmation and panel sends. Direct HTTP and sealed relay remain
different transports, with shared participant/permission policy, stable
message IDs, local persistence and reply mirroring. The panel has a composer
bound to the existing Conversation's From/To; it cannot override participants.
Retries use local persisted receipts, and Delegate confirmation sends the
Agent draft rather than duplicating its local preparation in the private view.

This is still an uncommitted implementation pending two-Node acceptance.
Local stub-host tests are not proof of live interoperability, restart recovery
or the host application's rendered Session behavior. The strict outbound
path refuses transmission when a local Session cannot be opened/persisted.
Private panel message reads and writes require local access (or configured
panel authentication); writes also require the panel's custom request header.

Identity comparisons use both Agent IDs and current Authority DIDs. A Node
alias cannot select a participant. An absent standing permission permits an
outgoing first-contact attempt, not automatic execution by its recipient.
Revocation is local, and cannot be assumed to change the other Node's record.

## EigenFlux: borrow mechanisms, not its server ownership model

- **Reuse by participants:** friend PMs normalize the participant pair and
  reuse its conversation; item-originated threads also include the item ID.
  iFlow keeps its own local/remote Agent direction and Conversation ID, with
  distinct private Session IDs at each Node.
- **First-contact pressure:** `rpc/pm/icebreak/icebreak.go` currently permits
  three initiating messages before a reply. `docs/dev/pm.md` describes a
  stricter one-message rule. The code is the observed behavior. iFlow should
  adopt bounded pending requests, not treat a reply as human authorization.
- **Persist then notify:** PM handlers commit the message before publishing a
  push notification. iFlow should treat push as a wake-up hint and retain
  durable local/relay records plus idempotent ACK processing. A push callback
  is not proof that an Agent executed or accepted work.
- **Reconnect with a cursor:** EigenFlux distinguishes already-seen history
  from unread messages. iFlow can reuse the separation, but history must come
  from the local Agent encrypted for the authorized browser, not from a cloud
  transcript table.
- **Useful discovery:** profile matching, freshness, source limits and
  recipient-level deduplication can improve Discovery. Private interests stay
  local unless explicitly shared; final relevance judgment belongs to the
  receiving Agent. Ranking does not confer `send_as`, tool or budget authority.

Do not copy these behaviors:

1. EigenFlux PM stores `PrivateMessage.Content` in server SQL
   (`rpc/pm/dal/db.go`). iFlow Community must not gain that table or plaintext.
2. EigenFlux blocked sends can return success with zero message/conversation
   IDs. iFlow must not display that as delivered. A privacy-preserving generic
   remote refusal can hide block details without fabricating delivery.
3. Behavioral instructions about public-safe broadcasting are not a substitute
   for iFlow's local visibility checks, Agent signing and explicit authority.
4. Discovery feedback is not trust evidence, and neither is an execution grant.
5. Do not import Redis/Elasticsearch/microservices solely to copy a mechanism;
   begin with the existing Journal and versioned projections.

## Order after this slice

1. Verify `rrt` and `weww` (display label `wwee`) using their actual DIDs on
   both machines; test ongoing chat and revoked-permission behavior.
2. Install the same tested build on both Nodes with operator approval, then
   verify tool/panel/Web send, replies, pause/reauthorization and Session reuse.
   Do not commit this slice before that acceptance is complete.
3. Extend existing Core `Publication` / `publication.created` /
   `publication.withdrawn`, rather than introducing a parallel broadcast model.
4. Design Subscription and recipient delivery records as explicit contracts;
   publish those before consumer implementation. Receiving a publication may
   propose contact, never authorize contact or start a paid task by itself.

No reference-network membership, automatic publishing, production deployment,
new infrastructure, or remote test message is authorized by this review.
