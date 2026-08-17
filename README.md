# Transcript → Tasks

Drop a meeting transcript into a Google Drive folder. A Claude Code routine reads it, extracts the
action items, creates Google Tasks in a **Meeting Followups** list, and leaves Gmail drafts for
anything that needs to be communicated.

**Setup takes about 20 minutes: [SETUP.md](SETUP.md).**

## How it works

```
Drive: Transcripts/          ← you drop a transcript here
        │
        │  (1) Apps Script tick(), every 5 min
        ▼
   scanTranscripts()
        │  POST /fire  { text: "{fileId, fileName, fileUrl, outboxFolderId}" }
        │  then moves the file → Processed/
        ▼
   Claude routine (cloud session)
        │  (2) Drive connector: read the transcript BY FILE ID
        │  (3) extract tasks, decisions, follow-ups
        │  (4) Gmail connector: create drafts (cannot send)
        │  (5) Drive connector: write tasks-<fileId>.json → Outbox/
        ▼
Drive: Outbox/
        │
        │  (6) same Apps Script tick(), drainOutbox()
        ▼
   Google Tasks → "Meeting Followups"
```

The routine never runs on a schedule. It fires only when a file actually arrives.

## Why it's shaped this way

The design is dictated by three platform constraints, each of which rules out the more obvious
approach:

| Constraint | Consequence |
|---|---|
| **There is no Google Tasks connector.** Claude's Google connectors are Drive, Gmail, and Calendar only. | The routine cannot create tasks. It writes a JSON result to Drive and Apps Script — which *does* have the Tasks API — creates them. |
| **Routines are per-account and cannot be shared.** | This repo is a setup kit each teammate deploys into their own account, not a service you stand up once for the team. |
| **Drive has no push trigger, and routines have no "watch folder" trigger.** | Something has to poll. Apps Script polls every 5 minutes and fires the routine only when there's a new file, so the routine itself stays event-driven. |

Two platform behaviors make it safe rather than merely functional:

- **The Gmail connector can draft but cannot send.** "Never send email on my behalf" is enforced by
  the connector, not by prompt wording — it holds even if someone edits the prompt later.
- **The Drive connector can write files**, which is how results get out of the routine without
  hosting a webhook or opening a network allowlist.

## What's here

| File | Purpose |
|---|---|
| [`SETUP.md`](SETUP.md) | Full from-scratch setup, verification, troubleshooting, team rollout |
| [`apps-script/Code.gs`](apps-script/Code.gs) | The whole automation: detection, firing, task creation |
| [`apps-script/appsscript.json`](apps-script/appsscript.json) | Manifest — enables the Tasks service, declares OAuth scopes |
| [`routine/PROMPT.md`](routine/PROMPT.md) | The exact instructions to paste into the routine |
| [`routine/outbox-schema.json`](routine/outbox-schema.json) | Contract between the routine and the script |
| [`sample/sample-transcript.md`](sample/sample-transcript.md) | Test transcript with known action items |

All configuration lives in Apps Script **Script Properties**, so teammates deploy the same source
against their own folders without editing a line of it.

## Requirements

- claude.ai **Pro, Max, Team, or Enterprise** with Claude Code on the web
- **Google Drive** and **Gmail** connectors enabled at
  [claude.ai/customize/connectors](https://claude.ai/customize/connectors)
- A Google account (consumer or Workspace)

## Limits worth knowing

- **Up to ~10 minutes end to end** — up to 5 to detect, up to 5 to create the tasks.
- **Runs count against your daily routine cap and your Claude usage.**
- **Due dates are dates, not times** — the Google Tasks API discards the time component.
- **Transcripts are untrusted input.** The prompt treats their contents as data rather than
  instructions; keep the watched folder's sharing settings tight anyway.
