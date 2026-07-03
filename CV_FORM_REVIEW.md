# CV tailoring + form-filling optimization spec

Review done on Opus; implement on Fable 5. Each item: location → problem → fix →
priority. Suggested order at the bottom. Test each against `RELEASE_CHECKLIST.md`.

## CV tailoring — `bot/modules/cv_tailor_structured.js`

### T1 — [HIGH · speed+cost] Batch per-role bullet rewriting into ONE LLM call
`tailorStructured` loops roles and `await`s `selectAndRewordBullets` **sequentially**
(lines ~388-390). A CV with R roles = R sequential LLM calls + subtitle + profile +
skills-reorder ≈ **R+3 calls (~15-25s per CV)**. This is the pipeline's main throughput
cost.
**Fix:** send all roles in a single prompt (index bullets per role, e.g. `R1[1]…`,
`R2[1]…`), parse the reply back per role, and run the SAME `introducesNewFacts`
verifier per role. On parse failure for a role, fall back to that role's ranked
originals (`ordered.slice(0, MAX_BULLETS_PER_ROLE)`). Cuts to ~3 calls/CV. Keep all
truthfulness rules identical — only the batching changes.

### T2 — [MED · cost] Make skills reordering deterministic (drop an LLM call)
`reorderSkills` (~254-273) spends a whole LLM call just to order categories.
**Fix:** sort deterministically by JD relevance — score each category's
`(label + " " + items)` with the existing `bulletJDScore(text, jdKeywordSet(jd))`
and sort desc, stable by original index. Equal quality, one fewer call, no
rate-limit exposure. (Keep the `weaveKeywordsIntoSkills` step as-is.)

### T3 — [LOW · cleanup] `tailorSubtitle` ignores its `jdExcerpt` arg
Lines ~36/43 accept `jdExcerpt` but the prompt never uses it. Either feed a short
JD snippet in for sharper subtitles, or drop the param.

> Not a change — awareness only: the anti-fab verifier will reject a rewrite that
> adopts a JD tool name absent from the CV even though the prompt invites JD
> terminology. That's correct (truthfulness wins); some rewrites fall back to
> originals by design.

## Form filling — `bot/modules/reed.js` + `bot/modules/linkedin.js`

### F1 — [HIGH · correctness] Verify the tailored CV actually attached
Both `uploadResume` return `true` immediately after `setInputFiles`/`setFiles` + a
fixed delay (Reed reed.js ~685-688 & 696-703; LinkedIn linkedin.js ~485-489 &
507-511). **This is the exact spot behind the recurring "base CV submitted" bug** —
if the input was hidden/wrong or the site silently rejected it, it still reports
success.
**Fix:** after upload, read the filename shown in the CV widget/résumé card and
confirm it contains the tailored file's `path.basename(resumePath)` (scoped to the
CV element — NOT whole body, which false-positived before). Only then return true;
otherwise return false. Downstream already treats false as `cv_not_attached` → skip,
so this just makes the guard real.

### F2 — [MED-HIGH · quality] LLM answers for free-text / long-form questions
- Reed `answerScreeningQuestions`: unmatched free-text inputs are left BLANK (no
  default in the text branch, reed.js ~949-953) → a required open question can block
  submit.
- LinkedIn `buildTextareaAnswer` (~399-423) returns generic static templates for
  cover letter / "why this company" — reads as boilerplate.
**Fix:** add a small `answerQuestion(question, job, profile)` helper that makes ONE
LLM call (JD + profile) for long-form / unmatched required fields. Gate it to
textareas + unmatched required inputs to bound cost. Keep the fast heuristics for
yes/no, years, availability, salary.

### F3 — [MED · correctness] "Default to Yes / first option" is unsafe for negatives
Unknown yes/no radios default to yes/first (Reed reed.js ~842; similar LinkedIn).
Fine for most, wrong on disqualifiers ("have you ever been dismissed/convicted",
"criminal record", "failed a background check").
**Fix:** add a negative-framed detector → answer the safe option (usually "no") for
those; keep the "yes" default otherwise.

### F4 — [MED · robustness] Replace fixed `DELAY()` with explicit waits in upload flow
Where correctness depends on timing (Reed Update→Choose-file modal reed.js ~663/686;
LinkedIn résumé step) use `waitForSelector`/`waitForEvent` instead of fixed sleeps.
Cuts flaky attach failures.

### F5 — [LOW] Reed radio labels use `innerText`
reed.js ~788 uses `innerText`; LinkedIn had to switch to `textContent` for
visually-hidden legends. Add a `textContent` fallback in Reed to avoid missing
hidden-label questions.

### F6 — [LOW · cleanup] De-duplicate Reed's question→answer matching
The pattern matching is copy-pasted across Reed's radio / select / text branches.
Extract one `resolveAnswer(question, kind)` so they stay in sync.

## Suggested order
F1 (bug) → T1 (speed) → F2 (quality) → F3 (safety) → T2 → F4 → F5 → T3 → F6.
Ship after F1-T1-F2-F3 land + smoke-tested; the rest can follow.
