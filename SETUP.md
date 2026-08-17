# Setup

Stand this up from scratch in about 20 minutes. Every teammate follows this same guide against
their **own** Drive folders and their **own** Claude account — see [Team rollout](#10-team-rollout)
for why there is no shared version.

Work through the steps in order. Step 7 fails in confusing ways if steps 2–6 are incomplete.

---

## 1. Prerequisites

- A **claude.ai Pro, Max, Team, or Enterprise plan** with Claude Code on the web enabled. Routines
  are not available on the free plan.
- A **Google account** (consumer Gmail or Google Workspace — both work; the difference is trigger
  quota, covered in [Troubleshooting](#9-troubleshooting)).

On Team and Enterprise plans, an Owner can disable routines for the whole organization at
`claude.ai/admin-settings/claude-code`. If routines are switched off there, nothing in this guide
will work and only an Owner can change it.

## 2. Connect the connectors

Go to [claude.ai/customize/connectors](https://claude.ai/customize/connectors) and connect:

- **Google Drive** — reads the transcript, writes the result file
- **Gmail** — creates the drafts

Both are required. Do this before creating the routine, because the routine form only offers
connectors you have already connected.

> Gmail's connector can create drafts but **cannot send email**. That is a property of the
> connector, not of our prompt, so nothing in this pipeline can send mail on your behalf even if
> the prompt is later edited.

## 3. Create the Drive folders

Create four folders. Nesting the last three inside the first keeps things tidy but is not required.

```
Meeting Transcripts/       ← the workflow root
├── Transcripts/           ← you drop transcripts here (the watched folder)
├── Processed/             ← files land here once handled
└── Outbox/                ← created automatically in step 7
```

`Failed/` is also created automatically in step 7.

Get each folder's ID from its URL. Open the folder and look at the address bar:

```
https://drive.google.com/drive/folders/1Ti9u2KnhQQf2bKzb6r-UaTIx076wcq0R
                                       └──────── this is the folder ID ────────┘
```

Write down the IDs for the **root** and for **Transcripts** and **Processed**. You need three.

## 4. Create the routine

1. Go to [claude.ai/code/routines](https://claude.ai/code/routines) and click **New routine**.
2. Name it something like `Extract tasks from meeting transcripts`.
3. Open [`routine/PROMPT.md`](routine/PROMPT.md) and paste **the fenced block** into
   **Instructions**. Paste only the fenced block, not the surrounding notes.
4. Leave **Select a repository** empty. This routine doesn't need one.
5. Under **Select a trigger**, choose **API**.
6. Under **Connectors**, remove everything except **Google Drive** and **Gmail**.
7. Open the **Notifications** tab and set it to notify you on every run. Runs only happen when a
   transcript actually arrives, so this is one notification per transcript, not per five minutes.
8. Click **Create**.

> Step 6 is a real permission decision, not tidiness. A routine can use every tool from every
> connector attached to it, including writes, without asking you during the run — and claude.ai
> attaches all your connected connectors by default.

## 5. Add the API trigger and generate a token

The URL and token only exist once the routine has been saved, so this is a separate step.

1. Open the routine and click the pencil icon to **Edit routine**.
2. Scroll to **Select a trigger**, click **Add another trigger**, choose **API**.
3. Copy the **URL**. It looks like:
   `https://api.anthropic.com/v1/claude_code/routines/trig_01ABC.../fire`
4. Click **Generate token** and copy it immediately. It starts with `sk-ant-oat01-`.

> **The token is shown once and cannot be retrieved later.** If you lose it, come back here and
> regenerate — which invalidates the old one, so you'd then have to update the Script Property in
> step 6.

The token only triggers this one routine. It grants no read access and no access to anything else
in your account.

## 6. Create the Apps Script project

1. Go to [script.google.com](https://script.google.com) and click **New project**.
2. Name it `Transcript → Tasks`.
3. Replace the contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs).
4. Click the gear icon (**Project Settings**) and tick
   **Show "appsscript.json" manifest file in editor**.
5. Back in the editor, open `appsscript.json` and replace it with
   [`apps-script/appsscript.json`](apps-script/appsscript.json). Change `timeZone` to yours if you
   aren't on US Eastern — it affects how due dates are logged.
6. In **Project Settings → Script Properties**, add these five:

   | Property | Value |
   |---|---|
   | `ROOT_FOLDER_ID` | ID of the workflow root folder |
   | `TRANSCRIPTS_FOLDER_ID` | ID of the watched `Transcripts/` folder |
   | `PROCESSED_FOLDER_ID` | ID of the `Processed/` folder |
   | `ROUTINE_FIRE_URL` | the `/fire` URL from step 5 |
   | `ROUTINE_TOKEN` | the `sk-ant-oat01-…` token from step 5 |

   `OUTBOX_FOLDER_ID`, `FAILED_FOLDER_ID`, and `TASKLIST_ID` are filled in for you by `setup()`.
   Don't set them by hand.

The manifest enables the advanced Tasks service, so you don't need to add it through the
**Services** panel separately.

## 7. Run setup once

1. In the editor's function dropdown, select **`setup`** and click **Run**.
2. Google will ask for authorization. The app is unverified because it's your own script — click
   **Advanced → Go to Transcript → Tasks (unsafe)** and allow. You are granting access to your own
   Drive and Tasks.
3. Read the execution log. A successful run prints the Outbox folder ID, the Failed folder ID, the
   resolved task list ID, and confirms the trigger.

`setup()` is idempotent — re-run it any time you change configuration. It replaces the trigger
rather than stacking a second one.

If it throws `Missing Script Properties: …`, go back to step 6.

To see resolved configuration at any point, run **`showConfig`**. It redacts the token.

## 8. Verify end to end

Use [`sample/sample-transcript.md`](sample/sample-transcript.md) — it contains one task with an
explicit deadline, one with a named owner, and one decision that warrants an email.

1. Upload it to the **Transcripts/** folder.
2. Within 5 minutes, open **Executions** in the Apps Script editor. You should see `tick()` run and
   log `Fired sample-transcript.md → https://claude.ai/code/session_…`.
3. Open that session URL and read the run. Confirm it read the file and wrote the Outbox JSON.
4. Confirm the transcript has moved to **Processed/**.
5. Confirm `tasks-<fileId>.json` appeared in **Outbox/** and matches
   [`routine/outbox-schema.json`](routine/outbox-schema.json).
6. Within another 5 minutes, confirm the JSON has moved to **Processed/** and the tasks appear in
   the **Meeting Followups** list in [Google Tasks](https://tasks.google.com) — with the owner in
   the notes and the deadline on the right task.
7. Open Gmail **Drafts** and confirm the Acme email is sitting there **unsent**.

> A green run status in the routine list only means the session started and exited without an
> infrastructure error. It does not mean the extraction worked. Open the run and read it.

Two isolated checks for when something is wrong, which separate "extraction is bad" from "task
creation is broken":

- **`testFireRoutine`** — fires the routine against the first file in `Transcripts/` without waiting
  for a tick and without moving the file. Tests the URL, token, and headers alone.
- **`testDrainOutbox`** — runs only the task-creation half. Hand-write a JSON file matching the
  schema, drop it in `Outbox/`, and run this.

Worth doing once: drop a non-transcript file (any random PDF) into `Transcripts/` and confirm it
produces `"isTranscript": false`, creates zero tasks, and still moves to `Processed/`.

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Log shows `400` | Routine is paused (resume it at claude.ai/code/routines), or the beta header is missing — don't edit the headers in `fireRoutine_`. |
| Log shows `401` | Token is wrong or was regenerated. Generate a new one (step 5) and update `ROUTINE_TOKEN`. |
| Log shows `429` | You hit your daily routine run cap or your subscription usage limit. The sweep pauses and retries next tick. Check remaining runs at claude.ai/code/routines. |
| `Missing Script Properties` | Step 6 incomplete. |
| Run is green but nothing happened | Green means the session started, not that it succeeded. Open the run and read the transcript for blocked calls or missing connector tools. |
| Routine ran but no Outbox file | Google Drive connector isn't attached to the routine, or the prompt was pasted without the final step. Re-check step 4. |
| Tasks never appear, Outbox file is stuck | Check `Failed/`. A version mismatch or unparseable JSON quarantines the file there rather than retrying forever. |
| `Service using too much computer time` | Apps Script trigger-runtime quota: 90 min/day on consumer accounts, 6 hr/day on Workspace. At a 5-minute interval a folder check uses a tiny fraction of that, so this usually means a runaway loop, not normal use. |
| Files pile up in `Transcripts/` | Every fire is failing. Check Executions for the status code and match it above. After 3 failed attempts a file is moved to `Failed/` so it can't block the queue. |
| Due dates show no time | Expected. The Google Tasks API stores a due **date** and discards any time component. |
| A file is in `Failed/` | Fix the underlying cause, then move it back to `Transcripts/` to retry. |

## 10. Team rollout

**Routines cannot be shared.** Per the Claude Code documentation: *"Routines belong to your
individual claude.ai account. They are not shared with teammates."* Everything a routine does runs
as the account that owns it — its Gmail drafts, its Drive writes, its usage.

So each teammate repeats steps 1–8 in full, with:

- their **own** Drive folders (they can copy the folder structure; they should not share one
  watched folder — see below)
- their **own** routine and their **own** API token
- their **own** Apps Script project

Only these files are shared: `Code.gs`, `appsscript.json`, and `PROMPT.md`. All configuration is in
Script Properties precisely so nobody has to edit the source.

**Don't point two people's scripts at one shared `Transcripts/` folder.** Both would poll it, and
whichever script happened to run first would fire its own routine and move the file — so tasks would
land in a effectively random teammate's list. If you want shared intake, have one designated person
run the pipeline and distribute follow-ups manually.

When the prompt changes, each person must re-paste it into their own routine. There is no central
version, which is the tradeoff for running without an attached repository.

## Known limits

- **Latency is up to ~10 minutes worst case**: up to 5 minutes to detect the file, plus up to 5 more
  to drain the Outbox. The only faster legal interval is 1 minute, at 5× the quota burn — change
  `everyMinutes(5)` in `installTrigger()` and re-run `setup()` if you want it.
- **`/fire` has no idempotency key.** Each POST creates a new session. Moving the file out of the
  watched folder is the only thing preventing duplicate runs, which is why `scanTranscripts()` fires
  first and moves second — and why you shouldn't reorder it.
- **Routine runs draw down both your daily routine cap and your normal Claude usage.** A heavy
  transcript day is a heavy usage day.
- **Transcripts are untrusted input.** Anyone who can drop a file into the watched folder controls
  what the routine reads. The prompt tells Claude to treat transcript text as data rather than
  instructions, and the Gmail connector cannot send mail regardless — but keep the folder's sharing
  settings tight.
