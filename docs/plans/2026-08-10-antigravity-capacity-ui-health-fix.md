# Antigravity Capacity And UI Health Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep transient Antigravity model-capacity failures out of account-level health while making the usage UI show the scheduler's real base-health state.

**Architecture:** Classify only the exact Antigravity `503 No capacity available` response as a transient credential-switch event. Preserve the provider's base health, exclude it for the current retry chain, and select another account. In the UI, derive the base badge only from `isDisabled` and `isHealthy`; usage refresh success or failure remains a separate usage-data concern.

**Tech Stack:** Node.js, Jest, browser JavaScript, Docker.

---

### Task 1: Add regression tests

**Files:**
- Modify: `tests/antigravity-rate-limit-cooldown.test.js`
- Modify: `tests/usage-manager-display-source.test.js`

1. Add a unary Antigravity capacity test that expects account switching without any account-level unhealthy call.
2. Add a UI helper test proving successful quota refresh cannot override `isHealthy=false` and refresh failure cannot override `isHealthy=true`.
3. Run the focused tests and confirm both new assertions fail for the current behavior.

### Task 2: Implement the minimal fixes

**Files:**
- Modify: `src/utils/common.js`
- Modify: `static/app/usage-manager.js`

1. Add an exact Antigravity transient-capacity classifier.
2. Use it to skip error counting, request another credential, exclude the failed UUID for the current chain, and avoid retry jitter.
3. Make the base UI badge depend only on scheduler base health and disabled state.
4. Run the focused tests and confirm they pass.

### Task 3: Verify integration

1. Run the Antigravity, provider health, and usage UI test suites.
2. Run the broader Jest suite.
3. Build the local Docker image from the working tree and replace only the local test container.
4. Verify container health and run a controlled capacity-error smoke plus usage UI/API inspection.
5. Do not deploy production or commit unless separately requested.
