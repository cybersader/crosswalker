# E2E red ledger

Two files decide which red end-to-end results the nightly run (`.github/workflows/e2e-nightly.yml`) accepts; `scripts/check-known-red.mjs` reads both:

- `tests/e2e/QUARANTINE.md` lists **whole specs** excluded from the verdict. Each quarantined spec counts as an entry of kind `red`, dated by its "Date added" column.
- This file lists **individual cases** allowed to be red, and why.

The run fails when:

- a case is red and is not listed here,
- an entry of kind `red` passed (the entry is stale: delete it in the same change that fixed the case),
- an entry is older than 30 days (fix the case, or re-date the entry with a new reason),
- an entry has no tracked link, or the link does not resolve.

Kinds: `red` must stay red until fixed. `flaky` may pass or fail; use it only for a case shown green in isolation and red in some runs, with that evidence in the reason.

`Case` is the exact `it(...)` title from the spec. `Spec` is the file name under `tests/e2e/`.

| Spec | Case | Kind | Since | Reason | Tracked |
|---|---|---|---|---|---|
| `sssom-import.spec.ts` | the real SSSOM importer retains a missing end and fills it on explicit mapping refresh | flaky | 2026-10-03 | At line 318, `subject_note` reads back as undefined instead of a wikilink, but only inside a full-suite run. In isolation it passed 8 of 8 at `4fa547bc`, so it depends on spec order or shared vault state. | [CHANGELOG Follow-ups](../../CHANGELOG.md#follow-ups) |

## Related

- `tests/e2e/QUARANTINE.md`: specs excluded from the CI smoke journey, with their removal conditions
- `CHANGELOG.md` § Follow-ups: the open obligations entries here point at
