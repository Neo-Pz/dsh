# Unified send acceptance — not yet accepted

2026-09-05. Working branch: `fix/conversation-tool-output-contract`.
The user requires completion, including real two-Node acceptance, before commit.
No commit, push, restart, or remote test message has been performed as part of
this implementation pass. After the user chose to restart DSH themselves, the
two tested bundles were installed locally on 2026-09-05 at 05:23 (Asia/Shanghai).
Installed hashes match the ones below; runtime loading is not yet verified.
Previous bundles are backed up at
`F:\i_Flow_One\plugin-install-backups\pre-unified-send-20260905-052321`.

## Local evidence

- `npm run build`: succeeded; tests exercise the resulting `lib/index.js`.
- `npm test`: 391 passed, zero failed/cancelled.
- Mutation checks: all 16 outbound/panel and 10 Conversation Service mutations
  were caught by assertion failures, with zero cancelled tests.
- Direct panel sends reuse the binding, persist before transmission, retain the
  same message ID on retry, and deduplicate concurrent submissions.
- Delegate generates locally, confirms once, and cannot send a cancelled draft.
  Private projections exclude model preparation rather than mislabel it as peer speech.
- Local plaintext reads are protected by the panel access check. Panel sends
  additionally require `X-IFlow-Panel: chat`.

Tested bundle SHA256:

```text
lib/index.js  58048e8c67620e7382cbace6c55551d08e2cb48809ac696c44120f6f78369fa9
lib/client.js 508ee3f99261d5f15faca22ffefdaa15e6c32978f5d174c2d12f0094a9eb6a86
```

## Real acceptance — all pending

Local installation is complete; the user will restart DSH. Remote installation
and both Nodes' runtime verification are outstanding. Preserve each Node's identity,
Principal binding, Agent declarations, peer configuration, tokens and history.
Do not clear D1 or reset pair permissions just to get a passing result.

1. Install these identical artifacts on both Nodes and confirm loaded versions,
   not just files on disk. Confirm the selected Workspace on each Node.
2. Independently verify Node pins and each hosted Agent ID/DID. Expected local
   Agent is `rrt`; remote ID is `weww`, display label `wwee`. Labels are not pins.
3. Send a uniquely labelled, non-sensitive test message using `rrt` to `weww`.
   Check its signed sender and recipient identities and shared message ID.
4. Verify tool, local panel and encrypted Web paths reuse the same Conversation
   and local Session. A reply must appear on both Nodes and in the authorized
   Web view. Do not infer this from local stub-host tests.
5. Verify same-ID retries create no extra Session entry or model invocation.
   Confirm Delegate is not delivered before approval; cancellation sends nothing.
6. Test pause and reauthorization with operator agreement. Local revocation is
   not proof that the remote Node changed its own permission. Retain history;
   require reauthorization before local sending/execution can resume.
7. Refresh Web and sync from the local Agent; verify Community receives only
   sealed content, routing metadata and public-safe facts, never transcript text.
8. Record actual results and any failures. Only commit once this acceptance and
   any resulting fixes have passed; no automatic production deployment.
