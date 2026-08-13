# Multi-Worker Provider Config Persistence Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure provider credential/configuration edits made through the management UI remain effective and cannot be restored by stale execution-worker memory.

**Architecture:** Keep the control worker as the only writer of `provider_pools.json`. After every successful provider configuration mutation, publish a revisioned provider-config synchronization event through the existing master IPC fan-out so every execution worker replaces its in-memory provider configuration and invalidates affected adapters. Include the applied config revision in execution-worker provider-state events, and make the control worker reject state events older than the latest administrator mutation.

**Tech Stack:** Node.js, child-process IPC, Jest, Docker, Redis-backed multi-worker runtime.

---

## Confirmed Regression

- Production image `aiclient2api:custom-b4aa2ba-20260812` runs one control worker and three execution workers.
- Management requests are routed to the control worker, but `/api/reload-config` reloads only that process.
- Execution workers retain their previous provider configuration and service adapters after edit, enable/disable, or reauthorization operations.
- Execution workers continue emitting `provider_state` events from stale memory. The control worker accepts those events and persists the provider type again, which can restore stale mutable fields such as `isDisabled`, `isHealthy`, and previous health-check errors.
- Non-state credential/config fields may remain on disk but are not effective for model traffic until execution workers restart, which makes ordinary edits appear to have been ignored.
- This behavior was introduced by the multi-worker runtime beginning at commit `13c7917`; it is a product regression and not an OAuth-account failure.

## Scope Boundaries

- Keep the control worker as the sole file writer.
- Do not send OAuth token file contents, API keys, or secrets through logs or WebSocket events.
- IPC may carry the canonical provider configuration already present inside the same container, but logging must include only revision, provider type, UUID, and action.
- Do not solve this by restarting all execution workers after every edit.
- Do not expand this fix into strict multi-container active-active state storage.
- Do not deploy production or push Git changes without separate authorization.

### Task 1: Add failing tests for stale worker configuration

**Files:**
- Create: `tests/provider-config-runtime-sync.test.js`
- Modify: `tests/provider-state-event.test.js`
- Modify: `tests/runtime-proxy.test.js`

**Step 1: Write a failing config-sync event test**

Add a test that builds a canonical provider config containing a changed `checkModelName`, proxy assignment, enabled state, and credential path. Assert that applying the config-sync event to an execution-worker pool:

- replaces the complete matching provider config;
- preserves no stale credential/proxy/model fields;
- updates the worker's config revision;
- reports the provider UUID that requires adapter invalidation.

**Step 2: Write a failing stale-state fencing test**

Extend `tests/provider-state-event.test.js` with these cases:

- a `provider_state` event with revision `4` is rejected when canonical config revision is `5`;
- a state event with revision `5` is accepted;
- credentials, proxy fields, and check-model fields remain excluded from state events.

**Step 3: Write a failing master fan-out test**

Add a focused runtime test proving a `provider_config_sync` message from the control worker is forwarded to every execution worker and not reflected back to the sender.

**Step 4: Run the focused tests and confirm failure**

Run:

```powershell
npm.cmd test -- --runInBand tests/provider-config-runtime-sync.test.js tests/provider-state-event.test.js tests/runtime-proxy.test.js
```

Expected: FAIL because config-sync events and config revisions do not exist yet.

**Step 5: Commit the regression tests**

```powershell
git add tests/provider-config-runtime-sync.test.js tests/provider-state-event.test.js tests/runtime-proxy.test.js
git commit -m "test(runtime): reproduce stale provider config overwrite"
```

### Task 2: Implement revisioned provider configuration synchronization

**Files:**
- Create: `src/runtime/provider-config-event.js`
- Modify: `src/runtime/provider-state-event.js`
- Modify: `src/runtime/multi-worker-runtime.js`
- Modify: `src/providers/provider-pool-manager.js`
- Modify: `src/services/api-server.js`
- Test: `tests/provider-config-runtime-sync.test.js`
- Test: `tests/provider-state-event.test.js`

**Step 1: Add the provider config event contract**

Implement helpers that create and apply an event shaped like:

```js
{
    type: 'provider_config_sync',
    revision: 12,
    providerType: 'openai-codex-oauth',
    providers: [/* canonical configs for this provider type */],
    changedUuids: ['provider-uuid'],
    action: 'update',
    occurredAt: '2026-08-13T00:00:00.000Z'
}
```

Validate that `revision` is a positive integer, clone input data, and reject malformed events without mutating the target.

**Step 2: Track the applied config revision in `ProviderPoolManager`**

Add a monotonic `providerConfigRevision` initialized from runtime options. Add a method that atomically replaces one provider type in both `providerPools` and `providerStatus`, records the revision, and returns affected UUIDs.

**Step 3: Version provider-state events**

Include `configRevision` in `createProviderStateEvent()`. In `applyRemoteProviderState()`, ignore and log stale events whose revision is lower than `providerConfigRevision`. Accept equal/current revisions so health, quota, and usage state still converge normally.

**Step 4: Fan out config-sync IPC messages**

Update `src/runtime/multi-worker-runtime.js` so a `provider_config_sync` message from the control worker is forwarded to all execution workers. Do not forward configuration payloads to logs or metrics.

**Step 5: Apply sync events inside execution workers**

Update the runtime message handler in `src/services/api-server.js` to:

- replace the target provider type through `ProviderPoolManager`;
- invalidate service adapters for changed/deleted UUIDs;
- update `CONFIG.providerPools`;
- acknowledge the applied revision to the master/control path;
- never persist `provider_pools.json` from an execution worker.

**Step 6: Run the focused tests**

Run:

```powershell
npm.cmd test -- --runInBand tests/provider-config-runtime-sync.test.js tests/provider-state-event.test.js tests/runtime-proxy.test.js tests/provider-pool-redis-coordination.test.js
```

Expected: PASS.

**Step 7: Commit the runtime protocol**

```powershell
git add src/runtime/provider-config-event.js src/runtime/provider-state-event.js src/runtime/multi-worker-runtime.js src/providers/provider-pool-manager.js src/services/api-server.js tests/provider-config-runtime-sync.test.js tests/provider-state-event.test.js tests/runtime-proxy.test.js
git commit -m "fix(runtime): synchronize provider config across workers"
```

### Task 3: Route all provider mutations through one canonical commit path

**Files:**
- Modify: `src/ui-modules/provider-api.js`
- Modify: `src/ui-modules/config-api.js`
- Modify: `src/services/service-manager.js`
- Modify: `src/providers/provider-pool-manager.js`
- Create: `tests/provider-config-mutation-sync.test.js`
- Modify: `tests/codex-reauthorize-provider.test.js`

**Step 1: Add failing mutation-path tests**

Cover these operations:

- edit provider fields;
- enable and disable provider;
- add and delete provider;
- refresh provider UUID;
- replace a Codex credential path during reauthorization;
- reload provider pools from disk.

For each operation, assert this order:

1. canonical file write succeeds;
2. control-worker memory is updated;
3. revision increments exactly once;
4. config-sync event is emitted exactly once;
5. adapter invalidation occurs for the affected UUID;
6. no event is emitted when persistence fails.

**Step 2: Add a canonical mutation helper**

Implement a `ProviderPoolManager` method (or a small dedicated service) that receives the fully persisted provider type, increments the revision, updates control memory, and emits `provider_config_sync`. Keep file I/O in the existing API/service layer so failed writes cannot mutate memory.

**Step 3: Replace direct `providerPools` assignment**

Update all provider mutation handlers to call the canonical helper instead of assigning `providerPoolManager.providerPools` followed by `initializeProviderStatus()` independently.

**Step 4: Fix `/api/reload-config` semantics**

After loading `provider_pools.json`, compare provider types with the current canonical state. Emit config-sync events only for changed types, invalidate affected adapters, and retain a single monotonic revision sequence.

**Step 5: Preserve reauthorization atomicity**

Keep the existing guarantee that credential-path persistence succeeds before adapter invalidation or runtime publication. Ensure the new credential path reaches all execution workers before the UI reports the operation as fully applied.

**Step 6: Run the mutation tests**

Run:

```powershell
npm.cmd test -- --runInBand tests/provider-config-mutation-sync.test.js tests/codex-reauthorize-provider.test.js tests/codex-reauthorize-ui-source.test.js
```

Expected: PASS.

**Step 7: Commit the canonical mutation path**

```powershell
git add src/ui-modules/provider-api.js src/ui-modules/config-api.js src/services/service-manager.js src/providers/provider-pool-manager.js tests/provider-config-mutation-sync.test.js tests/codex-reauthorize-provider.test.js
git commit -m "fix(config): publish provider mutations to execution workers"
```

### Task 4: Add acknowledgement and observability safeguards

**Files:**
- Modify: `src/runtime/multi-worker-runtime.js`
- Modify: `src/services/api-server.js`
- Modify: `src/ui-modules/provider-api.js`
- Create: `tests/provider-config-sync-ack.test.js`
- Modify: `src/runtime/runtime-state-snapshot.js`

**Step 1: Add failing acknowledgement tests**

Assert that the control path can distinguish:

- all execution workers applied revision N;
- one worker timed out;
- a worker restarted and applied the current revision during initialization.

**Step 2: Track per-worker applied revisions**

Have execution workers return `provider_config_sync_ack` with worker ID and revision. Track the latest acknowledgement in the master without retaining provider payloads.

**Step 3: Make UI mutation completion explicit**

Wait for bounded acknowledgements from all currently ready execution workers before returning a fully applied success response. If disk persistence succeeded but propagation timed out, return a distinct `CONFIG_SYNC_PENDING` warning rather than claiming that the edit is active everywhere.

**Step 4: Expose safe runtime diagnostics**

Add only revision counters and pending-worker counts to `/runtime/health` and the runtime state snapshot. Never expose credential paths or provider payloads.

**Step 5: Run focused tests**

Run:

```powershell
npm.cmd test -- --runInBand tests/provider-config-sync-ack.test.js tests/runtime-state-snapshot.test.js tests/runtime-worker-topology.test.js
```

Expected: PASS.

**Step 6: Commit acknowledgement support**

```powershell
git add src/runtime/multi-worker-runtime.js src/services/api-server.js src/ui-modules/provider-api.js src/runtime/runtime-state-snapshot.js tests/provider-config-sync-ack.test.js tests/runtime-state-snapshot.test.js
git commit -m "feat(runtime): report provider config propagation status"
```

### Task 5: Verify the regression and prepare production rollout

**Files:**
- Modify: `tests/ops-blue-green-deploy-source.test.js`
- Modify: `docs/ops-blue-green-deploy.md`
- Modify: `docs/yyn-customized-branch-features.md`

**Step 1: Run the provider and runtime suites**

Run:

```powershell
npm.cmd test -- --runInBand tests/provider-*.test.js tests/codex-reauthorize-*.test.js tests/runtime-*.test.js tests/api-server-shutdown.test.js
```

Expected: PASS.

**Step 2: Run the complete test suite**

Run:

```powershell
npm.cmd test -- --runInBand
```

Expected: PASS with no new open handles or worker-shutdown failures.

**Step 3: Build a commit-traceable local image**

Use `scripts/ops/build-image.sh` from a clean commit and verify its `yyn.base_commit` label. Do not build a production image from an uncommitted working tree.

**Step 4: Run a four-process container smoke test**

With one control and three execution workers:

1. edit a harmless provider field and confirm it survives multiple state-event flush intervals;
2. change `checkModelName` and confirm every execution worker uses the new value;
3. disable then enable a test provider and confirm the state does not revert;
4. replace a test credential path and confirm old adapters are invalidated;
5. restart the container gracefully and confirm persisted state remains unchanged;
6. verify `/runtime/health` shows zero pending config acknowledgements.

**Step 5: Update deployment documentation**

Document that the existing mechanism is a lightweight candidate preflight, not automatic active-active blue/green. Add the config-revision and acknowledgement checks to the formal single-writer handoff checklist.

**Step 6: Update the blue-green source test**

Require candidate validation to inspect `/runtime/health` and reject a candidate when config propagation is pending or its execution-worker count is incomplete.

**Step 7: Commit verification and documentation**

```powershell
git add tests/ops-blue-green-deploy-source.test.js docs/ops-blue-green-deploy.md docs/yyn-customized-branch-features.md
git commit -m "docs(ops): gate rollout on provider config convergence"
```

## Production Rollout Gate

After local implementation is complete, production deployment still requires separate authorization. Use the existing candidate snapshot/preflight mechanism, then perform the documented single-writer handoff. Roll back if any of these occur:

- a saved provider field changes back without a new administrator mutation;
- any execution worker reports a config revision behind the control worker;
- provider config acknowledgement remains pending after the bounded timeout;
- OAuth reauthorization succeeds on the control worker but model traffic continues using the previous credential path;
- graceful shutdown changes `provider_pools.json` unexpectedly.
