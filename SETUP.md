# JobBot — Setup Guide

JobBot is a desktop app that searches Reed.co.uk for jobs matching your
profile, tailors a CV for each one, and **submits real job applications
on your behalf using your Reed account**.

> ⚠️ **This bot applies for real jobs automatically.** Double-check your
> profile, CVs and search terms before starting the bots. You can stop
> either bot at any time from the Dashboard.

## 1. Install

JobBot ships as a portable folder — no installer or admin rights needed.

1. Copy the `dist/win-unpacked/` folder to the other machine (zip it up
   first if sending it over the network).
2. Open the folder and double-click `JobBot.exe`.

Electron and a Chromium browser for automation are bundled inside, so no
other software is required to launch the app.

## 2. First-time setup (in the app)

Work through the numbered pages in the sidebar:

1. **Personal Details** — your name, contact info, location, right to
   work / driving licence, years of experience. These answers are used
   to auto-fill application forms.
2. **Job Site Login** — enter your **Reed.co.uk** email and password.
   These are encrypted on your machine (Windows Credential Manager via
   `safeStorage`) and never leave your device.
3. **CVs** — add one or more CV PDFs. JobBot extracts keywords from each
   and picks the best match for every job.
4. **Search Preferences** — add the job titles/terms you want to search
   for (e.g. "IT Support Analyst"), plus any title keywords you want to
   exclude.

## 3. Optional: enable AI CV tailoring (Ollama)

JobBot can tailor and score each CV against the job description using a
local LLM via [Ollama](https://ollama.com). This is **optional**:

- **Without Ollama**: every CV gets a flat 85% match score and no
  tailoring — jobs still flow through the pipeline and get applied to.
- **With Ollama**: CVs are rewritten per-job and scored properly
  (typically 80–100% on a good match).

To enable it:
1. Install Ollama from https://ollama.com
2. Run `ollama pull llama3.2`
3. Make sure Ollama is running (it starts automatically as a background
   service on Windows after install) — JobBot checks
   `http://localhost:11434` automatically.

## 4. Run the bots

Go to the **Dashboard** and click **Start** on:
- **Reed Bot** — searches Reed, filters jobs, and submits applications.
- **Scorer Bot** — tailors/scores CVs for queued jobs.

The Dashboard shows live logs from both bots plus a summary of queued,
applied, and skipped jobs.

### First Reed login

On the first run, Reed may show a security check (CAPTCHA / "verify
it's you") in the visible browser window the bot opens. Complete this
manually — the bot waits a few minutes for it. After that, your session
is saved (`reed_session.json` in the app's data folder) so future runs
skip the login step.

## Where things are saved

All data is per-user, stored under your Windows profile (the app's
"userData" folder):
- `profile.db` — your profile, CVs, search terms, encrypted credentials
- `queue.db` — job queue and application history (also shown on the
  Dashboard)
- `output/saved_cvs/` — tailored CV PDFs generated for each application
- `screenshots/` — debug screenshots from the bots
- `logs/` — application logs
