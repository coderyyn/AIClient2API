# Customized Branch Implementation Plan

Goal: build the long-lived `yyn/customized-branch` with upstream main as baseline plus private/local capabilities for usage observability, cache diagnostics, API Potluck reporting, and optional Codex provider affinity.

Acceptance:
- Official usage cache has a 1 hour default TTL and `refresh=true` bypasses cache.
- Codex usage stats persist account/provider UUID, model, and date dimensions with cache hit ratio.
- API Potluck admin view can inspect distributed key daily and cumulative token usage without user-side key input.
- Same distributed API Potluck key can optionally stick to a deterministic healthy Codex provider for cache reuse; default remains disabled to preserve the approved observability-first strategy.
- Existing local custom changes for logging, sanitization, image interface enhancements, request body limits, and provider weight remain intact.
- Local tests and container smoke validation are run where practical.

Steps:
1. Establish project workflow files and capture branch boundaries.
2. Add focused tests for usage cache TTL and refresh behavior.
3. Implement usage cache TTL and refresh bypass.
4. Add focused tests for model usage account/date/model stats and cache hit ratios.
5. Implement model usage account/date/model aggregation and provider UUID propagation.
6. Add focused tests for API Potluck admin usage summary and optional Codex sticky provider affinity.
7. Implement API Potluck admin usage summary and optional sticky provider affinity.
8. Update decision HTML/docs and run verification, including local container smoke if feasible.
