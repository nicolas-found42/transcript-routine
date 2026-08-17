/**
 * Transcript → Tasks
 *
 * Watches a Google Drive folder for meeting transcripts, fires a Claude Code routine
 * to extract action items, and writes the results into a Google Tasks list.
 *
 * This script is the ONLY component that touches Google Tasks. Claude has no Google
 * Tasks connector (only Drive, Gmail, and Calendar), so the routine hands its results
 * back as a JSON file in a Drive "Outbox" folder and this script creates the tasks.
 *
 * Flow, all driven by tick() every 5 minutes:
 *
 *   Transcripts/ --scanTranscripts()--> POST /fire --> [Claude routine]
 *                                                            |
 *                                       reads transcript by file ID (Drive connector)
 *                                       creates Gmail drafts (cannot send)
 *                                       writes tasks-<fileId>.json
 *                                                            v
 *   Google Tasks <--drainOutbox()-- Outbox/
 *
 * Setup lives in SETUP.md. Configure via Script Properties, never by editing this file,
 * so teammates can deploy the same source against their own folders.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Script Property keys. Set these in Project Settings → Script Properties. */
var PROP = {
  TRANSCRIPTS_FOLDER_ID: 'TRANSCRIPTS_FOLDER_ID', // watched folder
  PROCESSED_FOLDER_ID: 'PROCESSED_FOLDER_ID',     // where files go once handled
  ROOT_FOLDER_ID: 'ROOT_FOLDER_ID',               // workflow root, parent of Outbox/ and Failed/
  OUTBOX_FOLDER_ID: 'OUTBOX_FOLDER_ID',           // written by setup()
  FAILED_FOLDER_ID: 'FAILED_FOLDER_ID',           // written by setup()
  ROUTINE_FIRE_URL: 'ROUTINE_FIRE_URL',           // https://api.anthropic.com/v1/claude_code/routines/trig_.../fire
  ROUTINE_TOKEN: 'ROUTINE_TOKEN',                 // sk-ant-oat01-... (shown once at creation)
  TASKLIST_ID: 'TASKLIST_ID',                     // resolved by setup()
  ATTEMPTS: '_ATTEMPTS'                           // internal: fileId -> failed fire count
};

/** Name of the Google Tasks list. setup() creates it if absent. */
var TASKLIST_NAME = 'Meeting Followups';

/** Subfolder names created inside the workflow root by setup(). */
var OUTBOX_FOLDER_NAME = 'Outbox';
var FAILED_FOLDER_NAME = 'Failed';

/** Cap per tick so we stay well inside the 6-minute execution ceiling. */
var MAX_FILES_PER_TICK = 10;

/** Give up firing a given file after this many consecutive failures. */
var MAX_FIRE_ATTEMPTS = 3;

/** Required by the /fire endpoint. Requests without the beta header return 400. */
var ANTHROPIC_VERSION = '2023-06-01';
var ANTHROPIC_BETA = 'experimental-cc-routine-2026-04-01';

/** Bumped if the Outbox JSON contract changes. Must match routine/outbox-schema.json. */
var OUTBOX_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Setup — run this once by hand
// ---------------------------------------------------------------------------

/**
 * One-time setup. Idempotent: safe to re-run after changing configuration.
 *
 * Validates folders, creates Outbox/ and Failed/, resolves the task list,
 * and installs the 5-minute trigger.
 */
function setup() {
  var props = PropertiesService.getScriptProperties();

  // Fail loudly and specifically rather than half-configuring.
  var required = [
    PROP.TRANSCRIPTS_FOLDER_ID,
    PROP.PROCESSED_FOLDER_ID,
    PROP.ROOT_FOLDER_ID,
    PROP.ROUTINE_FIRE_URL,
    PROP.ROUTINE_TOKEN
  ];
  var missing = required.filter(function (key) { return !props.getProperty(key); });
  if (missing.length) {
    throw new Error(
      'Missing Script Properties: ' + missing.join(', ') +
      '\nSet them in Project Settings → Script Properties, then run setup() again.'
    );
  }

  var root = requireFolder_(props.getProperty(PROP.ROOT_FOLDER_ID), 'ROOT_FOLDER_ID');
  requireFolder_(props.getProperty(PROP.TRANSCRIPTS_FOLDER_ID), 'TRANSCRIPTS_FOLDER_ID');
  requireFolder_(props.getProperty(PROP.PROCESSED_FOLDER_ID), 'PROCESSED_FOLDER_ID');

  var outbox = findOrCreateFolder_(root, OUTBOX_FOLDER_NAME);
  var failed = findOrCreateFolder_(root, FAILED_FOLDER_NAME);
  props.setProperty(PROP.OUTBOX_FOLDER_ID, outbox.getId());
  props.setProperty(PROP.FAILED_FOLDER_ID, failed.getId());

  var tasklistId = findOrCreateTasklist_(TASKLIST_NAME);
  props.setProperty(PROP.TASKLIST_ID, tasklistId);

  installTrigger();

  Logger.log('Setup complete.');
  Logger.log('  Outbox folder:  %s', outbox.getId());
  Logger.log('  Failed folder:  %s', failed.getId());
  Logger.log('  Task list "%s": %s', TASKLIST_NAME, tasklistId);
  Logger.log('  Trigger:        tick() every 5 minutes');
  Logger.log('Drop a transcript into the watched folder to test.');
}

/** Installs the recurring trigger, replacing any existing one. */
function installTrigger() {
  removeTriggers();
  // everyMinutes() accepts only 1, 5, 10, 15, or 30. 5 keeps trigger-runtime quota
  // comfortable (90 min/day on consumer accounts, 6 hr/day on Workspace).
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
  Logger.log('Installed tick() trigger, every 5 minutes.');
}

/** Removes all triggers for this script, so re-running setup() never stacks duplicates. */
function removeTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }
  if (triggers.length) {
    Logger.log('Removed %s existing trigger(s).', triggers.length);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/**
 * Trigger entry point. Runs both halves of the pipeline.
 *
 * A tick that overruns its 5-minute slot would otherwise overlap the next one and
 * double-fire the same file, so we take a lock and skip rather than queue.
 */
function tick() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty(PROP.OUTBOX_FOLDER_ID) || !props.getProperty(PROP.TASKLIST_ID)) {
    Logger.log('Not configured yet — run setup() once before the trigger can do anything.');
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log('Previous tick still running; skipping this one.');
    return;
  }
  try {
    scanTranscripts();
    drainOutbox();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Fires the routine for each new file in the watched folder.
 *
 * Ordering matters: fire first, move second. The /fire endpoint has no idempotency
 * key, so moving the file out of the watched folder is the only thing preventing a
 * duplicate run on the next tick. Moving before a successful fire would silently drop
 * transcripts; moving only after a 200 means a transient failure just retries.
 *
 * Drive file IDs survive a move, so the routine can still read the file by ID after
 * it lands in Processed/.
 */
function scanTranscripts() {
  var props = PropertiesService.getScriptProperties();
  var transcripts = DriveApp.getFolderById(props.getProperty(PROP.TRANSCRIPTS_FOLDER_ID));
  var processed = DriveApp.getFolderById(props.getProperty(PROP.PROCESSED_FOLDER_ID));
  var failed = DriveApp.getFolderById(props.getProperty(PROP.FAILED_FOLDER_ID));
  var outboxId = props.getProperty(PROP.OUTBOX_FOLDER_ID);

  var attempts = readAttempts_(props);

  // Snapshot the listing before touching anything. We move files out of this folder as
  // we go, and advancing a live iterator over a folder we're mutating can skip entries.
  var batch = takeBatch_(transcripts.getFiles(), MAX_FILES_PER_TICK);

  for (var b = 0; b < batch.length; b++) {
    var file = batch[b];

    var result = fireRoutine_(file, outboxId, props);

    if (result.ok) {
      file.moveTo(processed);
      delete attempts[file.getId()];
      Logger.log('Fired %s → %s', file.getName(), result.sessionUrl);
      continue;
    }

    // Rate limited: the whole account is capped, so stop the sweep and let the next
    // tick pick up where we left off rather than burning through the remaining files.
    if (result.rateLimited) {
      Logger.log('Rate limited (429). Pausing sweep; retry after %s.', result.retryAfter || 'unknown');
      break;
    }

    var n = (attempts[file.getId()] || 0) + 1;
    attempts[file.getId()] = n;
    Logger.log('Fire failed for %s (attempt %s/%s): %s %s',
      file.getName(), n, MAX_FIRE_ATTEMPTS, result.status, result.body);

    // One unfireable file must not wedge the queue forever.
    if (n >= MAX_FIRE_ATTEMPTS) {
      file.moveTo(failed);
      delete attempts[file.getId()];
      Logger.log('Giving up on %s after %s attempts; moved to Failed/.', file.getName(), n);
    }
  }

  writeAttempts_(props, attempts);
}

/**
 * POSTs to the routine's /fire endpoint.
 *
 * The `text` field is freeform and is NOT parsed by the platform: it reaches the
 * routine as a literal string wrapped in a <routine-fire-payload> block marked as
 * untrusted data. The routine's prompt is written to parse it as JSON and to treat
 * it as data rather than instructions.
 *
 * We send only identifiers, not transcript text — `text` is capped at 65,536
 * characters and a long meeting would overflow it. Truncating would drop the end of
 * the meeting, which is exactly where action items are agreed. The routine reads the
 * full document through the Drive connector instead.
 */
function fireRoutine_(file, outboxFolderId, props) {
  var payload = {
    fileId: file.getId(),
    fileName: file.getName(),
    fileUrl: file.getUrl(),
    mimeType: file.getMimeType(),
    outboxFolderId: outboxFolderId,
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    firedAt: new Date().toISOString()
  };

  var response;
  try {
    response = UrlFetchApp.fetch(props.getProperty(PROP.ROUTINE_FIRE_URL), {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Authorization': 'Bearer ' + props.getProperty(PROP.ROUTINE_TOKEN),
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_BETA
      },
      payload: JSON.stringify({ text: JSON.stringify(payload) }),
      muteHttpExceptions: true
    });
  } catch (err) {
    // Network-level failure, distinct from an HTTP error response.
    return { ok: false, status: 0, body: String(err) };
  }

  var status = response.getResponseCode();
  var body = response.getContentText();

  if (status === 200) {
    var sessionUrl = '';
    try {
      sessionUrl = JSON.parse(body).claude_code_session_url || '';
    } catch (e) {
      // A 200 with an unparseable body still means the session was created.
    }
    return { ok: true, status: status, sessionUrl: sessionUrl };
  }

  if (status === 429) {
    return {
      ok: false,
      status: status,
      body: body,
      rateLimited: true,
      retryAfter: response.getHeaders()['Retry-After']
    };
  }

  return { ok: false, status: status, body: body };
}

/**
 * Reads result JSON written by the routine and creates the Google Tasks.
 *
 * Everything the routine produces arrives here, so this is where malformed output
 * gets quarantined instead of retried in a loop.
 */
function drainOutbox() {
  var props = PropertiesService.getScriptProperties();
  var outbox = DriveApp.getFolderById(props.getProperty(PROP.OUTBOX_FOLDER_ID));
  var processed = DriveApp.getFolderById(props.getProperty(PROP.PROCESSED_FOLDER_ID));
  var failed = DriveApp.getFolderById(props.getProperty(PROP.FAILED_FOLDER_ID));
  var tasklistId = props.getProperty(PROP.TASKLIST_ID);

  // Snapshot for the same reason as scanTranscripts(): we move files out as we go.
  var batch = takeBatch_(outbox.getFiles(), MAX_FILES_PER_TICK);

  for (var b = 0; b < batch.length; b++) {
    var file = batch[b];

    if (!isJsonFile_(file)) {
      Logger.log('Skipping non-JSON file in Outbox: %s', file.getName());
      continue;
    }

    var result;
    try {
      result = JSON.parse(file.getBlob().getDataAsString());
    } catch (err) {
      Logger.log('Unparseable Outbox file %s: %s', file.getName(), err);
      file.moveTo(failed);
      continue;
    }

    if (result.version !== OUTBOX_SCHEMA_VERSION) {
      Logger.log('Outbox file %s has version %s, expected %s; quarantining.',
        file.getName(), result.version, OUTBOX_SCHEMA_VERSION);
      file.moveTo(failed);
      continue;
    }

    if (result.isTranscript === false) {
      Logger.log('%s was not a transcript (%s); no tasks created.',
        result.sourceFileName, result.skipReason || 'no reason given');
      file.moveTo(processed);
      continue;
    }

    var tasks = result.tasks || [];
    var created = 0;
    for (var i = 0; i < tasks.length; i++) {
      // Per-task try/catch: one bad due date shouldn't cost the rest of the batch.
      try {
        createTask_(tasks[i], tasklistId, result);
        created++;
      } catch (err) {
        Logger.log('Failed to create task "%s": %s', tasks[i].title, err);
      }
    }

    Logger.log('%s: created %s/%s task(s), %s draft(s) reported.',
      result.sourceFileName, created, tasks.length, (result.drafts || []).length);
    file.moveTo(processed);
  }
}

/**
 * Creates one Google Task.
 *
 * Two Tasks API quirks worth knowing:
 *  - `due` accepts RFC3339 but the API stores the DATE only and discards the time.
 *    Never promise a due *time* to users.
 *  - There is no assignee field. Every task lands in the running user's own list, so
 *    the extracted owner goes into the notes instead.
 */
function createTask_(item, tasklistId, result) {
  var notes = [];
  if (item.owner) notes.push('Owner: ' + item.owner);
  if (item.notes) notes.push(item.notes);
  if (item.sourceQuote) notes.push('Quote: "' + item.sourceQuote + '"');
  if (result.sourceFileName) notes.push('Source: ' + result.sourceFileName);
  if (result.sourceFileUrl) notes.push(result.sourceFileUrl);

  var task = { title: item.title, notes: notes.join('\n') };

  if (item.due) {
    // Schema uses YYYY-MM-DD; the API wants RFC3339.
    task.due = /^\d{4}-\d{2}-\d{2}$/.test(item.due) ? item.due + 'T00:00:00Z' : item.due;
  }

  Tasks.Tasks.insert(task, tasklistId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drains up to `limit` files from a Drive iterator into a plain array. */
function takeBatch_(iterator, limit) {
  var out = [];
  while (iterator.hasNext() && out.length < limit) {
    out.push(iterator.next());
  }
  return out;
}

function requireFolder_(id, label) {
  try {
    return DriveApp.getFolderById(id);
  } catch (err) {
    throw new Error(label + ' (' + id + ') is not a folder you can open: ' + err);
  }
}

function findOrCreateFolder_(parent, name) {
  var existing = parent.getFoldersByName(name);
  return existing.hasNext() ? existing.next() : parent.createFolder(name);
}

function findOrCreateTasklist_(name) {
  var lists = Tasks.Tasklists.list();
  var items = (lists && lists.items) || [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].title === name) return items[i].id;
  }
  return Tasks.Tasklists.insert({ title: name }).id;
}

function isJsonFile_(file) {
  // Depending on how the Drive connector uploads it, a JSON result can arrive as
  // application/json or as text/plain with a .json name.
  return file.getName().slice(-5).toLowerCase() === '.json' ||
    file.getMimeType() === 'application/json';
}

function readAttempts_(props) {
  try {
    return JSON.parse(props.getProperty(PROP.ATTEMPTS) || '{}');
  } catch (e) {
    return {};
  }
}

function writeAttempts_(props, attempts) {
  props.setProperty(PROP.ATTEMPTS, JSON.stringify(attempts));
}

// ---------------------------------------------------------------------------
// Manual test entry points
// ---------------------------------------------------------------------------

/**
 * Fires the routine for the first file in the watched folder without waiting for a
 * tick, and without moving the file. Use this to check the token, URL, and headers
 * in isolation from task creation.
 */
function testFireRoutine() {
  var props = PropertiesService.getScriptProperties();
  var files = DriveApp.getFolderById(props.getProperty(PROP.TRANSCRIPTS_FOLDER_ID)).getFiles();
  if (!files.hasNext()) {
    Logger.log('Watched folder is empty. Drop a transcript in first.');
    return;
  }
  var file = files.next();
  var result = fireRoutine_(file, props.getProperty(PROP.OUTBOX_FOLDER_ID), props);
  Logger.log('File: %s', file.getName());
  Logger.log('Result: %s', JSON.stringify(result));
  if (result.ok) {
    Logger.log('Open the session to watch the run: %s', result.sessionUrl);
  }
}

/**
 * Runs only the Outbox half. Pair with a hand-written JSON file dropped into Outbox/
 * to separate "extraction is wrong" from "task creation is broken".
 */
function testDrainOutbox() {
  drainOutbox();
  Logger.log('Drain complete. Check the "%s" list in Google Tasks.', TASKLIST_NAME);
}

/** Prints resolved configuration so you can confirm setup() did what you expected. */
function showConfig() {
  var props = PropertiesService.getScriptProperties().getProperties();
  Object.keys(PROP).forEach(function (key) {
    var value = props[PROP[key]];
    // Never print the bearer token in full; the execution log is shareable.
    if (PROP[key] === PROP.ROUTINE_TOKEN && value) {
      value = value.slice(0, 12) + '…(' + value.length + ' chars)';
    }
    Logger.log('%s = %s', PROP[key], value || '(unset)');
  });
}
