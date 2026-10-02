---
name: ux-principles
description: Crosswalker's product and UX principles as one checklist. Load BEFORE designing or changing any user-facing surface (wizard, workbench, settings, modals, views, notices, recipe library, mapping review) and before asking the owner a UX question. Passing this checklist IS the authorization to build; the owner reviews outcomes, not directions.
---

# Crosswalker UX principles

## Authority (read first)

The owner has set these principles once. An agent whose design passes the checklist below **builds it**: no "is this the right direction?" question to the owner. Asking the owner to bless a direction the principles already settle is itself a failure; it means this skill is missing something, so add it here instead.

Escalate to the owner only when:
- two principles genuinely conflict for this surface and no option satisfies both, or
- the change is irreversible for users (destroys data, breaks saved artifacts, changes a public schema major), or
- it ships (merge to main, release).

Even then, escalate with a decision card (see "Asking" below), never an open question.

## The product, in one line

A reification engine for Markdown plus frontmatter: one source becomes whatever vault shape the team wants, across the ontology lifecycle (import, map, query, share, maintain), with the user in control at every stage. Compliance teams are the launch audience; the engine is general.

## Checklist

| # | Principle | Test for the surface you are building |
|---|---|---|
| 1 | **UI first, config is the escape hatch** | Can a user do this without touching JSON, a CLI, or a file? If a headless capability lands without UI, the gap is named and tracked the same session |
| 2 | **Feels magical: the UI answers the confused first-timer** | Walk it as a GRC user who has never seen it. Every question they would ask (what is included by default? what happens to my vault?) is answered in place: a quiet line, a live preview, sensible ordering. Not by docs |
| 3 | **Previews in vault terms at the decision point** | Show what a choice does to the vault (folder, note, property, link, edge note) where the choice is made |
| 4 | **Intent-level controls with strong defaults** | Is this one intent, expressed once (a Depth dial), not N row edits? Defaults already good for a user who never opens the control; fine-tuning stays available underneath |
| 5 | **Reification plus control** | Describe import-side work as both halves: more of the source becomes real vault structure, and the user controls how |
| 6 | **Chosen, never guessed** | Never preselect ownership, refresh targets, or which set a source belongs to. Default to the safe new thing; a match may only *offer* ("Looks like X. Refresh it instead?") |
| 7 | **Identity, never path** | Nothing in the UI infers meaning from a vault path or file name. Use minted ids |
| 8 | **Cache lag is not absence** | "Not indexed yet" is shown as indexing, never as empty or missing |
| 9 | **Errors are actionable** | Plain-language cause plus next action. Never a bare `err.message`. Cite the debug log only if the message also tells the user how to enable it |
| 10 | **Copy rules** | Sentence case (lint enforced). No em dashes in UI strings. Compliance-first plain language; no internal vocabulary (Tier 2, SSSOM, STRM, sqlite) in UI or README |
| 11 | **Scale is normal** | Works at 369 columns and tens of thousands of rows: search or filter, attention hierarchy, collapse the default tail, windowed lists |
| 12 | **Solve the shape, not the instance** | Is the control a composable capability or one more special case? Prefer the capability |
| 13 | **Additive, never breaking** | Saved recipes, configs, and sets written by earlier versions keep working. New options are optional fields with defaults. Partial is fine; breaking is not |
| 14 | **Lifecycle framing** | Name top-level surfaces by lifecycle stage and user outcome. Not "Blueprint"; a recipe is one artifact inside the lifecycle |
| 15 | **Both themes, desktop first** | Screenshot-verify light and dark (`bun run e2e:xvfb -- --spec tests/e2e/visual-*.spec.ts`). Desktop is primary; mobile verification is a later roadmap item |
| 16 | **Bases, not Dataview** | Query surfaces use Obsidian Bases |

## Verifying before calling it done

- Screenshot the surface in both themes and read the PNGs yourself. Never ask the owner to eyeball.
- For a substantial new surface, run one Fable UX-consultant round over the screenshots (concrete fixes only: surface, file, exact current string, exact replacement).
- Unit tests plus the e2e spec for the flow.

## Asking (when escalation is genuinely required)

A decision card: **What this is** (plain, terms defined inline) / **In practice** (what the user sees, effort, reversibility) / **Pros** / **Cons** / **Recommendation**. Plain names, no codenames, answerable from the top of the card alone. Never ask the owner an internal-architecture question framed in internal terms; translate it into what a user sees, or decide it yourself under this checklist.

## Sources

Each row condenses owner direction recorded in project memory (`feedback_ui_first_config_escape_hatch`, `feedback_import_wizard_ux_direction`, `feedback_morphing_engine_framing`, `feedback_reification_plus_control_framing`, `project_refresh_is_chosen_never_guessed`, `project_reimport_identity_reconciliation`, `project_cache_lag_is_not_absence`, `feedback_errors_must_be_actionable`, `feedback_no_em_dashes_in_ui`, `feedback_readme_user_facing_surfaces`, `feedback_solve_the_essence`, `feedback_shift_left_additive_evolution`, `feedback_lifecycle_not_blueprint`, `feedback_soft_light_theme`, `project_desktop_primary_mobile_later`, `feedback_fable_ux_consultant`, `feedback_executive_decidable_decisions`). When the owner gives new UX direction, add it to the memory file AND a row here in the same session.
