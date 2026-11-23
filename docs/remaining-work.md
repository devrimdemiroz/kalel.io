# kalel.io remaining-work plan

## 2026-11-19 update

This update supersedes the older baseline below where the running preview has
changed. The preview now serves the inspected frontend source, renders four
resource-filter categories, and exposes Debug in the sidebar. A reload,
light/dark About-dialog walkthrough, and Containers click produced no browser
console errors in one pass; intermittent errors still need a reproducible case.
At a narrow viewport, fixed two-column sidebar buttons let labels overlap and
create ambiguous click targets. Verify wrapping controls at both ordinary and
narrow widths after rebuilding the embedded frontend.

The current experimental Containers view needs a **layer**, not opaque coloured
boxes: use very low-opacity neutral tint toward white on a dark canvas and
toward black on a light/white canvas, with breathing room between live nodes
and their organic component borders. Keep the namespace and two columns,
selection and edges, unmapped resources, and the opt-in behavior. Do not invent
components or treat this as approval to deploy or to write to a cluster.
Detailed demo-specific visual fidelity remains pending the promised demo.

The [manager](../.github/agents/kalel-manager.agent.md) owns delivery and
verification; [UI](../.github/agents/kalel-ui.agent.md),
[visualization](../.github/agents/kalel-visualization.agent.md), and
[platform](../.github/agents/kalel-platform.agent.md) developers are optional,
bounded specialists. Earlier requests for saved views or an additional cluster
remain separate design work: one server still exposes one configured cluster.

Audited on 2026-11-16 against the previous customization conversations, the
current working tree, and two shared preview tabs.

This is a plan update, not an implementation or deployment. Existing application
changes were left untouched. No rollout was applied and no server was restarted.
Do not treat an earlier "implemented" recap as evidence that the browser received
the feature.

## Requirements recovered from the conversations

- Keep the tool generic and organization-neutral, with connection details and
  real cluster data outside the repository. Preserve KubeView's MIT attribution.
- Use kalel.io branding, a brighter monochrome disco ball, minimal lowercase
  light buttons, subtle borders, and button widths appropriate to their labels.
- Keep controls visibly separated from the canvas. Move graph actions into the
  upper menubar, spacing and shortened names into the right sidebar, and categorized
  checkbox filters into the right sidebar.
- Replace Settings with a copyright/About action, credit and thank KubeView, and
  communicate the fork's permanent open-source intention.
- Switch light/dark themes with readable text everywhere and show the current
  theme on the switch. Make node labels clearer and mark the active layout.
- Follow the latest layout request: paint Structured first, then switch once
  to Organic using those positions, matching the manual Organic action.
  Preserve selection, search, panels, and viewport during later layout changes.
- Keep refresh mode inside the refresh control: live, 15 seconds, one minute,
  off/manual, and offline, with no separate visible "refresh mode" label.
  Show the short cluster destination when connected, otherwise "offline".
- Prioritize declarative rollouts with preview and explicit apply confirmation.
- Maintain one local backend and two usable browser tabs; the user should not
  need to restart the server. Provide a development-only 30-second browser
  refresh while following changes, with slower visible browser demonstrations.

Earlier requests for separate branches/PRs were superseded by direct local
changes without PRs. The intermediate Structured-only request was superseded by
the later request to match the manually selected Organic view.

## Verified baseline

| Area | Evidence | Status |
| --- | --- | --- |
| Branding, light buttons, theme switch, inline refresh, active-layout indicator | Present in source and the inspected preview | Present; not a new implementation task |
| Upper graph menubar, View menu, filter sidebar, copyright/About | Present in [index.html](../frontend/index.html) and [About fragment](../frontend/fragments/about-dialog.html), absent from both inspected preview tabs | Source exists, not delivered; filter markup also broken |
| Local runtime | Health endpoint returned HTTP 200; one observed application listener on loopback port 18000; both inspected tabs had a graph canvas | Running, but serving the older UI |
| Frontend regression suite | `node --experimental-vm-modules --test frontend/tests/refresh-rollout.test.mjs` | 18 passed |
| Backend unit tests | `go test -short ./server/...` | Both server packages passed |
| Declarative rollout implementation | [Dialog](../frontend/js/rollout-dialog.js), [handler](../server/rollout.go), and [apply service](../server/services/rollout.go) exist | Unit-tested; current preview reports rollouts disabled |

These are not full UI acceptance, lint, build, Helm, or real-cluster rollout
results. The frontend tests mock Alpine and G6; they do not initialize the
actual HTML or prove that controls render.

## P0: restore the requested interface

### R1 - Repair the categorized checkbox tree

- [ ] Move the group iteration onto an Alpine `<template x-for>` containing the
  category element in [index.html](../frontend/index.html#L128).
- **Confirmed defect:** iteration is currently on `<details>`. An isolated
  browser reproduction using the bundled Alpine produced an empty heading,
  `Cannot read properties of undefined (reading 'children')`, and
  `group is not defined`.
- **Acceptance:** all four categories and all 12 supported resource-kind
  checkboxes render; categories expand/collapse; filtering and "hide empty
  sets" work, persist, and preserve the current view. Do not reintroduce Secrets.
- Add a focused real-DOM regression check; the existing mocked tests did not
  catch this failure.

### R2 - Deliver current source to the single preview backend

- [ ] After R1, rebuild and replace the owned preview process, keeping one
  loopback-only backend and the existing external connection configuration.
- **Confirmed gap:** HTTP-served HTML and both inspected tabs still have
  Settings, no View menu, no new upper action bar, and no filter groups.
  A browser refresh alone cannot update this binary's embedded files:
  [frontend-fs.go](../frontend-fs.go#L13) embeds the frontend.
- **Acceptance:** verify health and compare served HTML/assets with the source
  being tested; refresh both tabs and demonstrate the upper menubar, View menu,
  functional filter tree, and copyright/About action. The user does not restart
  anything manually. Report when refreshing will actually reveal changes.

## P1: finish functionality and browser acceptance

### R3 - Preserve settings when removing Settings

- [ ] Restore a minimal Debug toggle in the View menu or another appropriate
  non-modal control.
- **Confirmed gap:** the old Settings modal exposed Debug. The current
  [configuration](../frontend/js/config.js) still supports it, but the new
  [interface](../frontend/index.html) has no control for it.
- [ ] Verify spacing, shortened names, and hide-empty-ReplicaSets controls
  immediately affect the graph and survive reload.
- [ ] Preserve changed spacing when switching layouts:
  [layout presets](../frontend/js/graph-utils.js#L12) capture spacing at module
  load, while [toolbar actions](../frontend/js/main.js#L586) reuse those presets.
  Add a focused spacing-change-then-layout-switch regression check.
- **Acceptance:** no existing non-Secret setting is lost during the redesign;
  no old Settings modal remains; About contains attribution and the requested
  open-source statement without changing the MIT license.

### R4 - Verify theme and text throughout the actual UI

- [ ] Test both directions of theme switching with menus, resource details,
  events, logs, About, rollout editor, errors, and disabled controls visible.
- [ ] Check new and updated nodes after changing theme, not only nodes already
  present. The graph's default label color is initialized in
  [main.js](../frontend/js/main.js#L68); the toggle recolors existing nodes.
- [ ] Verify white, readable dark-mode labels, dark light-mode labels, selected
  node emphasis, active-layout styling, and minimal content-sized buttons.
- **Status:** source/CSS and a mocked theme test exist; full browser acceptance
  of the redesigned interface is unfinished.
- **Acceptance:** no unreadable text or theme-induced layout/viewport reset,
  including after live updates, at ordinary and narrow viewport widths.

### R5 - Verify layout, refresh, and connection behavior end to end

- [ ] Demonstrate Structured paint followed by exactly one Organic transition;
  compare its result with manually clicking Organic. Do not repeat the startup
  transition on refresh or reconnect.
- [ ] Exercise layout changes, filtering, search, same-namespace refresh, and
  resource updates while a node is selected and its details are open.
- [ ] Observe actual 15-second and 60-second requests, manual refresh, live
  reconnect, and offline cancellation/no-new-request behavior. Restore the
  user's chosen mode after the demonstration.
- [ ] Verify the destination/offline indicator and decide how connected
  polling/manual modes should read. Currently
  [connectionLabel](../frontend/js/main.js#L190) reports "offline" for every
  non-live mode, even after successful polling; the existing test explicitly
  expects this, but that may not match the user's meaning of connected.
- **Status:** behavior has focused unit coverage, not complete real-browser
  acceptance. Offline is a paused in-memory view, not a downloaded cluster copy.

### R6 - Make declarative rollouts demonstrably usable

- [ ] Demonstrate disabled/enabled capability states and the real dialog against
  a synthetic or disposable test target before calling the feature delivered.
- [ ] Exercise invalid YAML, namespace mismatch, dry-run preview, edited/stale
  preview rejection, confirmation, forbidden/conflict errors, and graph updates
  after a successful apply.
- **Status:** code implements one `apps/v1 Deployment`, server-side dry-run and
  apply without forced ownership; unit tests pass. The current preview has
  rollouts disabled, so the Deploy action is intentionally hidden.
- **Acceptance:** prove preview and explicit apply with an isolated fake API
  or disposable cluster. A rollout against the connected cluster is a separate
  authorized action, not part of this audit. Preserve disabled-by-default
  behavior and namespace-scoped write permissions.
- Multi-document YAML, other workload kinds, rollback, and rollout-history UI
  are not implemented and are not assumed requirements of the original request.

### R7 - Verify two tabs really work with one backend

- [ ] Verify simultaneous SSE connections, changing namespace in one tab,
  reconnect, and offline/polling modes without disrupting the other tab.
- **Known limitation to check:** [events.js](../frontend/js/events.js#L22)
  persists a shared client ID in localStorage, and
  [namespace registration](../server/routes.go#L168) groups by that ID.
  [main.js](../frontend/js/main.js#L234) already warns that another tab's
  namespace change can stop live updates. Two open canvases alone do not prove
  independent functioning.
- [ ] Confirm intended namespace visibility. The observed preview exposes one
  namespace; do not silently broaden its scope. The app connects to one
  configured cluster, not a selectable multi-cluster browser.
- **Acceptance:** demonstrate both tabs' supported behavior and clearly resolve
  or document interference; no duplicate backend and no default-context change.

## P2: close the development and validation gaps

### R8 - Supply the requested development feedback loop

- [ ] Add an opt-in, development-only 30-second browser reload while changes are
  being followed, disabled during rollout edits/confirmation.
- [ ] Ensure frontend edits actually reach the preview automatically or through
  the managed rebuild/restart workflow. The existing
  [Air configuration](../.dev/air.toml#L22) watches Go/templ, not HTML/JS/CSS.
- **Status:** neither requested browser reload nor frontend-file watching is
  provided by the inspected application/configuration. Reloading stale embedded
  assets every 30 seconds would not solve R2.
- **Acceptance:** demonstrate a visible UI change without user-managed server
  restarts; preserve normal production behavior and allow reload to be stopped.

### R9 - Close console and automated-check coverage

- [ ] Capture actual console/page errors during the R2-R7 browser walkthrough,
  fix reproducible failures without removing functionality, and rerun checks.
- [ ] Run frontend tests and server-handler tests from the normal test path:
  [make test](../makefile#L57) currently runs only the service package.
- [ ] Include frontend changes and these tests in
  [CI](../.github/workflows/ci.yaml): its path filters use `public/**`, not
  `frontend/**`, and it currently relies on `make test`.
- [ ] After implementation, run lint, relevant tests, native build, and Helm
  validation for changed templates. Use only synthetic fixtures for UI tests.
- **Acceptance:** the new HTML and both new rollout test layers are exercised;
  passing the current 18 mocked tests is not the sole completion criterion.

### R10 - Align deployment permissions and documentation

- [ ] Remove unused Secret read privileges from
  [chart RBAC](../deploy/helm/kubeview/templates/service-account.yaml#L32) and the
  [permissions appendix](../readme.md#appendix-a-kubernetes-permissions), consistent with the existing
  no-Secret-list/watch implementation. Do not remove unrelated image-pull/TLS
  Secret configuration.
- [ ] Verify rollout RBAC in single-namespace and multi-namespace chart modes;
  its opt-in Role is deliberately namespace-scoped, not cluster-wide.
- [ ] Update user documentation after browser verification, clearly separating
  shipped behavior, optional rollout capability, and development-only tooling.
- **Acceptance:** source, installed permissions, documentation, and demonstrated
  behavior agree; no real endpoints, kubeconfigs, logs, or cluster exports enter
  the project.

## Execution order and completion rule

1. R1 -> R2: fix the known rendering failure, then deliver current embedded UI.
2. R3-R7: finish settings parity and verify the actual interactive workflows.
3. R8-R10: close the feedback-loop, automated coverage, and deployment/doc gaps.

A checkbox is complete only with the relevant test or browser evidence and, for
visible features, confirmation that the running preview serves that version.
Leave unavailable optional features explicitly disabled rather than declaring
them missing code or enabling cluster writes implicitly.
