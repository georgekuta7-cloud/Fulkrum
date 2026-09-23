# Fulkrum UI Spec — v1 (chat-first)

Status: APPROVED DIRECTION. Visual reference: `6-chatfirst-workers-0.png`
(Stitch project "Fulkrum identity exploration"). Skin: Essential dark —
flat surfaces, one blue accent used sparingly, quiet 12–13px type with one
clear headline size, thin borders, no glow, no gradients. Hierarchy from
spacing and weight, never chrome.

## 0. Thesis

The chat of the active project is the product. Every event that matters —
messages, plans, approvals, worker status changes, proof — happens in one
scrolling flow. The other five views exist for depth (inspect, browse,
configure), never as the place where work happens.

## 1. Global shell (all views)

- Fixed 56px header: brand mark, project switcher (dropdown over
  `bridge.projects` → `openProject`), sandbox pill (green when
  `status.execution.available`, honest "commands: disabled" otherwise),
  casting chips (`projectSettings.routing` head/research/builder, "No
  casting set" when empty — never stale names), spend (`spend.costUsd`,
  ceiling only when set — never an invented cap), run controls
  (pause/resume/stop for live states only; nothing on terminal runs),
  theme toggle, settings button.
- Fixed 64px left nav: Chat, Control Room, Files, Store, Automations,
  Settings. Icon + `aria-label` + `aria-current`. Approval dot on Chat
  when `bridge.approval` is non-null. No item may render another view.
- Toasts bottom-right: errors as `role="alert"`, notices auto-dismiss 6s.
  Raw provider JSON never reaches a toast — one readable line.
- Title ring: `● approval needed` on `document.title` while parked.
- Themes: light + dark token sets; toggle flips `dark` class only.
- Breakpoints: >1400 full multi-column where views use it; 1000–1400
  secondary rails collapse to overlays; <1000 single column, nav stays
  icon-only.

## 2. Chat (core view)

Order in flow: provider banner → failed-run report → pipeline strip →
messages → streaming → plan card → approval card → proof → prompt bar.

- **Provider banner** (only when zero providers configured): "No provider
  has a key…" + link to Settings. Data: `providers.every(p => !p.configured)`.
- **Failed-run report** (only `failed/cancelled/completed`): status, one
  line ("cannot continue, history reads as a report"), **Start a new run**
  (`createRun`). Prompt bar disabled while terminal. (Server 409-guards
  chat here; the UI offers the way out the error names.)
- **Worker strip** (pinned under header while a run is open): one card per
  cast role — role name, routed model (`resolveRouteDisplay`, "not cast"
  when empty), status pill (idle/working/waiting/done with pulse on live),
  current task title, live cost from `byTask`. Source of truth for "where
  are my workers".
- **Pipeline strip**: plan tasks as step chips with status dots +
  `done/total` percent. Redundant with worker strip by design (strip =
  plan progress, cards = who) — if user testing shows duplication pain,
  merge into worker cards and delete the strip.
- **Messages**: user right-aligned cards with timestamps; assistant with
  avatar, name, timestamp. Streaming block labeled with the frame's real
  role (never hardcoded "Head AI"), `aria-live="polite"`.
- **Plan card**: objective, version/status chip, per-plan-task rows bound
  to live task state (running/completed/queued), Approve & Run
  (`control('approve-plan', {planId, planHash})`) + Redraft — only when
  `plan.status === 'draft'` and run is plannable.
- **Approval card** (only when `bridge.approval`): `role="alert"`.
  run.ask → question + answer input + Send + Decline. Else → command
  preview, credential-shape warnings in plain words, Approve (`a`) /
  For run (`r`) / Deny (`d`, opens reason field). Keys never fire while
  typing (INPUT/TEXTAREA/SELECT guard). Escape closes the deny field only
  (`stopPropagation` — never unwinds the app).
- **Proof section** (`<details>`, collapsed by default): `proven/total`
  fraction line ("the fraction of claims proven is the value of the run"),
  one row per claim: ✓ proven / ✕ refuted / ? unproven chip, kind,
  summary, path:line. Data: `bridge.claims`.
- **Prompt bar** (sticky bottom): auto-growing textarea, Ctrl+Enter send,
  disabled on terminal runs, `createRun` offered instead.

## 3. Control Room (per-run dispatch)

- Dispatch map (`buildGraph` over run/plan/tasks/toolCalls/byTask):
  you → Head → task layers; packets on live edges; waiting nodes pulse
  amber; click selects an inline detail card (state, cost, cast model).
  Collapsed by default on narrow screens; the map is a mode, never home.
- Live worker cards (running tasks only): role, routed model, step count.
- Approval banner when parked → jumps to chat. One dock, never two.
- Spend-by-role bars from priced calls only ("No priced calls yet"
  otherwise). Proven fraction with one line to chat evidence.
- Empty (no run): report-style empty state + "Go to chat".

## 4. Files (per-run artifacts)

- Artifact cards: path, created/modified chip, +/− stats, first hunks
  expandable, **Revert to before this write** (`revertArtifact`).
- Time travel: scrubber over event indices (`loadTimeline(seq)`),
  file list at index with per-file **Restore this version**, gaps named
  (`timeline.gaps`), Close returns to live.
- Workspace tree (`tree(path, depth)`): directories descend, files expand
  per-file call history (`fileHistory`). Unreadable paths say so.

## 5. Store (workspace-level, no run needed)

- Marketplace grid: search, trust filter (all/verified/community), cards
  with version, author, license, compat notes, scan findings in plain
  words, download/star signals where present. Install = the approval
  (hash-pinned); staged bytes never leave the server.
- Import box: raw SKILL.md URL → **Stage for review**; registry browser
  (ClawHub-compatible JSON) with per-candidate staging; entries without
  downloadable bytes say so instead of offering a dead button.
- Arsenal rail: installed skills/plugins with version or `local-only`,
  update badges, remove (revokes scoped grants).

## 6. Automations (project-scoped)

- Project gate ("Pick a project first") when `projectId` is null.
- Playbooks: run (inherits approval) / delete; save-from-approved-plan
  form only when a plan is approved.
- Schedules: live/paused chips, next-fire time, caps, last run;
  create form (playbook + `every 30m/6h/1d` + optional cap); pause/resume/
  delete. Copy states no-catch-up behavior.
- Goals: spend-vs-ceiling, runs count, create form (name + ceiling +
  objective + acceptance).
- Blueprints: preview → diff (routing/reasoning/defaults/grants) →
  apply / cancel, with the never-silently-elevate note.

## 7. Settings (workspace-level, no run needed)

- Tabs: Providers / Casting / Sandbox / Budgets / Learnings / More.
- Providers: per-card configured/key-source/auth/temperature/latency —
  latency appears **only after a real probe** ("not probed yet"
  otherwise); inline edit form; custom-provider registration; private
  endpoints name the required flag.
- Casting: all roles, options from configured providers only, via
  `saveRouting`; note that routing never touches approved plans.
- Sandbox: engine specs as reported (image, digest pin state, net=none,
  read-only rootfs) or the honest disabled state with install hint.
- Budgets: live ceilings (write-through, env-locked values say so),
  real usage totals with lower-bound note for unpriced calls.
- Learnings: facts with forget. Audit rail always visible: anchor,
  heads, backups, last-verify + Verify/Back-up wired to real endpoints.
- More: standing grants (create/revoke), storage stats, full tunables
  list. Theme toggle stays in the header.

## 8. Honesty rules (non-negotiable, all views)

1. Measured-only numbers; "not probed yet" over invented values.
2. Hashes, pins, versions verbatim; never truncated without ellipsis.
3. Every empty state names what is missing and the one action that fixes it.
4. Errors say what happened + what to do instead; raw JSON never surfaces.
5. No nav item renders another view; no button offers an unwired action.

## 9. Accessibility acceptance (all views)

Native buttons/inputs/selects; icon buttons carry `aria-label`;
`aria-current` on nav; `role="alert"` on approvals and errors;
`aria-live="polite"` on streaming and toasts; `:focus-visible` rings;
skip link; 24px minimum targets; `prefers-reduced-motion` kills
animation; keyboard-only run-through (open → plan → approve → deny →
send) must complete without a pointer; contrast ≥4.5 both themes.

## 10. Verification gates (per build batch)

TDD per component; `typecheck + lint + test + build` green; UI tests
only on shipped components; dead-file scan (zero unreferenced files);
live smoke (seed → install → run → approve → verdict) before every
commit; reviewer subagent before merge; commit + push.
