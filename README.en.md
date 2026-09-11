<div align="center">

# 🧭 dsh-project-nav

**Anti-drift project governance plugin for DeepSeek Harness (DSH)**

[![version](https://img.shields.io/badge/version-0.9.0-blue)](../../releases)
[![license](https://img.shields.io/badge/license-BSD--3--Clause-green)](./LICENSE)
[![dsh-tools](https://img.shields.io/badge/dsh--tools-%3E%3D0.1.2--rc.1-orange)](https://www.npmjs.com/package/@deepseek-ai/dsh-tools)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](./package.json)

[简体中文](./README.md) | **English**

*Every task starts from architecture. Every file has a home. Everything is traceable.*

</div>

---

> **The governing principle (the one constraint above all others)**
>
> **Every development action must start from the architecture.**
> If the architecture is sound, problems that show up during development are local; if the architecture is wrong,
> no amount of local patching helps — you are stacking bricks on a broken skeleton.

**v0.9.0 is a from-architecture rewrite.** The design contract is [`ARCHITECTURE.md`](./ARCHITECTURE.md).
The old patched-together design (11 tools / 5 parallel ledgers / a begin-done lifecycle) is abandoned wholesale —
this is not a convergence pass, it is a new skeleton. **Decisions may be discarded; facts (F1–F9) may not** —
every recorded incident became a requirement of the new architecture.

---

## 1. The architecture in one sentence

> **One append-only event log (the single source of truth) + an architecture model folded from it (a disposable cache) + a projection layer; gates are queries against the model, and every artifact is a re-render of it.**

```
   ┌───────────────────────────────────────────────────────────────┐
   │ ① EVENTS  .internal/events.jsonl   ← single source (append-only)│
   │   commit{anchor,scope,arch=,phase} · decide{ADR} · node{} · set{}│
   └───────────────────────────┬───────────────────────────────────┘
                               │ pure fold (I1)
   ┌───────────────────────────▼───────────────────────────────────┐
   │ ② MODEL  .internal/runtime/arch-model.json   ← disposable (I3) │
   │   nodes(project/module/feature/artifact) + edges + evidence    │
   │   + mainline vector + decisions + patch pressure               │
   └───────────────────────────┬───────────────────────────────────┘
                               │ all derived (I2)
   ┌───────────┬───────────────┼───────────────┬──────────────────┐
   ▼           ▼               ▼               ▼                  ▼
 nav_graph  PROJECT.md      ARCH-MODEL.md   HTML map        arch-doc fingerprints
 (gates=query) (render)      (render)       (render)        (machine-checked)
```

**Three invariants (machine-checkable)**

| | Invariant | How it is verified |
|---|---|---|
| **I1** | Single source: every model attribute is recomputable from `event log + disk truth`; no second hand-written truth | recompute == cache |
| **I2** | Rendering: map / `PROJECT.md` marker section / `ARCH-MODEL.md` / arch-doc pointers are all generated | hand-edit a rendering → the next render overwrites it |
| **I3** | Disposable: delete all of `.internal/runtime/` → zero governance loss | after deletion, every query returns the same answer |

## 2. Six tools (11 → 6)

The drop in tool count is **not a goal** — it is a *consequence* of "gates became queries, artifacts became renders".

| Tool | Model operation | Typical use |
|---|---|---|
| `nav_graph` | **read**: impact / gaps / coverage / doc routing / arch-doc freshness / health / map | `nav_graph mode=task target=src/host/app.js` |
| `nav_commit` | **write**: record a change intent (anchor + scope + one-line `arch=`) and run the six gates; auto-closes the previous intent by evidence | `nav_commit task="add validation" anchor=PN-F01 arch="architecture unchanged" features=PN-F01` |
| `nav_decide` | **write**: architecture decision (attached to a node; recording resets that node's patch counter) | `nav_decide anchor=PN-F01 reason=… decision=…` |
| `nav_node` | **write**: node upsert / retire with cascade / reference-doc artifacts / legacy migration | `nav_node target=E-F01 name=Editor files=src/a.js` |
| `nav_render` | **write**: regenerate every projection (+ optional arch-doc fingerprint stamp) | `nav_render target=.internal/arch/overview.md` |
| `nav_set` | **write**: mainline vector (doing / next / notDoing / exit) | `nav_set doing="close out shoucang" notDoing="pmg merge"` |

### The behaviour change that matters: **closure needs no second call**

- Registering a change is **one** `nav_commit`; it records `{size, mtimeMs, sha1}` for every file in scope as **evidence**.
- Once you edit those files, **the next tool call from any session** sees the evidence changed and closes the intent.
- **Closure does not depend on a session.** The old rule — "a session can only drive its own actions" — is deleted;
  a dead session's intent is still closed by anyone, on evidence.
- Unchanged evidence means the intent simply stays **in flight** (someone is working = normal, not an orphan).
- The only exit that bypasses evidence: `nav_commit mode=archive id=ACT-N reason=…` (empty scope / mistake / abandoned direction).

## 3. The six gates (all pure queries inside `nav_commit`)

| Gate | Question | Criterion | Strength |
|---|---|---|---|
| **anchor** | Does the architecture node exist? | node in model, or anchored to `.internal/arch/*.md` | reject |
| **scope** | Collides with the anti-goal? Overlaps another in-flight scope? | `notDoing` hit → reject; overlap → warn | reject/warn |
| **mainline** | Are the scoped modules on the mainline? | not referenced by `doing/next` → warn | warn |
| **count** | Patching the same anchor again? | ≥ 3 commits since the last decision → **decision required first** | reject |
| **decision** | Does this change need an architecture change? | missing `arch=` → warn, demanding a one-line answer | warn |
| **completion** | Anything that should have closed but did not? | auto-closes on the next write; reports anomalies | auto + report |

Because gates are **queries** and not a workflow, they cannot create orphan state and cannot be bypassed by
"taking another route" — there is exactly one write entry point.

## 4. Data plane: 7 → 3

| Plane | Path | Lifetime | Version control |
|---|---|---|---|
| **Events** | `.internal/events.jsonl` | permanent | **yes** (single source of truth) |
| **Runtime** | `.internal/runtime/` (model cache · in-flight · locks · diagnostics) | short-lived | **no** (gitignored, rebuildable) |
| **Projections** | `PROJECT.md` marker section · `.internal/ARCH-MODEL.md` · `runtime/map-*.html` · arch-doc `arch-cache` header | regenerable | the projection itself may be committed |

> `.gitignore` must exclude **only runtime**, never `.internal/` as a whole —
> otherwise the event log never reaches version control, a fresh clone can read no decisions,
> and "decisions travel with the repository" is an empty claim.

## 5. Install

```bash
# 1) pack (from the plugin repo root)
npm pack

# 2) install into a profile: edit ~/.dsh/profiles/<profile>/package.json
#      dependencies:  "@dsh-external/project-nav": "file:<repo>/dsh-external-project-nav-0.9.0.tgz"
#      dsh.profile.bundles already lists "@dsh-external/project-nav" (leave it)

# 3) restart dsh — installing and restarting are two different timelines;
#    until the restart, the running process is still the old version
```

**Config** (the plugin entry in the profile):

| Key | Default | Meaning |
|---|---|---|
| `root` | `''` → process cwd | governed workspace root (its `.internal/` holds the event log). **Set it explicitly.** |
| `boundaryWorkspaces` | `''` | workspace-boundary allow-list (project names / relative paths / directory names). Empty binds nothing |
| `autoBindWorkspace` | `true` | master switch for the boundary |

## 6. Migration (legacy ledgers → event log)

The old design kept 5 parallel ledgers: `nav-index.json` / `vector.json` / `nav-actions.json` / `nav-docs.json` / `nav-arch.json`.

```
nav_graph mode=legacy        # inspect the legacy ledgers first (read-only)
nav_node layer=migrate       # one-time fold into events + archive to .internal/legacy/ (read-only)
nav_render                   # rebuild every projection
```

Migration runs **exactly once** (it leaves `.internal/legacy/migrated.json`). After that the old files are gone from
their original location and are read by no code path — there is no second truth. This release deliberately keeps
no two-phase sidecar and no roll-back switch; the archived snapshot is evidence material only.

## 7. Tests

```bash
npm test                  # four suites, 101 cases
npm run test:node-runner  # the same cases through node --test
```

| Suite | Coverage |
|---|---|
| `test/core.test.mjs` | event log / fold / scope resolution / six gates / closure / migration (incl. real index shape & path qualification) (46) |
| `test/architecture.test.mjs` | **invariants** I1·I2·I3·A1·A2·A4·A5·A6 (22) |
| `test/concurrency.test.mjs` | F1 concurrent appends lose nothing / F2 broken-lock race / token check / reentrancy (12) |
| `test/host.test.mjs` | real host code + stub ctx: assembly face, gate wiring, end-to-end, attribution-normalisation regressions (22) |

> Sandbox note: `node --test` spawns child processes over pipes and fails with `spawn EPERM` under some confined
> sandboxes. `npm test` executes the test files directly (`node:test` still runs when a file is the entry point),
> so it is unaffected.

## 8. Versioning rule

> **Every release increments by +0.0.1** — feature additions never jump the middle digit (set by lk, 2026-09-10).
> **Exception: an architecture generational change** may jump, and the changelog must say so explicitly.

`0.8.6 → 0.9.0` is that exception: not a feature addition but a new skeleton (decisions discarded, facts kept).

## 9. Development discipline

1. Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) before changing code — it is this repo's architecture contract, not a manual.
2. Change the contract first when the architecture changes; do not add files outside the contract (a new file *is* an architecture change).
3. Never hand-write a rendering: hand-editing the `PROJECT.md` marker section / `ARCH-MODEL.md` / the map means the next `nav_render` overwrites it.
4. Facts (F1–F9) are never discarded: they are requirements. Only their implementation may change.

## License

BSD-3-Clause © Fishsb (lk)
