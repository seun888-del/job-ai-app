# Pre-release smoke checklist

Run this before tagging a new version. It covers the things the automated tests
**can't** — the Playwright agents, CV handling, and the UI. The pure backend
logic (trial abuse, licensing, download resolver) is covered by `npm test` in
`jobbot_backend`; run that too.

> Rule of thumb: **test the exact area you changed**, plus the "Always" section.

## Automated (fast — do first)
- [ ] Backend: `cd jobbot_backend && npm test` → all green.
- [ ] App: `node --check` passes on any file you edited (or just launch it).

## Always (every release)
- [ ] App launches: `electron .` (kill any running `Job-AI`/`electron` first — an
      installed instance silently blocks the dev launch).
- [ ] No red errors in the DevTools console on the main screens.
- [ ] License page shows the current license/trial status correctly.
- [ ] Version number in the built installer matches `package.json`.

## Agents / applying (if you touched bot/*, browser_launcher, or CV logic)
- [ ] "Connect account" opens Chrome, you can log into Reed/LinkedIn, and the
      session is saved (card shows connected).
- [ ] Start an agent → it searches, scores, and **attaches the TAILORED CV**
      (not the base CV) when it applies. ← recurring bug, always verify.
- [ ] A job that can't attach the tailored CV is **skipped**, not applied with
      the base CV.
- [ ] Hit the daily cap → agents **stop** (not just pause) and the "Daily
      application limit reached" desktop notification fires once.
- [ ] External-apply / training-course / non-WFH jobs are skipped per settings.

## CV tailoring (if you touched cv_tailor/cv_selector/sanitizer)
- [ ] Tailored CV opens cleanly — **no random-letter glyph garbage** in dates.
- [ ] Bullets are ≤ 4 per role and readable (not word-walls).
- [ ] JD keywords appear in the tailored CV.

## License / trial / billing (if you touched licensing or the backend)
- [ ] Fresh trial signup works end-to-end (email arrives with a key).
- [ ] Second trial with a gmail alias / on the same device is refused.
- [ ] Expired trial → agents refuse to start with the upsell message.
- [ ] "Manage subscription" opens the Stripe portal.

## Updates / download (if you touched build.yml, updater, or /download)
- [ ] After publishing: the release has the Windows `.exe` + both `.dmg`s.
- [ ] `/download` (email link) redirects to the NEW version's installer.
- [ ] Installed app auto-updates to the new version.

## Diagnostics (if you touched error telemetry)
- [ ] License → Privacy toggle turns diagnostics on/off and persists.
- [ ] With it ON, a forced error shows up in `GET /admin/errors`.
