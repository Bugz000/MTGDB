/**
 * ============================================================================
 *  CHANGELOG / STATUS — read this first if picking up this file cold
 * ============================================================================
 *  ORIGINAL GOAL: a single-file, self-hosted, self-healing MTG card database
 *  that aggregates MTGJSON + ManaPool (sales history) + Scryfall (full card
 *  data, rulings, Tagger tags) into one SQLite DB keyed by scryfall_id, with
 *  a Scryfall-syntax search API, comprehensive TUI, and (eventually) a
 *  matching frontend. Must survive crashes/reboots/corrupt downloads
 *  indefinitely without manual intervention.
 *
 *  MOST RECENT FIXES (confirmed via live user testing, newest first):
 *  - [FIXED, CONFIRMED BROKEN VIA LIVE TESTING] The "real card back photo"
 *    feature below shipped with a genuinely broken URL: it built an image
 *    request from a card's `card_back_id` (0aeebaf5-8c7d-4636-9e82-8c27447861f7)
 *    using the same SCRYFALL_IMG_BASE/type/face/d1/d2/id.jpg path used for
 *    real card images. That ID identifies the *back design*, not a
 *    fetchable image on Scryfall's per-card CDN — every request 404'd, so
 *    every single-faced card silently kept showing the SVG placeholder
 *    (confirmed live: user checked Sol Ring's own Card Back ID and it
 *    matched, but the flip still showed the SVG). Replaced with
 *    GENERIC_CARD_BACK_PHOTO_URLS, a short list of actual direct image
 *    URLs (Scryfall's own documented "no back face" fallback asset first,
 *    a known photo mirror as backup), tried in order until one downloads —
 *    see ensureGenericCardBackPhoto() in Section 8. None of these were
 *    fetch-verified from inside this sandbox (network tooling here has its
 *    own bot-detection separate from this server's own runtime fetch), so
 *    if the symptom recurs, check vLog's CACHE_ERR output at boot — it now
 *    logs every URL tried and why each one failed.
 *  - [ADDED] Colorised live log endpoint: vLog() now also appends every
 *    event to an in-memory ring buffer (recentLogEntries, capped at
 *    LOG_BUFFER_MAX entries) tagged with the same {color-fg} bucket it
 *    already computes for the TUI. `GET /api/log` returns that buffer as
 *    JSON (supports ?since=<id> for incremental polling); `GET /log` is a
 *    small self-contained HTML page that polls /api/log and renders it
 *    dark-terminal-style with the exact same color-per-tag scheme as the
 *    blessed TUI log panel, auto-scrolling to the latest line. Buffer is
 *    in-memory only (bounded, resets on restart) — audit_log (Section 4)
 *    remains the durable, restart-safe record; this is the "watch it live
 *    without SSHing into the TUI" view.
 *  - [ADDED] Generic single-faced card back is now a real photo instead of
 *    a drawn SVG: ensureGenericCardBackPhoto() downloads a real photo of
 *    the standard Magic card back once (see GENERIC_CARD_BACK_PHOTO_URLS —
 *    and the fix entry directly above for why this isn't Scryfall-ID-based
 *    anymore), caches it to disk, and every place that used to serve
 *    GENERIC_CARD_BACK_PATH (the SVG) now serves the real photo whenever
 *    it downloaded successfully. The hand-drawn SVG is kept as-is and
 *    still generated on boot, but is now strictly the last-resort fallback
 *    (photo download failed / not yet completed) rather than the default —
 *    see ensureGenericCardBack() in Section 8 (image cache) for the
 *    fallback chain.
 *  - [FIXED] Card flip was fade-swap-based and raced the image load,
 *    frequently showing no visible change ("just flashes"); replaced with
 *    a real two-face CSS 3D flip (see GIT PUSH SUMMARY above for detail).
 *    Also re-added the layout-based short-circuit so non-double-faced
 *    cards' back face never hits the network — necessary now that both
 *    faces load unconditionally on every card view, not just on click.
 *  - [FIXED, CRITICAL] Boot took up to ~15 minutes before the web UI/API
 *    was reachable at all — see full entry further down.
 *
 *  EARLIER FIXES (confirmed via live user testing, not just theory):
 *  - [FIXED] Scryfall bulk sync was 100% broken: used `download_uri` (field
 *    doesn't exist) instead of `jsonl_download_uri`, and assumed a plain
 *    JSON array instead of the real format (gzip'd JSONL). Rewrote as a
 *    generic streamJsonlGz() helper used by all four Scryfall bulk types.
 *  - [FIXED] Fake/guessed Tagger GraphQL endpoint (tagger.scryfall.com/
 *    graphql) does not exist — replaced with the REAL official bulk-data
 *    types `oracle_tags` and `art_tags`, joined at query time via
 *    oracle_id/illustration_id (see oracle_tags/illustration_tags tables).
 *  - [FIXED] ManaPool dedup bug: a composite UNIQUE index on
 *    (scryfall_id,date,price,condition,foil,quantity,language) silently
 *    discarded genuinely-distinct sales that happened to share every
 *    tracked value (e.g. two line items in one batch at the same
 *    timestamp) — this showed up as "finding dupes on a fresh run" and was
 *    real data loss. Conflict resolution is now on the `id` primary key
 *    alone, with an occurrence counter folded into the hash to disambiguate
 *    genuinely-simultaneous sales while still deduping cleanly on re-parse
 *    of the same file.
 *  - [FIXED] import_audit.expected_row_total used MAX() to accumulate
 *    across audits, so one stale inflated value (from before the dedup fix
 *    above) could never self-correct and triggered a full ManaPool
 *    re-ingest on every single audit cycle forever. Now overwrites with the
 *    current run's value directly.
 *  - [FIXED] Search was pure boolean filtering with alphabetical ordering —
 *    "avacyn" or "sol ring" surfaced unrelated alphabetically-early matches
 *    above the actual card. Reworked: consecutive bare words are grouped
 *    into one phrase, matched via FTS5 PREFIX search per word (narrow
 *    "fuzzy" — liliana matches liliana's, never frederick), and results
 *    default to relevance ordering (exact name > name starts-with > name
 *    contains > everything else) instead of alphabetical when no explicit
 *    order: is given. Price sort (order:usd/eur) now pushes NULL prices
 *    last regardless of direction instead of interleaving them.
 *  - [FIXED] TUI freezing for 5+ real seconds during big ingests: batch
 *    transactions are now run via pauseFlushResume() (generic helper),
 *    which pauses the source stream, runs the transaction, and resumes on
 *    the next tick — giving the 1s TUI redraw and HTTP requests a real
 *    chance to interleave instead of one giant synchronous block.
 *  - [FIXED] Removed noisy MANAPOOL_DEBUG sample-entry dump (was spamming
 *    the log panel every run now that the file format is confirmed).
 *  - [ADDED] retryAsync() generic backoff-retry wrapper applied to MTGJSON/
 *    ManaPool/Scryfall downloads, to survive transient "terminated"/network
 *    blip failures without waiting a full 24h for the next cycle.
 *
 *  STILL OUTSTANDING / NOT DONE (priority order set by the user):
 *  - [DONE] Disk space budget worker (Section 8B): total footprint capped
 *    at DISK_BUDGET_TOTAL_BYTES (env DISK_BUDGET_GB, default 8GB), split
 *    DISK_BUDGET_CACHE_PERCENT (env, default 40%) to the image cache and
 *    the rest to MTGJSON/ManaPool/Scryfall archives + DB snapshots
 *    combined. Runs on its own DISK_AUDIT_INTERVAL_MS loop (default 5m).
 *    Archive pool culls strictly oldest-first (snapshot files and dated
 *    backup folders mixed into one age-sorted list), always keeping at
 *    least the single newest snapshot and the single newest dated folder
 *    per source so self-healing/rehydration never loses its last resort.
 *    Image cache pool culls by USAGE, not age — see next item.
 *  - [DONE] Usage-weighted image cache eviction: image_cache gained
 *    hit_count/last_hit_at, incremented only when an image is actually
 *    served to a live request (recordImageHit — never on opportunistic
 *    background preload, so a never-viewed preloaded image stays at 0 and
 *    is first to go). The disk budget worker culls lowest hit_count first,
 *    oldest last_hit_at as tiebreaker, regardless of how recently a file
 *    landed on disk — a popular old image survives over an unpopular new
 *    one.
 *  - [TOP PRIORITY, IN PROGRESS] Full Scryfall grammar coverage. This pass
 *    added: !exact-name matching, real m:/mana: symbol-multiset matching
 *    (via a registered MANA_MATCH SQL function, replacing a naive exact-
 *    string check), devotion:, produces:, indicator: (two new color-mask
 *    columns), ft:/flavor: text search, unique:cards/art/prints properly
 *    implemented via a ROW_NUMBER() window (was parsed but silently
 *    ignored before), and a dozen more is: flags (dfc/mdfc/paper/arena/
 *    mtgo/digital/funny/extra/colorless/multicolor). Still not covered:
 *    regex oracle search, function:, include:extras, cube:/in:/new:/
 *    prefer: — see Section 15's doc comment for the exact current list.
 *  - [DONE THIS ROUND] Double-faced card images: image_cache now keyed by
 *    (scryfall_id, type, face) — required a table-rebuild migration since
 *    SQLite can't ALTER a primary key in place (existing rows assumed
 *    'front', the only kind ever cached before). On ANY image touch (hit
 *    or miss), a background low-priority pass (queueImagePreload) fills in
 *    every other size for the front face, plus every size for the back
 *    face if the card's layout is genuinely double-faced (transform/
 *    modal_dfc/double_faced_token/reversible_card — checked against real
 *    layout data, not guessed). Background fetches share the same rate
 *    limiter as on-demand fetches but sit in a separate low-priority queue
 *    that only gets a slot once the urgent queue is empty, so a live
 *    request can never be delayed by opportunistic preloading. Route is
 *    `/cache/:id/:type.jpg?face=back` (defaults to front).
 *  - [FIXED THIS ROUND, not grammar-related] ManaPool completeness audit
 *    was comparing live rows WHERE source_date=today against an expected
 *    total — but a sale re-seen in today's rolling window keeps its
 *    ORIGINAL source_date forever (correct dedup behavior), so this
 *    comparison was permanently, falsely convinced data had gone missing
 *    and re-ingested the same file on every audit cycle. Replaced with a
 *    global high-water-mark check (total row count should only grow; a
 *    meaningful drop below the historical max is the real signal).
 *  - [VERY LOW PRIORITY] Real worker_threads split (frontend/HTTP vs. DB
 *    ingest on separate threads) — not needed yet per explicit user
 *    direction; cooperative yielding (pauseFlushResume) already keeps the
 *    event loop responsive, which was the actual reported problem.
 *  - [ ] New matching frontend (index.html) reflecting the current API
 *    shapes, with a full "intelligence panel" showing every stored field
 *    per card in sections — user's own index.html already covers a good
 *    chunk of this; no ground-up rewrite has been done.
 *  - [ ] Express/TUI given deliberate priority over ingest CPU time beyond
 *    what cooperative yielding already provides.
 *  - [ ] Class-based/DRY refactor of the codebase per the user's stated
 *    "generic function -> class when grouping is needed" preference — only
 *    partially applied (AsyncMutex, retryAsync, streamJsonlGz,
 *    pauseFlushResume are the generic pieces so far).
 *  - [ ] /log viewer is intentionally basic (poll-based, in-memory only,
 *    no tag/level filtering, no persistence across restarts). If it turns
 *    out to matter, upgrade path is: swap polling for SSE/WebSocket push,
 *    and/or back it with audit_log (already durable) instead of the
 *    in-memory ring buffer for history that survives a restart.
 *
 *  If you are a different model/session picking this up: the code compiles
 *  (`node --check server.js` passes) and the search/parsing logic has been
 *  unit-tested in isolation (see the conversation this file came from for
 *  the exact test harnesses used), but there is NO live end-to-end test
 *  against real MTGJSON/ManaPool/Scryfall data in this environment (no
 *  network access during development) — treat "compiles and passes offline
 *  logic tests" as the actual confidence level, not "verified working in
 *  production."
 * ============================================================================
 */

/**
 * ============================================================================
 *  MTG ORACLE DAEMON v4.0 — "BEDROCK" EDITION
 * ============================================================================
 *  A single-file, self-healing, self-sustaining Magic: The Gathering card
 *  database, price-history cache, and image proxy — designed to be run once
 *  and never think about again: `node server.js` and it should populate
 *  itself, keep itself in sync, and repair itself indefinitely, across any
 *  number of crashes, power outages, corrupt downloads, or partial writes.
 *
 *  Data sources:
 *    - MTGJSON AllPrintings.json     (canonical multi-source card data)
 *    - ManaPool singles.json.gz      (rolling recent-sales + live listing data)
 *    - Scryfall Bulk Data            (default-cards jsonl.gz — near-total card metadata)
 *    - Scryfall Rulings bulk data    (official rulings text per card)
 *    - Scryfall single-card API      (lazy per-card enrichment + slow full audit)
 *    - Scryfall image CDN            (card art, cached to disk by Scryfall ID)
 *    - Scryfall Tagger data          (oracle_tags/art_tags official bulk types)

 *
 *  --------------------------------------------------------------------------
 *  RESILIENCE ARCHITECTURE (read this before touching the code)
 *  --------------------------------------------------------------------------
 *  1. SUPERVISOR / WORKER SPLIT. The process that the user runs is a tiny,
 *     dumb supervisor that forks a worker (this same file, re-invoked with
 *     an env flag) and watches it. If the worker crashes OR hangs (detected
 *     via a heartbeat the worker sends every few seconds), the supervisor
 *     kills it and restarts it with exponential backoff, forever. This
 *     exists specifically because a single missed edge case deep in a
 *     parsing pipeline should never require the user to notice and manually
 *     restart anything.
 *  2. NOTHING IS ALLOWED TO THROW OUT OF AN EVENT-STREAM CALLBACK. Every
 *     single `stream.on('data', ...)` handler in this file is wrapped in a
 *     try/catch that logs-and-skips the offending record. A record-level
 *     throw escaping a stream callback is exactly what caused a real
 *     documented hang in a prior version (a malformed/corrupt-archive record
 *     threw inside a JSONStream 'data' handler, which silently killed the
 *     stream's internal read loop without ever firing 'error' or 'end' —
 *     leaving the enclosing Promise pending forever, which in turn hung the
 *     boot sequence with zero further log output). The supervisor's
 *     heartbeat watchdog is the last line of defense; this per-record
 *     try/catch is the actual fix.
 *  3. EVERY SOURCE DOWNLOAD IS WRITTEN TO A `.part` TEMP FILE, VERIFIED, THEN
 *     ATOMICALLY RENAMED into place. A process death mid-download can never
 *     leave a truncated file sitting at a path that a later boot mistakes
 *     for "already downloaded, safe to reuse."
 *  4. EVERY BULK DATABASE MUTATION IS SERIALIZED BEHIND A SINGLE ASYNC
 *     MUTEX AND WRAPPED IN A HOT ON-DISK SNAPSHOT. If a guarded mutation
 *     throws for ANY reason, the most recent snapshot is restored. If THAT
 *     restore itself fails (a corrupt snapshot file), the next-oldest
 *     retained snapshot is tried, cascading backwards through the retained
 *     ring, before finally falling back to a brand-new empty database plus
 *     a full rehydration pass from local backup archives. See the "risk vs.
 *     complexity" note near AsyncMutex for why a single global mutex was
 *     chosen over fully concurrent multi-writer access.
 *  5. EVERY RAW SOURCE PAYLOAD IS ARCHIVED BEFORE IT IS EVER PARSED — this
 *     was true in earlier versions and remains true here. ManaPool's daily
 *     rolling window is the one irreplaceable dataset (there is no way to
 *     re-fetch a day that has passed), so it is archived byte-for-byte,
 *     uncompressed, per calendar day, before a single record is touched.
 *  6. IMPORT COMPLETENESS IS AUDITED, NOT ASSUMED. After every ManaPool
 *     ingest, the daemon independently re-counts the raw archive file's
 *     top-level entries and compares that number against what was actually
 *     processed. A mismatch (partial download, parser abort, prior
 *     mid-rollback data loss, anything) is flagged, logged, and triggers an
 *     automatic re-ingest from the local archive — and only a fresh
 *     re-download if the local archive itself turns out to be incomplete.
 *  7. SCRYFALL DATA COVERAGE IS TREATED AS A CONTINUOUS BACKGROUND JOB, NOT
 *     A ONE-SHOT SYNC. Scryfall's bulk data fills nearly every field on
 *     first sync; anything still missing (or any card that only exists via
 *     MTGJSON and hasn't been cross-referenced yet) is queued for lazy,
 *     rate-limited, per-card enrichment — triggered opportunistically on
 *     image requests, and swept exhaustively (at a deliberately low,
 *     polite rate) by a permanent background trickle worker.
 * ============================================================================
 */

'use strict';

// ============================================================================
// SECTION 0: SUPERVISOR / WORKER SPLIT
// ============================================================================
// Node wraps every CommonJS module body in a function, so a top-level
// `return` here is legal and simply means "the supervisor process does not
// execute anything below this block." The worker (forked with
// MTG_SUPERVISED=1) falls through and runs the entire rest of the file
// exactly as it would have without a supervisor at all.
const IS_SUPERVISED = process.env.MTG_SUPERVISED === '1';

if (!IS_SUPERVISED) {
    const { fork } = require('child_process');

    const RESTART_BACKOFF_MIN_MS = 2000;
    const RESTART_BACKOFF_MAX_MS = 30000;
    const HEARTBEAT_TIMEOUT_MS = 60000;          // once alive, worker must ping at least this often
    const HEARTBEAT_BOOT_GRACE_MS = 300000;      // first boot may involve multi-GB downloads — be patient
    const WATCHDOG_POLL_MS = 5000;

    let backoff = RESTART_BACKOFF_MIN_MS;
    let intentionalShutdown = false;
    let currentChild = null;
    let lastHeartbeatAt = Date.now();
    let bootStartedAt = Date.now();
    let watchdogTimer = null;
    let restartCount = 0;

    function supLog(msg) {
        const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
        console.log(`[${ts}] [SUPERVISOR] ${msg}`);
    }

    function clearWatchdog() {
        if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    }

    function armWatchdog() {
        clearWatchdog();
        watchdogTimer = setInterval(() => {
            const elapsedSinceBoot = Date.now() - bootStartedAt;
            const graceWindow = Math.max(HEARTBEAT_TIMEOUT_MS, HEARTBEAT_BOOT_GRACE_MS - elapsedSinceBoot);
            const silentFor = Date.now() - lastHeartbeatAt;
            if (silentFor > graceWindow) {
                supLog(`No heartbeat from worker (PID ${currentChild && currentChild.pid}) in ${Math.round(silentFor / 1000)}s (allowed ${Math.round(graceWindow / 1000)}s) — assuming HANG. Force-killing.`);
                try { currentChild && currentChild.kill('SIGKILL'); } catch (e) { /* best effort */ }
            }
        }, WATCHDOG_POLL_MS);
    }

    function spawnWorker() {
        bootStartedAt = Date.now();
        lastHeartbeatAt = Date.now();
        supLog(`Launching worker (attempt #${restartCount + 1})...`);
        let child;
        try {
            child = fork(__filename, process.argv.slice(2), {
                env: { ...process.env, MTG_SUPERVISED: '1' },
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            });
        } catch (err) {
            supLog(`FATAL: could not even fork the worker process: ${err.message}. Retrying in ${backoff}ms.`);
            setTimeout(spawnWorker, backoff);
            backoff = Math.min(RESTART_BACKOFF_MAX_MS, backoff * 2);
            return;
        }
        currentChild = child;
        restartCount++;
        supLog(`Worker launched with PID ${child.pid}.`);

        child.on('message', (msg) => {
            if (!msg || typeof msg !== 'object') return;
            if (msg.type === 'heartbeat') {
                lastHeartbeatAt = Date.now();
            } else if (msg.type === 'shutdown-intentional') {
                intentionalShutdown = true;
            } else if (msg.type === 'ready') {
                backoff = RESTART_BACKOFF_MIN_MS;
            }
        });

        child.on('error', (err) => {
            supLog(`Worker process error: ${err.message}`);
        });

        child.on('exit', (code, signal) => {
            clearWatchdog();
            if (intentionalShutdown) {
                supLog(`Worker exited intentionally (code=${code} signal=${signal}). Supervisor exiting too. Goodbye.`);
                process.exit(0);
                return;
            }
            supLog(`Worker exited unexpectedly (code=${code} signal=${signal}). Restarting in ${backoff}ms...`);
            const delay = backoff;
            backoff = Math.min(RESTART_BACKOFF_MAX_MS, backoff * 2);
            setTimeout(spawnWorker, delay);
        });

        armWatchdog();
    }

    process.on('SIGINT', () => {
        supLog('SIGINT received — requesting graceful worker shutdown...');
        intentionalShutdown = true;
        if (currentChild) {
            try { currentChild.kill('SIGINT'); } catch (e) { /* noop */ }
            const forceTimer = setTimeout(() => {
                supLog('Worker did not exit within 10s of SIGINT — force-killing.');
                try { currentChild.kill('SIGKILL'); } catch (e) { /* noop */ }
            }, 10000);
            currentChild.once('exit', () => clearTimeout(forceTimer));
        } else {
            process.exit(0);
        }
    });
    process.on('SIGTERM', () => {
        intentionalShutdown = true;
        if (currentChild) { try { currentChild.kill('SIGTERM'); } catch (e) { /* noop */ } } else { process.exit(0); }
    });
    process.on('uncaughtException', (err) => {
        supLog(`Supervisor itself hit an uncaught exception (this should never happen): ${err && err.stack}`);
    });

    supLog('MTG Oracle Daemon supervisor starting. The worker will be auto-restarted on any crash or detected hang, indefinitely.');
    spawnWorker();
    return;
}

// ============================================================================
// Everything below this line runs ONLY inside the supervised worker process.
// ============================================================================

const blessed = require('blessed');
const express = require('express');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const v8 = require('v8');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const zlib = require('zlib');
const readline = require('readline');
const { pipeline } = require('stream/promises');
const { Readable, PassThrough } = require('stream');
const JSONStream = require('JSONStream');

function sendToSupervisor(msg) {
    try { if (typeof process.send === 'function') process.send(msg); } catch (e) { /* no IPC channel — fine, running unsupervised */ }
}

// ============================================================================
// SECTION 1: CONFIGURATION
// ============================================================================
const PORT = process.env.PORT || 3000;
const DISK_BUDGET_GB = process.env.DISK_BUDGET_GB || 50;
const ROOT_DIR = __dirname;
const CACHE_DIR = path.join(ROOT_DIR, 'cache');
const IMG_CACHE_DIR = path.join(CACHE_DIR, 'images');
const TMP_DIR = path.join(CACHE_DIR, 'tmp');
const BACKUP_DIR = path.join(ROOT_DIR, 'backup');
const BACKUP_MTGJSON_DIR = path.join(BACKUP_DIR, 'MTGJSON');
const BACKUP_MANAPOOL_DIR = path.join(BACKUP_DIR, 'ManaPool');
// The single most irreplaceable file this whole project produces: an
// append-only, ever-growing ledger of every genuinely NEW ManaPool sale
// ever ingested, independent of the SQLite database entirely. ManaPool's
// API only ever exposes a rolling recent-sales window per card — once a
// sale rolls off that window it can never be re-fetched from anywhere,
// so the database is the only record of it, and this ledger exists purely
// so a catastrophic database loss doesn't also mean losing sales history
// that cannot be recovered by re-downloading anything. One line of JSON
// per sale, appended as it's inserted — see appendToManapoolLedger() and
// restoreManapoolFromLedger().
const MANAPOOL_LEDGER_PATH = path.join(BACKUP_MANAPOOL_DIR, 'all_sales_ledger.jsonl');
const BACKUP_SCRYFALL_DIR = path.join(BACKUP_DIR, 'Scryfall');
const BACKUP_SNAPSHOT_DIR = path.join(BACKUP_DIR, 'snapshots');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DB_PATH = path.join(CACHE_DIR, 'cards.db');
const SNAPSHOT_MANIFEST_PATH = path.join(BACKUP_SNAPSHOT_DIR, 'manifest.json');

const MTGJSON_API = 'https://mtgjson.com/api/v5/AllPrintings.json';
const MTGJSON_SHA_API = 'https://mtgjson.com/api/v5/AllPrintings.json.sha256';
const MANAPOOL_SINGLES_GZ = 'https://storage.googleapis.com/manapool-prod-catalog/singles.json.gz';
const SCRYFALL_BULK_LIST_API = 'https://api.scryfall.com/bulk-data';
const SCRYFALL_CARD_API = 'https://api.scryfall.com/cards';
const SCRYFALL_IMG_BASE = 'https://cards.scryfall.io';
// (Tagger data is now sourced from official oracle_tags/art_tags bulk
// types — see Section 12 — not from any GraphQL endpoint.)

const MTGJSON_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MANAPOOL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SCRYFALL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SELF_HEAL_INTERVAL_MS = 60 * 60 * 1000;
const ENRICHMENT_TRICKLE_INTERVAL_MS = 2500;       // one lazy Scryfall single-card fetch per tick, gently
const HEARTBEAT_INTERVAL_MS = 10000;
const SNAPSHOT_RETENTION_COUNT = 10;
const AUDIT_LOG_RETENTION_ROWS = 50000;

const MTGJSON_BATCH_SIZE = 2500;
const MANAPOOL_BATCH_SIZE = 5000;
const SCRYFALL_BATCH_SIZE = 2500;
const MAX_RAW_ORDER_BYTES = 8 * 1024;
const MAX_RAW_CARD_BYTES = 48 * 1024;
const MAX_DEBUG_SAMPLE_BYTES = 600;

const IMG_MAX_CONCURRENT_FETCHES = 6;
const IMG_MIN_INTERVAL_MS = 60;
const SCRYFALL_API_MIN_INTERVAL_MS = 120;          // stay comfortably under Scryfall's ~10 req/s guidance
const SCRYFALL_API_MAX_CONCURRENT = 4;

const REQUEST_RING_SIZE = 400;
const MAX_HISTORY = 8;
const SEARCH_PAGE_SIZE = 175;                      // matches Scryfall's own page size

const DEFAULT_OP_TIMEOUT_MS = 2 * 60 * 60 * 1000;  // 2h ceiling on any single guarded pipeline run
const BOOT_REHYDRATE_TIMEOUT_MS = 20 * 60 * 1000;  // 20m ceiling on boot-time backup rehydration

// ----------------------------------------------------------------------------
// DISK SPACE BUDGET
// ----------------------------------------------------------------------------
// The daemon self-limits its total on-disk footprint to a configurable byte
// budget, split between the image cache and everything else that accumulates
// over time (MTGJSON/ManaPool/Scryfall raw archives + DB snapshots). Both
// env vars are overridable; defaults match "8GB total, 40% of that to
// images" as specified. Neither budget includes cards.db itself or the tmp
// dir — those aren't cullable accumulation, they're the live working set.
const DISK_BUDGET_TOTAL_BYTES = Math.round((parseFloat(DISK_BUDGET_GB) || 8) * 1024 * 1024 * 1024);
const DISK_BUDGET_CACHE_PERCENT = Math.min(1, Math.max(0, parseFloat(process.env.DISK_BUDGET_CACHE_PERCENT) || 0.80));
const DISK_BUDGET_CACHE_BYTES = Math.floor(DISK_BUDGET_TOTAL_BYTES * DISK_BUDGET_CACHE_PERCENT);
const DISK_BUDGET_ARCHIVE_BYTES = DISK_BUDGET_TOTAL_BYTES - DISK_BUDGET_CACHE_BYTES; // MTGJSON+ManaPool+Scryfall archives + snapshots, combined
const DISK_AUDIT_INTERVAL_MS = 5 * 60 * 1000;      // check every 5 minutes
// Cull down to 92% of budget rather than exactly 100%, so a handful of new
// files landing right after an audit doesn't immediately trip the next one —
// plain hysteresis to avoid thrashing right at the edge of the budget.
const DISK_AUDIT_TARGET_FRACTION = 0.92;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================================
// SECTION 2: GLOBAL STATE & METRICS
// ============================================================================
const stats = {
    dbStatus: 'Initializing',
    cardCount: 0,
    salesCount: 0,
    cachedImages: 0,
    uncachedImages: 0,
    cacheHits: 0,
    cacheMisses: 0,
    mtgjsonState: 'Idle',
    manapoolState: 'Waiting',
    scryfallState: 'Idle',
    rulingsState: 'Idle',
    tagsState: 'Idle',
    enrichmentState: 'Idle',
    dbSize: '0 MB',
    totalRequests: 0,
    rps: 0,
    peakRps: 0,
    status2xx: 0,
    status4xx: 0,
    status5xx: 0,
    lastAuditStatus: 'Pending',
    lastAuditAt: null,
    lastMtgjsonSyncAt: null,
    lastManapoolSyncAt: null,
    lastScryfallSyncAt: null,
    rollbacksPerformed: 0,
    snapshotsTaken: 0,
    healActionsTaken: 0,
    patchedFromBackup: 0,
    cardsMissingScryfallData: 0,
    cardsEnrichedThisSession: 0,
    manapoolFileEntries: 0,
    manapoolImportedEntries: 0,
    manapoolIntegrityStatus: 'Unknown',
    dbLockQueueDepth: 0,
    dbLockActive: 'None',
    restartNotice: null,
    diskCacheBytesUsed: 0,
    diskCacheBudgetBytes: DISK_BUDGET_CACHE_BYTES,
    diskArchiveBytesUsed: 0,
    diskArchiveBudgetBytes: DISK_BUDGET_ARCHIVE_BYTES,
    diskAuditStatus: 'Pending',
    lastDiskAuditAt: null,
    imagesCulledForSpace: 0,
    archiveItemsCulledForSpace: 0,
    bytesFreedForSpace: 0,
};

let reqsThisSecond = 0;
const activeDownloads = new Map();
const fileHistory = [];
const requestRing = [];
let db = null;
let dbGeneration = 0;
let shuttingDown = false;

// ----------------------------------------------------------------------------
// Generic utilities
// ----------------------------------------------------------------------------
function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function todayStamp() {
    return new Date().toISOString().split('T')[0];
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * Generic cooperative-yield helper for any Node stream/readline interface
 * that supports pause()/resume(). Call this at a batch boundary inside a
 * synchronous stream 'data'/'line' handler: it pauses the source, runs
 * `flushFn` (typically one DB transaction) synchronously, then resumes on
 * the NEXT event-loop tick via setImmediate. That one-tick gap is enough
 * for pending timers (the TUI's 1s redraw, the supervisor heartbeat ping)
 * and any in-flight HTTP requests to actually run, instead of a
 * multi-hundred-thousand-row ingest monopolizing the event loop and making
 * the whole process *look* hung even though it's working correctly. Used
 * by every heavy ingestion pipeline (MTGJSON, ManaPool, Scryfall bulk).
 */
function pauseFlushResume(stream, flushFn) {
    try { stream.pause(); } catch (e) { /* some stream-likes may not support pause; proceed anyway */ }
    try {
        flushFn();
    } finally {
        setImmediate(() => { try { stream.resume(); } catch (e) { /* noop */ } });
    }
}

/**
 * Generic retry-with-backoff wrapper for transient failures (network
 * blips, "terminated" socket errors on large downloads, momentary 5xx from
 * an upstream API). Retries `fn` up to `retries` times with exponential
 * backoff before giving up and letting the error propagate — at which
 * point the normal 24h-cycle-plus-manual-retry safety net still applies.
 */
async function retryAsync(fn, { retries = 3, baseDelayMs = 3000, label = 'operation' } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            lastErr = err;
            if (attempt >= retries) break;
            const delay = baseDelayMs * Math.pow(2, attempt - 1);
            vLog('RETRY', `${label} failed (attempt ${attempt}/${retries}): ${err.message}. Retrying in ${delay}ms...`);
            await sleep(delay);
        }
    }
    throw lastErr;
}

/**
 * Races a promise against a timeout so that no single async operation can
 * hang the daemon forever, no matter what upstream library or network
 * condition causes it. On timeout, rejects with a clearly-labeled error;
 * it does NOT attempt to cancel the underlying operation (Node has no
 * universal cancellation primitive for arbitrary promises), so callers
 * must treat a timeout as "stop waiting and move on," not "this definitely
 * stopped running." Combined with the supervisor's heartbeat watchdog, this
 * gives two independent, differently-scoped defenses against hangs: this
 * one catches slow logical operations without killing the whole process;
 * the supervisor catches anything this one might miss.
 */
function withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms: ${label}`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A minimal FIFO async mutex.
 *
 * RISK-VS-COMPLEXITY NOTE (why a single global lock instead of true
 * concurrency): better-sqlite3 holds one synchronous connection, so any two
 * `.run()`/`.transaction()` calls from this process are already physically
 * serialized at the SQLite level and can never corrupt a table mid-write.
 * The actual danger is at a HIGHER level: our own snapshot/rollback
 * workflow. If pipeline A takes a hot snapshot, starts writing, and
 * pipeline B takes its OWN snapshot while A is mid-flight, B's snapshot now
 * contains A's uncommitted-in-spirit progress; if A later fails and rolls
 * back to A's snapshot, the entire database file is overwritten wholesale —
 * silently destroying every row B wrote after A's snapshot point, even
 * though B itself succeeded. That is a real, silent data-loss bug, not a
 * theoretical one, and it gets worse (not better) the more pipelines run
 * concurrently. Building a truly concurrent design would mean either
 * per-pipeline databases with an application-level merge step, or
 * row/table-scoped locking with careful dependency ordering — both
 * meaningfully more complex, and both still need *some* serialization
 * around the merge step, so the worst-case latency doesn't actually
 * improve much for a single-writer workload like this one. Given that
 * every guarded pipeline here is I/O-bound (network download, disk
 * streaming) far more than CPU-bound, and downloads happen fully OUTSIDE
 * the lock (see withSnapshotGuard call sites), the practical cost of full
 * serialization is small, while the correctness win is total. HTTP reads
 * (search, card lookups, image serving) never touch this lock at all —
 * only the four heavy background pipelines (MTGJSON, ManaPool, Scryfall
 * bulk/rulings, self-heal/rehydration) queue behind one another.
 */
class AsyncMutex {
    constructor() { this._queue = Promise.resolve(); this._depth = 0; }
    acquire() {
        let releaseFn;
        const nextTurn = new Promise((resolve) => { releaseFn = resolve; });
        const acquisition = this._queue.then(() => releaseFn && true).then(() => {});
        const waitFor = this._queue;
        this._depth++;
        stats.dbLockQueueDepth = Math.max(0, this._depth - 1);
        this._queue = this._queue.then(() => nextTurn);
        return waitFor.then(() => {
            let released = false;
            return () => {
                if (released) return;
                released = true;
                this._depth = Math.max(0, this._depth - 1);
                stats.dbLockQueueDepth = Math.max(0, this._depth - 1);
                releaseFn();
            };
        });
    }
}
const dbWriteLock = new AsyncMutex();

/**
 * Bounded, depth-limited, never-throws serializer. Any time we persist or
 * preview an object from an untrusted/unbounded upstream payload, route it
 * through here instead of calling JSON.stringify directly — a raw
 * JSON.stringify on a sufficiently large/pathological object can exhaust
 * memory or throw a RangeError before a surrounding try/catch even gets a
 * chance to run cleanly. This never throws and never produces more than a
 * small, predictable number of bytes.
 */
function safeStringifyBounded(obj, maxBytes = MAX_RAW_ORDER_BYTES) {
    try {
        if (obj === null || obj === undefined) return JSON.stringify(obj);
        if (typeof obj !== 'object') {
            const s = JSON.stringify(obj);
            return s && s.length > maxBytes ? s.substring(0, maxBytes) + '...[TRUNCATED]"' : s;
        }
        const out = {};
        let used = 0;
        const keys = Object.keys(obj);
        for (const key of keys) {
            if (used >= maxBytes) { out.__truncated = true; break; }
            let val = obj[key];
            if (Array.isArray(val)) {
                const originalLen = val.length;
                if (originalLen > 25) {
                    val = val.slice(0, 25);
                    val.push(`...[${originalLen - 25} more items truncated]`);
                }
            } else if (typeof val === 'string' && val.length > 2000) {
                val = val.substring(0, 2000) + '...[TRUNCATED]';
            } else if (val && typeof val === 'object' && !Array.isArray(val)) {
                try {
                    const nestedKeys = Object.keys(val).slice(0, 25);
                    const nested = {};
                    for (const nk of nestedKeys) {
                        const nv = val[nk];
                        if (nv === null || nv === undefined) {
                            nested[nk] = nv;
                        } else if (Array.isArray(nv)) {
                            nested[nk] = `[array(${nv.length})]`;
                        } else if (typeof nv === 'string' && nv.length > 500) {
                            nested[nk] = nv.substring(0, 500) + '...[TRUNCATED]';
                        } else if (typeof nv === 'object') {
                            nested[nk] = '[nested object]';
                        } else {
                            nested[nk] = nv;
                        }
                    }
                    val = nested;
                } catch (e) {
                    val = '[unserializable nested object]';
                }
            }
            let valStr;
            try { valStr = JSON.stringify(val); } catch (e) { valStr = '"[unserializable]"'; }
            out[key] = val;
            used += (valStr ? valStr.length : 0);
        }
        const result = JSON.stringify(out);
        return result.length > maxBytes * 2 ? result.substring(0, maxBytes * 2) + '...[TRUNCATED]"}' : result;
    } catch (err) {
        return JSON.stringify({ __serialization_error: true, reason: String((err && err.message) || err) });
    }
}

/**
 * Downloads a URL to a `.part` temp file, verifies it against the
 * Content-Length header (when provided) and/or an expected SHA256, and only
 * THEN atomically renames it into place. A process death, network drop, or
 * server-side truncation mid-download can never leave a file sitting at
 * `destPath` that a later boot mistakes for "complete." `onProgress`
 * receives (downloadedBytes, totalBytes) for TUI updates. Returns
 * { bytes, sha256 }.
 */
async function downloadAtomic(url, destPath, { headers = {}, onProgress = null, expectedSha256 = null, timeoutMs = null } = {}) {
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    const partPath = destPath + '.part';
    const doFetch = async () => {
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
        const totalHeader = res.headers.get('content-length');
        const totalBytes = totalHeader ? parseInt(totalHeader, 10) : 0;
        let downloadedBytes = 0;
        const hash = crypto.createHash('sha256');
        const tee = new PassThrough();
        tee.on('data', (chunk) => {
            hash.update(chunk);
            downloadedBytes += chunk.length;
            if (onProgress) { try { onProgress(downloadedBytes, totalBytes); } catch (e) { /* never let UI code break a download */ } }
        });
        await pipeline(Readable.fromWeb(res.body), tee, fsSync.createWriteStream(partPath));

        if (totalBytes > 0 && downloadedBytes !== totalBytes) {
            throw new Error(`Download size mismatch for ${url}: expected ${totalBytes} bytes, got ${downloadedBytes}. Likely truncated connection.`);
        }
        const sha256 = hash.digest('hex');
        if (expectedSha256 && sha256 !== expectedSha256) {
            throw new Error(`SHA256 mismatch for ${url}: expected ${expectedSha256}, got ${sha256}.`);
        }
        return { bytes: downloadedBytes, sha256 };
    };

    try {
        const result = timeoutMs ? await withTimeout(doFetch(), timeoutMs, `download ${url}`) : await doFetch();
        await fs.rename(partPath, destPath);
        return result;
    } catch (err) {
        await fs.unlink(partPath).catch(() => {});
        throw err;
    }
}

// ============================================================================
// SECTION 3: BLESSED TUI
// ============================================================================
const screen = blessed.screen({ smartCSR: true, title: 'MTG Oracle Daemon v4.0 (Bedrock)' });

const leftColWidth = '38%';
const rightColWidth = '62%';

const statsBox = blessed.box({
    top: 0, left: 0, width: leftColWidth, height: '54%',
    label: ' SYSTEM STATS & METRICS ', border: { type: 'line' }, tags: true,
    scrollable: true, scrollbar: { ch: ' ', inverse: true },
    style: { border: { fg: 'cyan' }, text: { fg: 'white' } },
});

const historyBox = blessed.box({
    top: '54%', left: 0, width: leftColWidth, height: '14%',
    label: ' FILE HISTORY ', border: { type: 'line' }, tags: true,
    style: { border: { fg: 'cyan' }, text: { fg: 'white' } },
});

const downloadsBox = blessed.box({
    top: '68%', left: 0, width: leftColWidth, height: '18%',
    label: ' ACTIVE DOWNLOADS ', border: { type: 'line' }, tags: true,
    scrollable: true, scrollbar: { ch: ' ', inverse: true },
    style: { border: { fg: 'cyan' }, text: { fg: 'white' } },
});

const trafficBox = blessed.log({
    top: '86%', left: 0, width: leftColWidth, height: '14%',
    label: ' INCOMING TRAFFIC (live) ', border: { type: 'line' }, tags: true,
    scrollable: true, scrollbar: { ch: ' ', inverse: true },
    style: { border: { fg: 'magenta' }, text: { fg: 'white' } },
});

const logBox = blessed.log({
    top: 0, left: leftColWidth, width: rightColWidth, height: '92%',
    label: ' VERBOSE LIVE EVENT LOG (FULL TRACE) ', border: { type: 'line' }, tags: true,
    scrollable: true, scrollbar: { ch: ' ', inverse: true },
    style: { border: { fg: 'cyan' }, text: { fg: 'white' } },
});

const footerBox = blessed.box({
    top: '92%', left: leftColWidth, width: rightColWidth, height: '8%',
    tags: true, border: { type: 'line' },
    style: { border: { fg: 'grey' }, text: { fg: 'grey' } },
    content: ' {bold}[q/C-c]{/bold} quit  {bold}[s]{/bold} Scryfall resync  {bold}[r]{/bold} MTGJSON resync  {bold}[m]{/bold} ManaPool resync  {bold}[h]{/bold} self-heal  {bold}[e]{/bold} enrich now  {bold}[b]{/bold} restore snapshot  {bold}[d]{/bold} disk audit',
});

screen.append(statsBox);
screen.append(historyBox);
screen.append(downloadsBox);
screen.append(trafficBox);
screen.append(logBox);
screen.append(footerBox);

screen.key(['escape', 'q', 'C-c'], () => {
    vLog('SYSTEM', 'Shutdown key pressed. Terminating gracefully...');
    gracefulShutdown('user-quit', true);
});
screen.key(['s', 'S'], () => { vLog('SYSTEM', 'Manual Scryfall bulk resync triggered from TUI.'); runScryfallBulkSync(true).catch((e) => vLog('SCRYFALL_ERR', e.message)); });
screen.key(['r', 'R'], () => { vLog('SYSTEM', 'Manual MTGJSON resync triggered from TUI.'); checkMtgJsonSync(true).catch((e) => vLog('MTGJSON_ERR', e.message)); });
screen.key(['m', 'M'], () => { vLog('SYSTEM', 'Manual ManaPool resync triggered from TUI.'); manapoolForceFlag.force = true; });
screen.key(['h', 'H'], () => { vLog('SYSTEM', 'Manual self-heal triggered from TUI.'); runSelfAudit().catch((e) => vLog('AUDIT_ERR', e.message)); });
screen.key(['e', 'E'], () => { vLog('SYSTEM', 'Manual enrichment sweep triggered from TUI.'); enrichmentForceFlag.force = true; });
screen.key(['b', 'B'], () => {
    vLog('SYSTEM', 'Manual snapshot restore triggered from TUI.');
    restoreFromBestAvailableSnapshot('manual-tui-request')
        .then((restored) => { if (restored) initDatabase(); else vLog('RESTORE_ERR', 'No usable snapshot was available.'); })
        .catch((e) => vLog('RESTORE_ERR', e.message));
});
screen.key(['d', 'D'], () => { vLog('SYSTEM', 'Manual disk space audit triggered from TUI.'); runDiskSpaceAudit().catch((e) => vLog('DISK_AUDIT_ERR', e.message)); });

const manapoolForceFlag = { force: false };
const enrichmentForceFlag = { force: false };

function addHistory(name, detail) {
    fileHistory.unshift({ name, detail, time: new Date().toLocaleTimeString() });
    if (fileHistory.length > MAX_HISTORY) fileHistory.pop();
}

function updateUI() {
    const barLen = 12;
    const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const animIndex = Math.floor(Date.now() / 200) % spinnerFrames.length;

    let historyHtml = fileHistory.length === 0 ? ' {grey-fg}No completed files{/grey-fg}\n' : '';
    for (const item of fileHistory) {
        historyHtml += ` {green-fg}✔{/green-fg} ${item.name} {grey-fg}(${item.detail}) [${item.time}]{/grey-fg}\n`;
    }

    let downloadsHtml = activeDownloads.size === 0 ? ' {grey-fg}No active downloads{/grey-fg}\n' : '';
    for (const [, dl] of activeDownloads.entries()) {
        if (dl.totalBytes > 0) {
            const filled = Math.max(0, Math.min(barLen, Math.round((dl.percent / 100) * barLen)));
            const bar = '█'.repeat(filled) + '-'.repeat(barLen - filled);
            downloadsHtml += ` {bold}${dl.name}{/bold}\n [${bar}] ${dl.percent}% (${dl.detail})\n`;
        } else {
            const spinner = spinnerFrames[animIndex];
            downloadsHtml += ` {bold}${dl.name}{/bold}\n {yellow-fg}${spinner}{/yellow-fg} STREAM (${dl.detail})\n`;
        }
    }

    const uptimeSec = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const secs = uptimeSec % 60;
    const uptimeStr = `${hours}h ${mins}m ${secs}s`;

    const mem = process.memoryUsage();
    const heapStats = v8.getHeapStatistics();
    const maxHeapMB = (heapStats.heap_size_limit / 1024 / 1024).toFixed(0);
    const heapStr = `${(mem.heapUsed / 1024 / 1024).toFixed(1)} / ${maxHeapMB} MB`;
    const rssStr = `${(mem.rss / 1024 / 1024).toFixed(1)} MB`;
    const cpuLoad = os.loadavg().map((n) => n.toFixed(2)).join(' / ');
    const sysMemStr = `${((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024).toFixed(1)} / ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`;
    const cpuCount = os.cpus().length;

    const lastAudit = stats.lastAuditAt ? new Date(stats.lastAuditAt).toLocaleTimeString() : 'never';
    const lastMtg = stats.lastMtgjsonSyncAt ? new Date(stats.lastMtgjsonSyncAt).toLocaleString() : 'never';
    const lastMp = stats.lastManapoolSyncAt ? new Date(stats.lastManapoolSyncAt).toLocaleString() : 'never';
    const lastScry = stats.lastScryfallSyncAt ? new Date(stats.lastScryfallSyncAt).toLocaleString() : 'never';

    statsBox.setContent(
        ` {bold}SYSTEM & RUNTIME{/bold}\n` +
        ` Uptime:        {yellow-fg}${uptimeStr}{/yellow-fg}   Supervised: {yellow-fg}${typeof process.send === 'function' ? 'yes' : 'no'}{/yellow-fg}\n` +
        ` CPU Load(1/5/15m): {yellow-fg}${cpuLoad}{/yellow-fg} (${cpuCount} cores)\n` +
        ` Sys RAM Used:  {yellow-fg}${sysMemStr}{/yellow-fg}\n` +
        ` Node Heap:     {yellow-fg}${heapStr}{/yellow-fg}   RSS: {yellow-fg}${rssStr}{/yellow-fg}\n` +
        ` {bold}DATABASE & CACHE{/bold}\n` +
        ` DB Status:     {green-fg}${stats.dbStatus}{/green-fg}   Size: {yellow-fg}${stats.dbSize}{/yellow-fg}\n` +
        ` DB Lock:       {cyan-fg}${stats.dbLockActive}{/cyan-fg}  Queue depth: {yellow-fg}${stats.dbLockQueueDepth}{/yellow-fg}\n` +
        ` Total Cards:   {cyan-fg}${stats.cardCount.toLocaleString()}{/cyan-fg}\n` +
        ` Sales Logged:  {magenta-fg}${stats.salesCount.toLocaleString()}{/magenta-fg}\n` +
        ` Img Cached:    {cyan-fg}${stats.cachedImages.toLocaleString()}{/cyan-fg}  Uncached: {red-fg}${stats.uncachedImages.toLocaleString()}{/red-fg}\n` +
        ` Img Hit/Miss:  {green-fg}${stats.cacheHits}{/green-fg} / {red-fg}${stats.cacheMisses}{/red-fg}\n` +
        ` Scry Missing:  {red-fg}${stats.cardsMissingScryfallData.toLocaleString()}{/red-fg}  Enriched(session): {green-fg}${stats.cardsEnrichedThisSession.toLocaleString()}{/green-fg}\n` +
        ` MP File Rows:  {cyan-fg}${stats.manapoolFileEntries.toLocaleString()}{/cyan-fg}  Imported: {cyan-fg}${stats.manapoolImportedEntries.toLocaleString()}{/cyan-fg}  {yellow-fg}${stats.manapoolIntegrityStatus}{/yellow-fg}\n` +
        ` Self-Audit:    {green-fg}${stats.lastAuditStatus}{/green-fg} {grey-fg}(${lastAudit}){/grey-fg}\n` +
        ` Snapshots:     {cyan-fg}${stats.snapshotsTaken}{/cyan-fg}  Rollbacks: {red-fg}${stats.rollbacksPerformed}{/red-fg}  Heals: {yellow-fg}${stats.healActionsTaken}{/yellow-fg}\n` +
        ` Backup-Patched:{cyan-fg}${stats.patchedFromBackup}{/cyan-fg}\n` +
        ` Disk (cache):  {cyan-fg}${formatBytes(stats.diskCacheBytesUsed)}{/cyan-fg} / {yellow-fg}${formatBytes(stats.diskCacheBudgetBytes)}{/yellow-fg}\n` +
        ` Disk (archive):{cyan-fg}${formatBytes(stats.diskArchiveBytesUsed)}{/cyan-fg} / {yellow-fg}${formatBytes(stats.diskArchiveBudgetBytes)}{/yellow-fg}  {grey-fg}(${stats.diskAuditStatus}){/grey-fg}\n` +
        ` {bold}SOURCES{/bold}\n` +
        ` MTGJSON:       {yellow-fg}${stats.mtgjsonState}{/yellow-fg} {grey-fg}(${lastMtg}){/grey-fg}\n` +
        ` ManaPool:      {yellow-fg}${stats.manapoolState}{/yellow-fg} {grey-fg}(${lastMp}){/grey-fg}\n` +
        ` Scryfall:      {yellow-fg}${stats.scryfallState}{/yellow-fg} {grey-fg}(${lastScry}){/grey-fg}\n` +
        ` Rulings:       {yellow-fg}${stats.rulingsState}{/yellow-fg}\n` +
        ` Tagger Tags:   {yellow-fg}${stats.tagsState}{/yellow-fg}\n` +
        ` Enrichment:    {yellow-fg}${stats.enrichmentState}{/yellow-fg}\n` +
        ` {bold}HTTP TRAFFIC{/bold}\n` +
        ` RPS (peak):    {green-fg}${stats.rps}{/green-fg} ({magenta-fg}${stats.peakRps}{/magenta-fg})  Total: ${stats.totalRequests.toLocaleString()}\n` +
        ` 2xx/4xx/5xx:   {green-fg}${stats.status2xx}{/green-fg} / {yellow-fg}${stats.status4xx}{/yellow-fg} / {red-fg}${stats.status5xx}{/red-fg}\n` +
        ` Active DLs:    {cyan-fg}${activeDownloads.size}{/cyan-fg}` +
        (stats.restartNotice ? `\n {bold}{red-fg}${stats.restartNotice}{/red-fg}{/bold}` : '')
    );

    historyBox.setContent(historyHtml);
    downloadsBox.setContent(downloadsHtml);
    screen.render();
}

/**
 * In-memory ring buffer backing `GET /api/log` and `GET /log` (see Section
 * 17B, just below the route table). Deliberately separate from audit_log
 * (Section 4, SQLite-backed): this is a live "tail -f the TUI" view, not a
 * durable record — it resets on every restart and never touches disk. Each
 * entry stores the SAME tagColor bucket vLog already computed for the
 * blessed TUI, so the web view can be colorised identically without
 * re-deriving anything or parsing blessed's {tag} markup back out.
 */
const LOG_BUFFER_MAX = 2000;
let logSeq = 0;
const recentLogEntries = [];
function pushLogEntry(tag, msg, tagColor) {
    logSeq++;
    recentLogEntries.push({ id: logSeq, ts: Date.now(), tag, msg: String(msg), color: tagColor });
    if (recentLogEntries.length > LOG_BUFFER_MAX) recentLogEntries.splice(0, recentLogEntries.length - LOG_BUFFER_MAX);
}

function vLog(tag, msg) {
    const time = new Date().toISOString().replace('T', ' ').substring(11, 19);
    let tagColor = 'cyan-fg';
    if (tag.includes('ERR') || tag.includes('CRITICAL') || tag.includes('FAIL')) tagColor = 'red-fg';
    else if (tag.includes('DL') || tag.includes('SNAPSHOT') || tag.includes('RESTORE') || tag.includes('MIGRATE') || tag.includes('HEAL') || tag.includes('PARSE') || tag.includes('STREAM')) tagColor = 'yellow-fg';
    else if (tag.includes('SUCCESS') || tag === 'DB' || tag === 'SYSTEM' || tag === 'AUDIT') tagColor = 'green-fg';
    else if (tag.startsWith('STAGE') || tag === 'QUERY' || tag === 'CACHE' || tag === 'INSPECT') tagColor = 'magenta-fg';

    try {
        logBox.log(`{grey-fg}[${time}]{/grey-fg} {bold}{${tagColor}}[${tag}]{/${tagColor}}{/bold} ${msg}`);
        screen.render();
    } catch (e) { /* TUI must never crash the process */ }
    if (process.env.MTG_HEADLESS === '1' || !process.stdout.isTTY) {
        console.log(`[${time}] [${tag}] ${msg}`);
    }
    try { pushLogEntry(tag, msg, tagColor); } catch (e) { /* the web log view is best-effort, never the reason vLog itself throws */ }
}

function tLog(method, urlPath, status, durationMs) {
    const color = status >= 500 ? 'red-fg' : status >= 400 ? 'yellow-fg' : 'green-fg';
    try {
        trafficBox.log(`{${color}}${method}{/${color}} ${urlPath} {grey-fg}[${status} | ${durationMs}ms]{/grey-fg}`);
        screen.render();
    } catch (e) { /* ignore TUI errors */ }
}

setInterval(updateUI, 1000);

// Heartbeat to the supervisor: as long as this fires, the event loop is
// alive and not deadlocked. If it stops, the supervisor's watchdog notices
// within HEARTBEAT_TIMEOUT_MS and force-restarts the whole worker.
setInterval(() => sendToSupervisor({ type: 'heartbeat', ts: Date.now() }), HEARTBEAT_INTERVAL_MS);

// ============================================================================
// SECTION 4: AUDIT LOG (persisted, DB-backed)
// ============================================================================
function auditLog(level, tag, message) {
    vLog(tag, message);
    if (!db) return;
    try {
        db.prepare('INSERT INTO audit_log (ts, level, tag, message) VALUES (?, ?, ?, ?)')
            .run(Date.now(), level, tag, String(message).substring(0, 4000));
    } catch (e) {
        vLog('AUDIT_LOG_ERR', `Failed to persist audit row: ${e.message}`);
    }
}

function trimAuditLog() {
    if (!db) return;
    try {
        const count = db.prepare('SELECT COUNT(*) AS cnt FROM audit_log').get().cnt;
        if (count > AUDIT_LOG_RETENTION_ROWS) {
            const excess = count - AUDIT_LOG_RETENTION_ROWS;
            db.prepare('DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log ORDER BY id ASC LIMIT ?)').run(excess);
            vLog('AUDIT', `Trimmed ${excess} old audit_log rows (retention cap ${AUDIT_LOG_RETENTION_ROWS}).`);
        }
    } catch (e) {
        vLog('AUDIT_ERR', `Failed to trim audit_log: ${e.message}`);
    }
}

// ============================================================================
// SECTION 5: DIRECTORY BOOTSTRAP
// ============================================================================
async function ensureDirectories() {
    vLog('BOOT', 'Verifying directory structures across cache, backup, and public assets...');
    const dirs = [
        CACHE_DIR, IMG_CACHE_DIR, TMP_DIR,
        BACKUP_DIR, BACKUP_MTGJSON_DIR, BACKUP_MANAPOOL_DIR, BACKUP_SCRYFALL_DIR, BACKUP_SNAPSHOT_DIR,
        PUBLIC_DIR,
    ];
    for (const dir of dirs) {
        try {
            await fs.mkdir(dir, { recursive: true });
            vLog('BOOT', `Directory verified: ${path.relative(ROOT_DIR, dir)}`);
        } catch (err) {
            // A single unwritable directory should not prevent boot entirely —
            // log loudly and let downstream code fail (and self-heal / retry)
            // at the point it actually needs that specific directory.
            vLog('BOOT_ERR', `Could not create/verify directory ${dir}: ${err.message}`);
        }
    }
}

// ============================================================================
// SECTION 6: DATABASE — SCHEMA, MIGRATIONS, FTS5, SNAPSHOTS, CASCADING RESTORE
// ============================================================================
const CARD_TABLE_COLUMNS = {
    scryfall_id: 'TEXT PRIMARY KEY',
    mtgjson_uuid: 'TEXT',
    oracle_id: 'TEXT',
    illustration_id: 'TEXT',
    name: 'TEXT',
    lang: 'TEXT',
    set_code: 'TEXT',
    set_name: 'TEXT',
    set_type: 'TEXT',
    collector_number: 'TEXT',
    rarity: 'TEXT',
    type_line: 'TEXT',
    mana_cost: 'TEXT',
    cmc: 'REAL',
    colors: 'TEXT',
    color_identity: 'TEXT',
    color_mask: 'INTEGER',
    identity_mask: 'INTEGER',
    produced_mana: 'TEXT',
    produced_mana_mask: 'INTEGER',
    color_indicator: 'TEXT',
    color_indicator_mask: 'INTEGER',
    keywords: 'TEXT',
    power: 'TEXT',
    power_num: 'REAL',
    toughness: 'TEXT',
    toughness_num: 'REAL',
    loyalty: 'TEXT',
    loyalty_num: 'REAL',
    layout: 'TEXT',
    artist: 'TEXT',
    oracle_text: 'TEXT',
    flavor_text: 'TEXT',
    legalities: 'TEXT',
    games: 'TEXT',
    reserved: 'INTEGER',
    foil: 'INTEGER',
    nonfoil: 'INTEGER',
    full_art: 'INTEGER',
    textless: 'INTEGER',
    promo: 'INTEGER',
    variation: 'INTEGER',
    border_color: 'TEXT',
    frame: 'TEXT',
    released_at: 'TEXT',
    edhrec_rank: 'INTEGER',
    penny_rank: 'INTEGER',
    watermark: 'TEXT',
    price_usd: 'REAL',
    price_usd_foil: 'REAL',
    price_eur: 'REAL',
    mtgjson_data: 'TEXT',
    scryfall_data: 'TEXT',
    updated_at: 'INTEGER',
    source_sync_id: 'TEXT',
    scryfall_synced_at: 'INTEGER',
};

function buildCreateCardsTableSQL() {
    const cols = Object.entries(CARD_TABLE_COLUMNS).map(([name, type]) => `${name} ${type}`).join(',\n                ');
    return `CREATE TABLE IF NOT EXISTS cards (\n                ${cols}\n            );`;
}

/**
 * Proper mana-cost SYMBOL-SET matching for m:/mana: search, registered as a
 * SQLite scalar function (SQL has no practical way to do multiset
 * comparison on strings on its own). Handles both curly-brace ("{2}{U}{U}")
 * and shorthand ("2uu") input on the query side; card mana_cost is always
 * stored in curly-brace form from Scryfall. `:`/`>=` means "contains at
 * least these symbols" (extra symbols on the card are fine); `=` means an
 * exact symbol-for-symbol match. This replaces an earlier version that did
 * a plain case-insensitive string-equality check, which only worked if the
 * user typed the mana cost in exactly the stored format/order.
 */
function parseManaSymbols(str) {
    if (!str) return [];
    const symbols = [];
    const curly = String(str).match(/\{[^}]+\}/g);
    if (curly) { for (const s of curly) symbols.push(s.slice(1, -1).toUpperCase()); return symbols; }
    for (const ch of String(str)) {
        if (/[0-9]/.test(ch)) symbols.push(ch);
        else if (/[wubrgcxs]/i.test(ch)) symbols.push(ch.toUpperCase());
    }
    return symbols;
}
function manaMultiset(symbols) {
    const map = new Map();
    for (const s of symbols) map.set(s, (map.get(s) || 0) + 1);
    return map;
}
function manaCostMatchesFn(cardManaCost, queryValue, op) {
    try {
        const cardSet = manaMultiset(parseManaSymbols(cardManaCost));
        const querySet = manaMultiset(parseManaSymbols(queryValue));
        if (querySet.size === 0) return 0;
        if (op === '=') {
            if (cardSet.size !== querySet.size) return 0;
            for (const [k, v] of querySet) if (cardSet.get(k) !== v) return 0;
            return 1;
        }
        for (const [k, v] of querySet) if ((cardSet.get(k) || 0) < v) return 0;
        return 1;
    } catch (e) { return 0; }
}
function registerManaMatchFunction(dbHandle) {
    try {
        dbHandle.function('MANA_MATCH', { deterministic: true }, (cardCost, queryVal, op) => manaCostMatchesFn(cardCost, queryVal, op));
    } catch (e) {
        vLog('DB_ERR', `Failed to register MANA_MATCH SQL function: ${e.message}`);
    }
}

function initDatabase(attempt = 0) {
    if (attempt > 4) {
        // We have tried opening fresh, restoring snapshots, and wiping —
        // repeatedly failing past this point means something outside our
        // control (disk full, filesystem read-only, permissions). Log as
        // loudly as possible and let the supervisor's heartbeat watchdog
        // eventually notice the worker never reaches 'ready' and recycle it,
        // rather than spinning forever in a tight synchronous retry loop.
        stats.dbStatus = 'FATAL — see logs';
        auditLog('CRITICAL', 'DB_FATAL', 'Exhausted all database recovery attempts (fresh open, snapshot restore, wipe). Check disk space and filesystem permissions.');
        return;
    }
    try {
        vLog('DB', `Opening SQLite database connection at ${DB_PATH} (attempt ${attempt + 1})...`);
        db = new Database(DB_PATH);
        dbGeneration++;

        const integrity = db.prepare('PRAGMA integrity_check(1)').get();
        const integrityOk = integrity && Object.values(integrity)[0] === 'ok';
        if (!integrityOk) {
            throw new Error(`Database failed integrity_check on open: ${JSON.stringify(integrity)}`);
        }

        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('busy_timeout = 15000');
        db.pragma('cache_size = -262144');
        db.pragma('temp_store = MEMORY');
        db.pragma('foreign_keys = OFF');
        registerManaMatchFunction(db);

        vLog('DB', 'Executing table creation schemas if not present...');
        db.exec(`
            ${buildCreateCardsTableSQL()}
            CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_cards_set ON cards(set_code);
            CREATE INDEX IF NOT EXISTS idx_cards_uuid ON cards(mtgjson_uuid);
            CREATE INDEX IF NOT EXISTS idx_cards_oracle_id ON cards(oracle_id);
            CREATE INDEX IF NOT EXISTS idx_cards_rarity ON cards(rarity);
            CREATE INDEX IF NOT EXISTS idx_cards_cmc ON cards(cmc);
            CREATE INDEX IF NOT EXISTS idx_cards_released ON cards(released_at);
            CREATE INDEX IF NOT EXISTS idx_cards_missing_scry ON cards(scryfall_synced_at);

            CREATE TABLE IF NOT EXISTS card_tags (
                scryfall_id     TEXT,
                tag             TEXT,
                source          TEXT DEFAULT 'metadata',
                PRIMARY KEY (scryfall_id, tag)
            );
            CREATE INDEX IF NOT EXISTS idx_card_tags_tag ON card_tags(tag);

            -- REAL Scryfall Tagger data (confirmed available as official
            -- bulk-data types 'oracle_tags' and 'art_tags' — see Section 12).
            -- Kept as their own tables joined by oracle_id/illustration_id at
            -- query time instead of exploding into card_tags per-printing,
            -- since one oracle tag can apply to thousands of printings and
            -- denormalizing would multiply the bulk file's row count by the
            -- average printings-per-card for no real benefit.
            CREATE TABLE IF NOT EXISTS oracle_tags (
                tag_id          TEXT,
                slug            TEXT,
                label           TEXT,
                oracle_id       TEXT,
                PRIMARY KEY (tag_id, oracle_id)
            );
            CREATE INDEX IF NOT EXISTS idx_oracle_tags_oracle ON oracle_tags(oracle_id);
            CREATE INDEX IF NOT EXISTS idx_oracle_tags_slug ON oracle_tags(slug);

            CREATE TABLE IF NOT EXISTS illustration_tags (
                tag_id          TEXT,
                slug            TEXT,
                label           TEXT,
                illustration_id TEXT,
                PRIMARY KEY (tag_id, illustration_id)
            );
            CREATE INDEX IF NOT EXISTS idx_illustration_tags_illus ON illustration_tags(illustration_id);
            CREATE INDEX IF NOT EXISTS idx_illustration_tags_slug ON illustration_tags(slug);

            CREATE TABLE IF NOT EXISTS rulings (
                id              TEXT PRIMARY KEY,
                oracle_id       TEXT,
                scryfall_id     TEXT,
                published_at    TEXT,
                source          TEXT,
                comment         TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_rulings_oracle ON rulings(oracle_id);
            CREATE INDEX IF NOT EXISTS idx_rulings_scryfall ON rulings(scryfall_id);

            CREATE TABLE IF NOT EXISTS manapool_sales (
                id              TEXT PRIMARY KEY,
                scryfall_id     TEXT,
                date            INTEGER,
                price           REAL,
                condition       TEXT,
                foil            INTEGER,
                language        TEXT,
                quantity        INTEGER,
                raw_data        TEXT,
                source_date     TEXT,
                ingested_at     INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_sales_scryfall ON manapool_sales(scryfall_id);
            CREATE INDEX IF NOT EXISTS idx_sales_date ON manapool_sales(date);
            CREATE INDEX IF NOT EXISTS idx_sales_lookup ON manapool_sales(scryfall_id, date, source_date);

            CREATE TABLE IF NOT EXISTS image_cache (
                scryfall_id     TEXT NOT NULL,
                type            TEXT NOT NULL,
                face            TEXT NOT NULL DEFAULT 'front',
                rel_path        TEXT,
                bytes           INTEGER,
                sha256          TEXT,
                cached_at       INTEGER,
                hit_count       INTEGER NOT NULL DEFAULT 0,
                last_hit_at     INTEGER,
                PRIMARY KEY (scryfall_id, type, face)
            );

            CREATE TABLE IF NOT EXISTS sync_state (
                key             TEXT PRIMARY KEY,
                value           TEXT,
                updated_at      INTEGER
            );

            CREATE TABLE IF NOT EXISTS import_audit (
                date            TEXT NOT NULL,
                source          TEXT NOT NULL,
                file_entry_count INTEGER,
                imported_count  INTEGER,
                skipped_count   INTEGER,
                expected_row_total INTEGER,
                status          TEXT,
                checked_at      INTEGER,
                PRIMARY KEY (date, source)
            );

            CREATE TABLE IF NOT EXISTS audit_log (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                ts              INTEGER,
                level           TEXT,
                tag             TEXT,
                message         TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
        `);

        // Forward-migration shim: add any columns a prior schema version
        // (including the pre-Bedrock "Monolith" schema) might be missing,
        // without ever dropping data. This runs every boot and is a no-op
        // once caught up.
        const cardCols = db.prepare("PRAGMA table_info(cards)").all().map((c) => c.name);
        for (const [col, type] of Object.entries(CARD_TABLE_COLUMNS)) {
            if (!cardCols.includes(col)) {
                vLog('DB_MIGRATE', `Adding missing column cards.${col} (${type})...`);
                try { db.exec(`ALTER TABLE cards ADD COLUMN ${col} ${type.replace(' PRIMARY KEY', '')}`); }
                catch (e) { vLog('DB_MIGRATE_ERR', `Could not add column ${col}: ${e.message}`); }
            }
        }
        const saleCols = db.prepare("PRAGMA table_info(manapool_sales)").all().map((c) => c.name);
        for (const [col, type] of [['source_date', 'TEXT'], ['language', 'TEXT']]) {
            if (!saleCols.includes(col)) {
                vLog('DB_MIGRATE', `Adding missing column manapool_sales.${col} (${type})...`);
                try { db.exec(`ALTER TABLE manapool_sales ADD COLUMN ${col} ${type}`); } catch (e) { /* already exists, race with above */ }
            }
        }
        const tagCols = db.prepare("PRAGMA table_info(card_tags)").all().map((c) => c.name);
        if (!tagCols.includes('source')) {
            try { db.exec(`ALTER TABLE card_tags ADD COLUMN source TEXT DEFAULT 'metadata'`); } catch (e) { /* noop */ }
        }
        try {
            const auditCols = db.prepare("PRAGMA table_info(import_audit)").all().map((c) => c.name);
            if (!auditCols.includes('expected_row_total')) {
                db.exec(`ALTER TABLE import_audit ADD COLUMN expected_row_total INTEGER`);
            }
        } catch (e) { /* table may not exist yet on very first CREATE — harmless */ }

        // BUGFIX (found via live testing): an earlier version's unique index
        // on manapool_sales(scryfall_id, date, price, condition, foil,
        // quantity, language) silently collapsed genuinely-distinct sales
        // that happened to share every one of those tracked values (e.g.
        // two separate line items in the same batch of recent_sales with
        // identical timestamp/price/quantity) — this was misread as "finding
        // dupes on a fresh run" and was actually real data loss. Conflict
        // resolution now happens on the primary key `id` alone (see
        // Section 11's occurrence-disambiguated hashing), so this old index
        // must be dropped on any database that still has it.
        try {
            const oldIdx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_sales_unique'").get();
            if (oldIdx) {
                vLog('DB_MIGRATE', 'Dropping obsolete idx_sales_unique (superseded by id-based conflict resolution — see changelog).');
                db.exec('DROP INDEX idx_sales_unique');
            }
        } catch (e) { vLog('DB_MIGRATE_ERR', `Could not drop legacy idx_sales_unique: ${e.message}`); }

        // Migration: image_cache's PRIMARY KEY grew a `face` column (front/
        // back) to support double-faced card images — SQLite can't ALTER a
        // PRIMARY KEY in place, so an existing table without `face` gets
        // rebuilt: old rows are assumed to be the front face (the only kind
        // ever cached before this change).
        try {
            const imgCols = db.prepare("PRAGMA table_info(image_cache)").all().map((c) => c.name);
            if (imgCols.length > 0 && !imgCols.includes('face')) {
                vLog('DB_MIGRATE', 'Rebuilding image_cache to add `face` to its primary key (double-faced card support)...');
                db.exec(`
                    ALTER TABLE image_cache RENAME TO image_cache_old_migrating;
                    CREATE TABLE image_cache (
                        scryfall_id     TEXT NOT NULL,
                        type            TEXT NOT NULL,
                        face            TEXT NOT NULL DEFAULT 'front',
                        rel_path        TEXT,
                        bytes           INTEGER,
                        sha256          TEXT,
                        cached_at       INTEGER,
                        PRIMARY KEY (scryfall_id, type, face)
                    );
                    INSERT INTO image_cache (scryfall_id, type, face, rel_path, bytes, sha256, cached_at)
                        SELECT scryfall_id, type, 'front', rel_path, bytes, sha256, cached_at FROM image_cache_old_migrating;
                    DROP TABLE image_cache_old_migrating;
                `);
            }
        } catch (e) { vLog('DB_MIGRATE_ERR', `Could not migrate image_cache to include face: ${e.message}`); }

        // Migration: image_cache gains hit_count/last_hit_at for
        // usage-weighted eviction (see Section on disk-budget culling) —
        // added as plain nullable/defaulted columns, no table rebuild
        // needed since neither is part of the primary key.
        try {
            const imgCols2 = db.prepare("PRAGMA table_info(image_cache)").all().map((c) => c.name);
            if (!imgCols2.includes('hit_count')) {
                vLog('DB_MIGRATE', 'Adding missing column image_cache.hit_count...');
                db.exec(`ALTER TABLE image_cache ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0`);
            }
            if (!imgCols2.includes('last_hit_at')) {
                vLog('DB_MIGRATE', 'Adding missing column image_cache.last_hit_at...');
                db.exec(`ALTER TABLE image_cache ADD COLUMN last_hit_at INTEGER`);
            }
            db.exec(`CREATE INDEX IF NOT EXISTS idx_image_cache_hits ON image_cache(hit_count, last_hit_at)`);
        } catch (e) { vLog('DB_MIGRATE_ERR', `Could not migrate image_cache to include hit tracking: ${e.message}`); }

        // FTS5 full-text index over the fields Scryfall search treats as
        // "text" targets. External-content table keyed off cards' implicit
        // rowid, kept in sync via triggers so every INSERT/UPDATE/UPSERT/
        // DELETE on `cards` automatically maintains the index — nothing in
        // the ingestion pipelines needs to know FTS5 exists.
        db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
                name, type_line, oracle_text, flavor_text,
                content='cards', content_rowid='rowid'
            );
        `);
        const ftsCount = db.prepare('SELECT COUNT(*) AS cnt FROM cards_fts').get().cnt;
        const cardsCount = db.prepare('SELECT COUNT(*) AS cnt FROM cards').get().cnt;
        if (ftsCount === 0 && cardsCount > 0) {
            vLog('DB_MIGRATE', `Populating FTS5 index for ${cardsCount} existing card(s) (one-time backfill)...`);
            db.exec(`INSERT INTO cards_fts(rowid, name, type_line, oracle_text, flavor_text)
                     SELECT rowid, name, type_line, oracle_text, flavor_text FROM cards`);
        }
        db.exec(`
            CREATE TRIGGER IF NOT EXISTS cards_fts_ai AFTER INSERT ON cards BEGIN
                INSERT INTO cards_fts(rowid, name, type_line, oracle_text, flavor_text)
                VALUES (new.rowid, new.name, new.type_line, new.oracle_text, new.flavor_text);
            END;
            CREATE TRIGGER IF NOT EXISTS cards_fts_ad AFTER DELETE ON cards BEGIN
                INSERT INTO cards_fts(cards_fts, rowid, name, type_line, oracle_text, flavor_text)
                VALUES ('delete', old.rowid, old.name, old.type_line, old.oracle_text, old.flavor_text);
            END;
            CREATE TRIGGER IF NOT EXISTS cards_fts_au AFTER UPDATE ON cards BEGIN
                INSERT INTO cards_fts(cards_fts, rowid, name, type_line, oracle_text, flavor_text)
                VALUES ('delete', old.rowid, old.name, old.type_line, old.oracle_text, old.flavor_text);
                INSERT INTO cards_fts(rowid, name, type_line, oracle_text, flavor_text)
                VALUES (new.rowid, new.name, new.type_line, new.oracle_text, new.flavor_text);
            END;
        `);

        stats.dbStatus = 'ONLINE (WAL)';
        vLog('DB', 'Database initialized successfully.');
        updateCounts();
    } catch (err) {
        vLog('DB_ERR', `Database error during init: ${err.message}`);
        stats.dbStatus = 'RECOVERING';
        updateUI();
        try { if (db) db.close(); } catch (e) { /* noop */ }
        db = null;

        // Recovery order matters: ALWAYS prefer restoring a known-good
        // snapshot over wiping to empty, since a snapshot might be only
        // minutes old and preserve nearly everything, whereas wiping
        // discards data that a full re-sync may take hours to rebuild.
        restoreFromBestAvailableSnapshot('db-open-or-integrity-failure')
            .then((restored) => {
                if (restored) {
                    vLog('DB_RESTORE_SUCCESS', 'Recovered database from a prior snapshot after open/integrity failure.');
                    initDatabase(attempt + 1);
                } else {
                    vLog('DB_RESTORE', 'No usable snapshot was available. Wiping to a fresh empty database — self-heal will rehydrate from local backup archives on boot.');
                    if (fsSync.existsSync(DB_PATH)) {
                        const corruptPath = `${DB_PATH}.corrupt.${Date.now()}`;
                        try { fsSync.renameSync(DB_PATH, corruptPath); vLog('DB_RESTORE', `Corrupt database preserved for forensics at ${corruptPath}`); }
                        catch (e) { try { fsSync.unlinkSync(DB_PATH); } catch (e2) { /* noop */ } }
                    }
                    for (const suffix of ['-wal', '-shm']) {
                        const p = DB_PATH + suffix;
                        if (fsSync.existsSync(p)) { try { fsSync.unlinkSync(p); } catch (e) { /* noop */ } }
                    }
                    initDatabase(attempt + 1);
                }
            })
            .catch((restoreErr) => {
                vLog('DB_RESTORE_ERR', `Snapshot restore attempt itself failed: ${restoreErr.message}. Falling back to fresh database.`);
                initDatabase(attempt + 1);
            });
    }
}

function updateCounts() {
    if (!db) return;
    try {
        stats.cardCount = db.prepare('SELECT COUNT(*) AS cnt FROM cards').get().cnt;
        stats.salesCount = db.prepare('SELECT COUNT(*) AS cnt FROM manapool_sales').get().cnt;
        stats.cachedImages = db.prepare('SELECT COUNT(*) AS cnt FROM image_cache').get().cnt;
        stats.uncachedImages = Math.max(0, stats.cardCount - stats.cachedImages);
        stats.cardsMissingScryfallData = db.prepare('SELECT COUNT(*) AS cnt FROM cards WHERE scryfall_synced_at IS NULL').get().cnt;

        let totalBytes = 0;
        for (const suffix of ['', '-wal', '-shm']) {
            const p = DB_PATH + suffix;
            if (fsSync.existsSync(p)) totalBytes += fsSync.statSync(p).size;
        }
        stats.dbSize = formatBytes(totalBytes);
        updateUI();
    } catch (err) {
        vLog('DB_STATS_ERR', `Failed to update counts: ${err.message}`);
    }
}

function getSyncState(key) {
    try {
        const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
        return row ? row.value : null;
    } catch (e) { return null; }
}

function setSyncState(key, value) {
    try {
        db.prepare(`
            INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(key, String(value), Date.now());
    } catch (e) {
        vLog('DB_ERR', `Failed to persist sync_state[${key}]: ${e.message}`);
    }
}

/**
 * STATS PERSISTENCE — addresses the documented "reboot forgets everything"
 * gap: sync timestamps, cumulative counters (total requests served,
 * image cache hits/misses, snapshots/rollbacks/heals/enrichment counts)
 * used to live purely in the in-memory `stats` object and reset to zero on
 * every restart even though nothing about the underlying history actually
 * changed. Two mechanisms:
 *   1. The three "last synced" timestamps were ALREADY being written to
 *      sync_state on every successful sync (mtgjson_last_sync etc.) but
 *      were never read back into `stats` at boot — trivial fix, loadStatsSnapshot()
 *      does it directly from those existing keys.
 *   2. Everything else (counters that increment continuously rather than
 *      being set once per sync) is persisted as one JSON blob under a
 *      single sync_state key, written periodically (not on every single
 *      increment — that would mean a DB write per HTTP request, which is
 *      not a trade worth making) and once more on graceful shutdown.
 * rps/peakRps/status2xx/4xx/5xx/requestRing are deliberately NOT persisted
 * — those describe live traffic right now, not history, and resetting them
 * on restart is correct, not a bug.
 */
const STATS_SNAPSHOT_KEY = 'stats_snapshot_v1';
const STATS_PERSIST_FIELDS = [
    'totalRequests', 'cacheHits', 'cacheMisses',
    'snapshotsTaken', 'rollbacksPerformed', 'healActionsTaken',
    'patchedFromBackup', 'cardsEnrichedThisSession',
    'lastAuditAt', 'lastAuditStatus',
];
function persistStatsSnapshot() {
    if (!db) return;
    try {
        const snapshot = {};
        for (const key of STATS_PERSIST_FIELDS) snapshot[key] = stats[key];
        setSyncState(STATS_SNAPSHOT_KEY, JSON.stringify(snapshot));
    } catch (e) {
        vLog('STATS_PERSIST_ERR', `Failed to persist stats snapshot: ${e.message}`);
    }
}
function loadStatsSnapshot() {
    try {
        const mtgjsonLast = getSyncState('mtgjson_last_sync');
        if (mtgjsonLast) stats.lastMtgjsonSyncAt = parseInt(mtgjsonLast, 10);
        const manapoolLast = getSyncState('manapool_last_sync');
        if (manapoolLast) stats.lastManapoolSyncAt = parseInt(manapoolLast, 10);
        const scryfallLast = getSyncState('scryfall_bulk_last_sync');
        if (scryfallLast) stats.lastScryfallSyncAt = parseInt(scryfallLast, 10);

        const raw = getSyncState(STATS_SNAPSHOT_KEY);
        if (raw) {
            const snapshot = JSON.parse(raw);
            for (const key of STATS_PERSIST_FIELDS) {
                if (snapshot[key] !== undefined && snapshot[key] !== null) stats[key] = snapshot[key];
            }
            vLog('BOOT', `Restored persisted stats from a previous run: ${stats.totalRequests.toLocaleString()} lifetime requests, ${stats.cacheHits.toLocaleString()} cache hits, last audit ${stats.lastAuditStatus || 'unknown'}.`);
        } else {
            vLog('BOOT', 'No persisted stats snapshot found (first run, or an older database predating this feature) — cumulative counters start fresh.');
        }
    } catch (e) {
        vLog('STATS_PERSIST_ERR', `Failed to restore stats snapshot (starting fresh): ${e.message}`);
    }
}

// ============================================================================
// SECTION 7: SNAPSHOTS, MUTEX-GUARDED MUTATIONS, CASCADING RESTORE
// ============================================================================
async function snapshotDatabase(tag) {
    const backupPath = path.join(BACKUP_SNAPSHOT_DIR, `cards_${tag.replace(/[^a-z0-9_-]/gi, '_')}_${Date.now()}.db.bak`);
    vLog('SNAPSHOT', `Creating hot database snapshot [tag: ${tag}] -> ${path.relative(ROOT_DIR, backupPath)}`);
    try {
        await db.backup(backupPath);
        stats.snapshotsTaken++;
        vLog('SNAPSHOT_SUCCESS', `Database snapshot saved successfully (${formatBytes(fsSync.statSync(backupPath).size)}).`);
        pruneOldSnapshots().catch(() => {});
        return backupPath;
    } catch (err) {
        vLog('SNAPSHOT_ERR', `Backup snapshot failed: ${err.message}`);
        try { await fs.unlink(backupPath); } catch (e) { /* may not have been created */ }
        return null;
    }
}

async function pruneOldSnapshots() {
    try {
        const files = (await fs.readdir(BACKUP_SNAPSHOT_DIR))
            .filter((f) => f.endsWith('.db.bak'))
            .map((f) => ({ f, t: fsSync.statSync(path.join(BACKUP_SNAPSHOT_DIR, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t);
        const toDelete = files.slice(SNAPSHOT_RETENTION_COUNT);
        for (const { f } of toDelete) {
            await fs.unlink(path.join(BACKUP_SNAPSHOT_DIR, f)).catch(() => {});
            vLog('SNAPSHOT_PRUNE', `Removed aged snapshot ${f}`);
        }
    } catch (e) {
        vLog('SNAPSHOT_PRUNE_ERR', e.message);
    }
}

/**
 * Copies one specific snapshot file over DB_PATH and verifies it with a
 * throwaway connection + integrity_check before trusting it. Throws if the
 * snapshot itself turns out to be unusable (never silently "succeeds" with
 * a bad file). Does NOT reconnect the global `db` handle or touch
 * `dbGeneration` — every caller is responsible for calling initDatabase()
 * afterward if/when it wants a live connection again. This keeps the
 * restore primitive simple and makes every call site's control flow
 * explicit rather than relying on hidden reconnection side effects.
 */
function restoreDatabaseFromExactSnapshot(snapshotPath) {
    if (db) { try { db.close(); } catch (e) { /* noop */ } db = null; }
    for (const suffix of ['-wal', '-shm']) {
        const p = DB_PATH + suffix;
        if (fsSync.existsSync(p)) { try { fsSync.unlinkSync(p); } catch (e) { /* noop */ } }
    }
    fsSync.copyFileSync(snapshotPath, DB_PATH);

    let test = null;
    try {
        test = new Database(DB_PATH);
        const integrity = test.prepare('PRAGMA integrity_check(1)').get();
        const ok = integrity && Object.values(integrity)[0] === 'ok';
        test.close();
        test = null;
        if (!ok) throw new Error(`Restored snapshot failed integrity_check: ${JSON.stringify(integrity)}`);
    } catch (err) {
        if (test) { try { test.close(); } catch (e) { /* noop */ } }
        throw err;
    }
    stats.rollbacksPerformed++;
}

/**
 * Cascades backwards through every retained snapshot, newest first, until
 * one actually restores cleanly (survives copy + integrity_check), or none
 * do. This is the direct answer to "roll back 5 times and even the
 * rollback didn't complete" — each failed candidate is logged and excluded,
 * and the next-oldest is tried automatically. Assumes the caller already
 * holds dbWriteLock (or that nothing else could possibly be contending for
 * it yet, e.g. very early boot) — see restoreFromBestAvailableSnapshot for
 * the lock-acquiring public entry point.
 */
async function restoreFromBestAvailableSnapshotLocked(reason, excludePaths = []) {
    let candidates = [];
    try {
        const names = await fs.readdir(BACKUP_SNAPSHOT_DIR);
        for (const name of names) {
            if (!name.endsWith('.db.bak')) continue;
            const full = path.join(BACKUP_SNAPSHOT_DIR, name);
            if (excludePaths.includes(full)) continue;
            try { candidates.push({ f: full, t: (await fs.stat(full)).mtimeMs }); } catch (e) { /* vanished mid-scan */ }
        }
    } catch (e) { candidates = []; }
    candidates.sort((a, b) => b.t - a.t);

    if (candidates.length === 0) {
        vLog('RESTORE', `[${reason}] No retained snapshots available to restore from.`);
        return false;
    }

    for (const { f } of candidates) {
        vLog('RESTORE', `[${reason}] Attempting restore from snapshot: ${path.basename(f)}`);
        try {
            restoreDatabaseFromExactSnapshot(f);
            auditLog('INFO', 'RESTORE_SUCCESS', `[${reason}] Successfully restored from snapshot ${path.basename(f)}.`);
            return true;
        } catch (err) {
            auditLog('ERROR', 'RESTORE_CANDIDATE_FAIL', `[${reason}] Snapshot ${path.basename(f)} was itself unusable (${err.message}) — trying next-oldest retained snapshot.`);
        }
    }
    auditLog('CRITICAL', 'RESTORE_EXHAUSTED', `[${reason}] Every retained snapshot (${candidates.length}) failed to restore.`);
    return false;
}

/** Public, lock-acquiring entry point for restoring outside of an
 * already-guarded operation (boot-time recovery, manual TUI trigger). */
async function restoreFromBestAvailableSnapshot(reason) {
    const release = await dbWriteLock.acquire();
    stats.dbLockActive = `restore:${reason}`;
    try {
        return await restoreFromBestAvailableSnapshotLocked(reason);
    } finally {
        stats.dbLockActive = 'None';
        release();
    }
}

/**
 * The single choke point every bulk-mutation pipeline routes through:
 * acquire the global write lock (see AsyncMutex for why this is a single
 * lock rather than fine-grained concurrency) -> snapshot -> attempt,
 * bounded by a timeout -> on any failure, roll back to this operation's own
 * pre-mutation snapshot; if THAT specific rollback itself fails, cascade
 * through every older retained snapshot; if every single one fails, leave
 * the (possibly inconsistent) database in place rather than destroying it
 * further, and log CRITICAL so it surfaces everywhere (TUI, audit_log,
 * supervisor console).
 */
async function withSnapshotGuard(tag, fn, { timeoutMs = DEFAULT_OP_TIMEOUT_MS } = {}) {
    const release = await dbWriteLock.acquire();
    stats.dbLockActive = tag;
    try {
        const snapshotPath = await snapshotDatabase(tag);
        try {
            return await withTimeout(Promise.resolve().then(fn), timeoutMs, tag);
        } catch (err) {
            auditLog('ERROR', `${tag}_GUARD_FAIL`, `Guarded operation failed: ${err.message}. Rolling back.`);
            if (snapshotPath) {
                try {
                    restoreDatabaseFromExactSnapshot(snapshotPath);
                    initDatabase();
                    vLog('RESTORE_SUCCESS', `[${tag}] Rolled back to this operation's own pre-mutation snapshot. Daemon remains online.`);
                } catch (restoreErr) {
                    auditLog('CRITICAL', `${tag}_RESTORE_FAIL`, `This operation's own snapshot failed to restore (${restoreErr.message}). Cascading through older retained snapshots...`);
                    const cascaded = await restoreFromBestAvailableSnapshotLocked(`${tag}_cascade`, [snapshotPath]);
                    if (cascaded) {
                        initDatabase();
                    } else {
                        auditLog('CRITICAL', `${tag}_RESTORE_EXHAUSTED`, 'Every retained snapshot failed. Leaving current database in place. A fresh rehydration pass from local backup archives is recommended (will happen automatically on next restart if card count looks empty/low).');
                        if (!db) initDatabase();
                    }
                }
            } else {
                vLog('GUARD_ERR', 'No snapshot was available to roll back to — leaving DB state as-is.');
            }
            throw err;
        }
    } finally {
        stats.dbLockActive = 'None';
        release();
    }
}

// ============================================================================
// SECTION 8: SELF-AUDIT / SELF-HEAL
// ============================================================================
/** Lightweight, mutex-only (no full snapshot) guard for small, cheap,
 * idempotent single-row writes — see the AsyncMutex note for why heavy
 * pipelines get a full snapshot but single-row upserts do not: taking a
 * whole-database file copy on every image-cache row or per-card enrichment
 * write would be enormously wasteful of disk I/O for something that is
 * trivially safe to just retry if it's ever lost. The mutex acquisition
 * alone is still essential, though: without it, a single-row write could
 * land in the middle of a bulk pipeline's restoreDatabaseFromExactSnapshot
 * (which closes and overwrites the underlying file), throwing a confusing
 * low-level error or silently writing into a file that's about to vanish. */
async function withWriteLock(fn) {
    const release = await dbWriteLock.acquire();
    try { return await fn(); } finally { release(); }
}

let isHealing = false;
async function runSelfAudit() {
    if (isHealing) { vLog('AUDIT', 'Self-audit already in progress; skipping overlapping run.'); return; }
    isHealing = true;
    vLog('AUDIT', 'Running scheduled database integrity and schema audit...');
    try {
        if (!db) { vLog('AUDIT', 'No live database handle right now — skipping this audit cycle.'); return; }

        let integrity;
        try { integrity = db.prepare('PRAGMA integrity_check(1)').get(); } catch (e) { integrity = null; }
        const integrityOk = integrity && Object.values(integrity)[0] === 'ok';
        if (!integrityOk) {
            auditLog('CRITICAL', 'AUDIT_INTEGRITY_FAIL', `Live database failed integrity_check: ${integrity ? JSON.stringify(integrity) : '(query threw)'}. Attempting cascading snapshot restore.`);
            const restored = await restoreFromBestAvailableSnapshot('scheduled-audit-integrity-fail');
            if (restored) initDatabase(); else vLog('AUDIT_ERR', 'No usable snapshot available; will retry next audit cycle.');
            return;
        }

        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
        const requiredTables = ['cards', 'card_tags', 'rulings', 'manapool_sales', 'image_cache', 'sync_state', 'import_audit', 'audit_log'];
        const missingTables = requiredTables.filter((t) => !tables.includes(t));
        if (missingTables.length > 0) {
            auditLog('CRITICAL', 'AUDIT_SCHEMA_FAIL', `Critical table(s) missing: ${missingTables.join(', ')}. Repairing schema.`);
            initDatabase();
            return;
        }

        let healActions = 0;
        try {
            healActions += await withSnapshotGuard('self_heal_purge', async () => {
                let actions = 0;

                const orphanSales = db.prepare(`
                    SELECT COUNT(*) AS cnt FROM manapool_sales s
                    WHERE NOT EXISTS (SELECT 1 FROM cards c WHERE c.scryfall_id = s.scryfall_id)
                `).get().cnt;
                if (orphanSales > 0) {
                    vLog('HEAL', `Found ${orphanSales} orphaned sales records. Purging...`);
                    db.prepare(`DELETE FROM manapool_sales WHERE NOT EXISTS (SELECT 1 FROM cards c WHERE c.scryfall_id = manapool_sales.scryfall_id)`).run();
                    actions++;
                }

                const badCards = db.prepare('SELECT scryfall_id FROM cards').all()
                    .filter((r) => !r.scryfall_id || !UUID_RE.test(r.scryfall_id));
                if (badCards.length > 0) {
                    vLog('HEAL', `Found ${badCards.length} cards with malformed scryfall_id. Purging...`);
                    const del = db.prepare('DELETE FROM cards WHERE scryfall_id = ?');
                    const tx = db.transaction((rows) => { for (const r of rows) del.run(r.scryfall_id); });
                    tx(badCards);
                    actions++;
                }

                const orphanTags = db.prepare(`SELECT COUNT(*) AS cnt FROM card_tags t WHERE NOT EXISTS (SELECT 1 FROM cards c WHERE c.scryfall_id = t.scryfall_id)`).get().cnt;
                if (orphanTags > 0) {
                    db.prepare(`DELETE FROM card_tags WHERE NOT EXISTS (SELECT 1 FROM cards c WHERE c.scryfall_id = card_tags.scryfall_id)`).run();
                    vLog('HEAL', `Purged ${orphanTags} orphaned card_tags rows.`);
                    actions++;
                }

                const orphanRulings = db.prepare(`SELECT COUNT(*) AS cnt FROM rulings r WHERE r.scryfall_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.scryfall_id = r.scryfall_id)`).get().cnt;
                if (orphanRulings > 0) {
                    db.prepare(`DELETE FROM rulings WHERE scryfall_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.scryfall_id = rulings.scryfall_id)`).run();
                    vLog('HEAL', `Purged ${orphanRulings} orphaned rulings rows.`);
                    actions++;
                }

                const imageRows = db.prepare('SELECT scryfall_id, type, face, rel_path FROM image_cache').all();
                let staleImageRows = 0;
                const delImg = db.prepare('DELETE FROM image_cache WHERE scryfall_id = ? AND type = ? AND face = ?');
                const imgTx = db.transaction((rows) => {
                    for (const row of rows) {
                        try {
                            const full = path.join(IMG_CACHE_DIR, row.rel_path || '');
                            if (!row.rel_path || !fsSync.existsSync(full) || fsSync.statSync(full).size === 0) {
                                delImg.run(row.scryfall_id, row.type, row.face);
                                staleImageRows++;
                            }
                        } catch (e) {
                            delImg.run(row.scryfall_id, row.type, row.face);
                            staleImageRows++;
                        }
                    }
                });
                imgTx(imageRows);
                if (staleImageRows > 0) {
                    vLog('HEAL', `Reconciled ${staleImageRows} stale image_cache rows.`);
                    actions++;
                }

                return actions;
            });
        } catch (purgeErr) {
            vLog('AUDIT_ERR', `Purge sub-pass failed and was rolled back by its own guard: ${purgeErr.message}`);
        }

        try {
            const mpAudit = await auditManapoolCompleteness();
            if (mpAudit && mpAudit.triggeredReimport) healActions++;
        } catch (e) {
            vLog('AUDIT_ERR', `ManaPool completeness audit failed: ${e.message}`);
        }

        updateCounts();
        if (stats.cardsMissingScryfallData > 0) {
            vLog('AUDIT', `${stats.cardsMissingScryfallData.toLocaleString()} card(s) still missing cross-referenced Scryfall data — background enrichment trickle is closing this gap.`);
        }

        try { db.pragma('wal_checkpoint(PASSIVE)'); } catch (e) { vLog('AUDIT_ERR', `WAL checkpoint failed: ${e.message}`); }
        trimAuditLog();

        stats.healActionsTaken += healActions;
        stats.lastAuditStatus = healActions > 0 ? `Healed (${healActions} action(s))` : 'Healthy (OK)';
        stats.lastAuditAt = Date.now();
        auditLog('INFO', 'AUDIT_SUCCESS', `Self-audit complete. ${healActions} heal action(s) taken.`);
    } catch (err) {
        auditLog('ERROR', 'AUDIT_ERR', `Audit anomaly: ${err.message}`);
        stats.lastAuditStatus = 'Anomaly detected — attempting repair';
        try {
            vLog('HEAL', 'Attempting emergency REINDEX + VACUUM...');
            db.exec('REINDEX;');
            db.exec('VACUUM;');
            stats.lastAuditStatus = 'Repaired via VACUUM/REINDEX';
            vLog('HEAL_SUCCESS', 'Database vacuumed, reindexed, and optimized.');
        } catch (healErr) {
            vLog('HEAL_ERR', `Emergency self-healing failed: ${healErr.message}. Attempting cascading snapshot restore.`);
            try {
                const restored = await restoreFromBestAvailableSnapshot('audit-emergency-fallback');
                if (restored) { initDatabase(); } else { await rehydrateFromBackups(); }
            } catch (rehydrateErr) {
                vLog('HEAL_ERR', `Backup rehydration also failed: ${rehydrateErr.message}`);
            }
        }
        stats.lastAuditAt = Date.now();
    } finally {
        isHealing = false;
        updateCounts();
    }
}

// ============================================================================
// SECTION 8B: DISK SPACE BUDGET AUDIT
// ============================================================================
// Keeps the daemon's total on-disk footprint under DISK_BUDGET_TOTAL_BYTES,
// split into two independently-tracked pools:
//   - "cache": the image cache (IMG_CACHE_DIR). Culled by USAGE, not just
//     age — least-hit images go first, so a popular card's art survives
//     even if it's old, while a one-off preload nobody ever actually
//     looked at gets reclaimed first regardless of how recently it landed.
//   - "archive": MTGJSON/ManaPool/Scryfall raw backup archives + DB
//     snapshots, combined into one pool and culled strictly oldest-first,
//     since there's no "usage" concept for a backup file.
// Neither pool ever goes below what's needed to keep the daemon
// self-healing: the single newest DB snapshot and the single
// most-recently-dated archive folder per source are never culled, no
// matter how far over budget the rest of the pool is — losing the very
// last restore point or the very last local rehydration source in the
// name of hitting a byte target would defeat the whole point of having
// them.
async function computeDirTotalBytesRecursive(dir) {
    let total = 0;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return 0; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        try {
            if (entry.isDirectory()) total += await computeDirTotalBytesRecursive(full);
            else total += (await fs.stat(full)).size;
        } catch (e) { /* vanished mid-scan (concurrent write/cull) — skip, not fatal */ }
    }
    return total;
}

/**
 * Culls least-used, then least-recently-used, cached images until the
 * image cache pool is back under budget. Usage comes straight from
 * image_cache.hit_count/last_hit_at (see recordImageHit) — a row that's
 * never been hit (hit_count = 0, last_hit_at NULL) sorts first no matter
 * how new it is, ahead of even a very old but frequently-viewed image.
 */
async function auditImageCacheBudget() {
    if (!db) return { culled: 0, freedBytes: 0 };
    let totalBytes = 0;
    try {
        totalBytes = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM image_cache').get().total;
    } catch (e) {
        vLog('DISK_AUDIT_ERR', `Could not compute image cache size: ${e.message}`);
        return { culled: 0, freedBytes: 0 };
    }
    stats.diskCacheBytesUsed = totalBytes;
    if (totalBytes <= DISK_BUDGET_CACHE_BYTES) return { culled: 0, freedBytes: 0 };

    const targetBytes = Math.floor(DISK_BUDGET_CACHE_BYTES * DISK_AUDIT_TARGET_FRACTION);
    const toFree = totalBytes - targetBytes;
    vLog('DISK_AUDIT', `Image cache (${formatBytes(totalBytes)}) is over budget (${formatBytes(DISK_BUDGET_CACHE_BYTES)}). Culling least-used images to free ~${formatBytes(toFree)}...`);

    let candidates = [];
    try {
        candidates = db.prepare(`
            SELECT scryfall_id, type, face, rel_path, bytes, hit_count, last_hit_at, cached_at
            FROM image_cache
            ORDER BY hit_count ASC, COALESCE(last_hit_at, cached_at, 0) ASC, cached_at ASC
        `).all();
    } catch (e) {
        vLog('DISK_AUDIT_ERR', `Could not enumerate image cache candidates: ${e.message}`);
        return { culled: 0, freedBytes: 0 };
    }

    let culled = 0, freed = 0;
    await withWriteLock(async () => {
        const delStmt = db.prepare('DELETE FROM image_cache WHERE scryfall_id = ? AND type = ? AND face = ?');
        for (const row of candidates) {
            if (freed >= toFree) break;
            try {
                if (row.rel_path) {
                    const full = path.join(IMG_CACHE_DIR, row.rel_path);
                    try { fsSync.unlinkSync(full); } catch (e) { /* already gone — fine, we're deleting it either way */ }
                }
                delStmt.run(row.scryfall_id, row.type, row.face);
                freed += (row.bytes || 0);
                culled++;
            } catch (e) {
                vLog('DISK_AUDIT_ERR', `Failed to cull cached image ${row.scryfall_id}/${row.type}/${row.face}: ${e.message}`);
            }
        }
    });

    stats.diskCacheBytesUsed = Math.max(0, totalBytes - freed);
    if (culled > 0) vLog('DISK_AUDIT', `Culled ${culled} least-used cached image(s), freeing ${formatBytes(freed)}.`);
    return { culled, freedBytes: freed };
}

/** Gathers every cullable archive unit (individual snapshot files, whole
 * dated backup-source folders) with age + size, always excluding the
 * single newest of each so at least one restore point / rehydration
 * source per source always survives regardless of budget pressure. */
async function collectArchiveCullCandidates() {
    const candidates = [];

    try {
        const files = await fs.readdir(BACKUP_SNAPSHOT_DIR);
        const snapFiles = [];
        for (const f of files) {
            if (!f.endsWith('.db.bak')) continue;
            const full = path.join(BACKUP_SNAPSHOT_DIR, f);
            try {
                const st = await fs.stat(full);
                snapFiles.push({ kind: 'snapshot', label: f, path: full, mtimeMs: st.mtimeMs, bytes: st.size });
            } catch (e) { /* vanished mid-scan */ }
        }
        snapFiles.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
        for (let i = 1; i < snapFiles.length; i++) candidates.push(snapFiles[i]); // never cull index 0 (the newest)
    } catch (e) { /* snapshot dir may not exist yet */ }

    for (const sourceDir of [BACKUP_MTGJSON_DIR, BACKUP_MANAPOOL_DIR, BACKUP_SCRYFALL_DIR]) {
        try {
            const dayNames = (await fs.readdir(sourceDir)).sort().reverse(); // newest date-string first
            for (let i = 1; i < dayNames.length; i++) { // never cull index 0 (the most recent dated folder)
                const dayName = dayNames[i];
                const full = path.join(sourceDir, dayName);
                let st;
                try { st = await fs.stat(full); } catch (e) { continue; }
                if (!st.isDirectory()) continue;
                const dirBytes = await computeDirTotalBytesRecursive(full);
                candidates.push({ kind: 'archive_day', label: `${path.basename(sourceDir)}/${dayName}`, path: full, mtimeMs: st.mtimeMs, bytes: dirBytes });
            }
        } catch (e) { /* source dir may not exist yet */ }
    }

    return candidates;
}

async function computeArchiveTotalBytes() {
    let total = 0;
    for (const dir of [BACKUP_MTGJSON_DIR, BACKUP_MANAPOOL_DIR, BACKUP_SCRYFALL_DIR, BACKUP_SNAPSHOT_DIR]) {
        total += await computeDirTotalBytesRecursive(dir);
    }
    return total;
}

async function auditArchiveBudget() {
    let totalBytes = 0;
    try {
        totalBytes = await computeArchiveTotalBytes();
    } catch (e) {
        vLog('DISK_AUDIT_ERR', `Could not compute archive size: ${e.message}`);
        return { culled: 0, freedBytes: 0 };
    }
    stats.diskArchiveBytesUsed = totalBytes;
    if (totalBytes <= DISK_BUDGET_ARCHIVE_BYTES) return { culled: 0, freedBytes: 0 };

    const targetBytes = Math.floor(DISK_BUDGET_ARCHIVE_BYTES * DISK_AUDIT_TARGET_FRACTION);
    const toFree = totalBytes - targetBytes;
    vLog('DISK_AUDIT', `Backup/snapshot archive (${formatBytes(totalBytes)}) is over budget (${formatBytes(DISK_BUDGET_ARCHIVE_BYTES)}). Culling oldest first to free ~${formatBytes(toFree)}...`);

    const candidates = await collectArchiveCullCandidates();
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first, snapshots and archive-day folders mixed together

    let culled = 0, freed = 0;
    for (const c of candidates) {
        if (freed >= toFree) break;
        try {
            if (c.kind === 'snapshot') await fs.unlink(c.path);
            else await fs.rm(c.path, { recursive: true, force: true });
            freed += c.bytes;
            culled++;
            vLog('DISK_AUDIT', `Culled ${c.kind === 'snapshot' ? 'snapshot' : 'archive day'} ${c.label} (${formatBytes(c.bytes)}).`);
        } catch (e) {
            vLog('DISK_AUDIT_ERR', `Failed to cull ${c.label}: ${e.message}`);
        }
    }

    stats.diskArchiveBytesUsed = Math.max(0, totalBytes - freed);
    return { culled, freedBytes: freed };
}

let isDiskAuditing = false;
async function runDiskSpaceAudit() {
    if (isDiskAuditing) { vLog('DISK_AUDIT', 'Disk space audit already in progress; skipping overlapping run.'); return; }
    isDiskAuditing = true;
    try {
        const cacheResult = await auditImageCacheBudget();
        const archiveResult = await auditArchiveBudget();
        const totalCulled = cacheResult.culled + archiveResult.culled;
        const totalFreed = cacheResult.freedBytes + archiveResult.freedBytes;

        stats.imagesCulledForSpace += cacheResult.culled;
        stats.archiveItemsCulledForSpace += archiveResult.culled;
        stats.bytesFreedForSpace += totalFreed;
        stats.lastDiskAuditAt = Date.now();
        stats.diskAuditStatus = totalCulled > 0 ? `Culled ${totalCulled} item(s), freed ${formatBytes(totalFreed)}` : 'Within budget';

        if (totalCulled > 0) {
            auditLog('INFO', 'DISK_AUDIT_SUCCESS', `Disk space audit culled ${cacheResult.culled} image(s) and ${archiveResult.culled} archive item(s), freeing ${formatBytes(totalFreed)} total.`);
            updateCounts();
        }
    } catch (err) {
        stats.diskAuditStatus = `Error: ${err.message}`;
        auditLog('ERROR', 'DISK_AUDIT_ERR', `Disk space audit failed: ${err.message}`);
    } finally {
        isDiskAuditing = false;
        updateUI();
    }
}

async function startDiskAuditWorker() {
    vLog('DISK_AUDIT_WORKER', `Disk space budget worker initialized (total ${formatBytes(DISK_BUDGET_TOTAL_BYTES)}: ${formatBytes(DISK_BUDGET_CACHE_BYTES)} cache / ${formatBytes(DISK_BUDGET_ARCHIVE_BYTES)} archive).`);
    while (!shuttingDown) {
        try { await runDiskSpaceAudit(); } catch (e) { vLog('DISK_AUDIT_ERR', `Worker iteration failed: ${e.message}`); }
        await sleep(DISK_AUDIT_INTERVAL_MS);
    }
}

// ============================================================================
// SECTION 9: MAPPING HELPERS (MTGJSON + Scryfall) & BACKUP-DRIVEN REHYDRATION
// ============================================================================
const COLOR_BITS = { W: 1, U: 2, B: 4, R: 8, G: 16 };
function colorsToMask(colorArr) {
    if (!Array.isArray(colorArr)) return 0;
    let mask = 0;
    for (const c of colorArr) { if (COLOR_BITS[c]) mask |= COLOR_BITS[c]; }
    return mask;
}
function parseNumOrNull(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
}

function extractLatestPrice(priceBlock) {
    if (!priceBlock) return 0;
    const dates = Object.keys(priceBlock).sort();
    if (dates.length === 0) return 0;
    return priceBlock[dates[dates.length - 1]] || 0;
}

/**
 * Maps one MTGJSON card record into a row for the shared `cards` table.
 * Only columns MTGJSON can plausibly know about are included in the
 * returned object; the corresponding UPSERT statement (see
 * UPSERT_FROM_MTGJSON_SQL) only touches those columns, using
 * COALESCE(excluded.col, cards.col) so a value already contributed by
 * Scryfall/another source is never clobbered with a null just because this
 * source doesn't know that field.
 */
function mapMtgjsonCardToRow(card, syncId) {
    let priceUsd = 0;
    let priceUsdFoil = 0;
    try {
        const paperPrices = card.prices && card.prices.paper;
        if (paperPrices) {
            if (paperPrices.tcgplayer) {
                priceUsd = extractLatestPrice(paperPrices.tcgplayer.retail && paperPrices.tcgplayer.retail.normal);
                priceUsdFoil = extractLatestPrice(paperPrices.tcgplayer.retail && paperPrices.tcgplayer.retail.foil);
            }
            if (!priceUsd && paperPrices.cardkingdom) {
                priceUsd = extractLatestPrice(paperPrices.cardkingdom.retail && paperPrices.cardkingdom.retail.normal);
            }
        }
    } catch (e) { /* price block malformed — not fatal, just skip pricing for this card */ }

    return {
        scryfall_id: card.identifiers.scryfallId,
        mtgjson_uuid: card.uuid || null,
        name: card.name || null,
        set_code: card.setCode || null,
        set_name: card.setName || null,
        collector_number: card.number || null,
        rarity: card.rarity || null,
        type_line: card.type || null,
        mana_cost: card.manaCost || null,
        cmc: typeof card.manaValue === 'number' ? card.manaValue : (typeof card.convertedManaCost === 'number' ? card.convertedManaCost : null),
        colors: Array.isArray(card.colors) ? card.colors.join(',') : null,
        layout: card.layout || null,
        artist: card.artist || null,
        oracle_text: card.text || null,
        price_usd: priceUsd || null,
        price_usd_foil: priceUsdFoil || null,
        mtgjson_data: safeStringifyBounded(card, MAX_RAW_CARD_BYTES),
        updated_at: Date.now(),
        source_sync_id: syncId,
    };
}

const UPSERT_FROM_MTGJSON_SQL = `
    INSERT INTO cards (scryfall_id, mtgjson_uuid, name, set_code, set_name, collector_number,
        rarity, type_line, mana_cost, cmc, colors, layout, artist, oracle_text,
        price_usd, price_usd_foil, mtgjson_data, updated_at, source_sync_id)
    VALUES (@scryfall_id, @mtgjson_uuid, @name, @set_code, @set_name, @collector_number,
        @rarity, @type_line, @mana_cost, @cmc, @colors, @layout, @artist, @oracle_text,
        @price_usd, @price_usd_foil, @mtgjson_data, @updated_at, @source_sync_id)
    ON CONFLICT(scryfall_id) DO UPDATE SET
        mtgjson_uuid = COALESCE(excluded.mtgjson_uuid, cards.mtgjson_uuid),
        name = COALESCE(excluded.name, cards.name),
        set_code = COALESCE(excluded.set_code, cards.set_code),
        set_name = COALESCE(excluded.set_name, cards.set_name),
        collector_number = COALESCE(excluded.collector_number, cards.collector_number),
        rarity = COALESCE(excluded.rarity, cards.rarity),
        type_line = COALESCE(excluded.type_line, cards.type_line),
        mana_cost = COALESCE(excluded.mana_cost, cards.mana_cost),
        cmc = COALESCE(excluded.cmc, cards.cmc),
        colors = COALESCE(excluded.colors, cards.colors),
        layout = COALESCE(excluded.layout, cards.layout),
        artist = COALESCE(excluded.artist, cards.artist),
        oracle_text = COALESCE(excluded.oracle_text, cards.oracle_text),
        price_usd = COALESCE(excluded.price_usd, cards.price_usd),
        price_usd_foil = COALESCE(excluded.price_usd_foil, cards.price_usd_foil),
        mtgjson_data = excluded.mtgjson_data,
        updated_at = excluded.updated_at,
        source_sync_id = excluded.source_sync_id
`;

/**
 * Maps one raw Scryfall card object (from bulk data OR the single-card API
 * — same shape) into a row covering the FULL comprehensive column set.
 * Scryfall is treated as the most complete single source, so its UPSERT
 * touches nearly every column; COALESCE still protects against a
 * partially-null record (e.g. a transform card missing top-level
 * oracle_text) from wiping out a good value contributed earlier.
 */
function mapScryfallCardToRow(card, syncId) {
    const face0 = Array.isArray(card.card_faces) && card.card_faces.length > 0 ? card.card_faces[0] : null;
    const oracleText = card.oracle_text != null ? card.oracle_text
        : (Array.isArray(card.card_faces) ? card.card_faces.map((f) => f.oracle_text || '').filter(Boolean).join('\n//\n') : null);
    const manaCost = card.mana_cost != null ? card.mana_cost
        : (face0 ? face0.mana_cost : null);
    const power = card.power != null ? card.power : (face0 ? face0.power : null);
    const toughness = card.toughness != null ? card.toughness : (face0 ? face0.toughness : null);
    const loyalty = card.loyalty != null ? card.loyalty : (face0 ? face0.loyalty : null);
    const flavorText = card.flavor_text != null ? card.flavor_text
        : (Array.isArray(card.card_faces) ? card.card_faces.map((f) => f.flavor_text || '').filter(Boolean).join('\n//\n') : null);
    // Art tags (Section 12) join against illustration_id — Scryfall puts
    // this at the top level for single-faced cards, or per-face for DFCs
    // (each face can have its own separate illustration).
    const illustrationId = card.illustration_id || (face0 ? face0.illustration_id : null) || null;

    const prices = card.prices || {};

    return {
        scryfall_id: card.id,
        oracle_id: card.oracle_id || null,
        illustration_id: illustrationId,
        name: card.name || null,
        lang: card.lang || null,
        set_code: card.set || null,
        set_name: card.set_name || null,
        set_type: card.set_type || null,
        collector_number: card.collector_number || null,
        rarity: card.rarity || null,
        type_line: card.type_line || null,
        mana_cost: manaCost || null,
        cmc: typeof card.cmc === 'number' ? card.cmc : null,
        colors: Array.isArray(card.colors) ? card.colors.join(',') : null,
        color_identity: Array.isArray(card.color_identity) ? card.color_identity.join(',') : null,
        color_mask: colorsToMask(card.colors),
        identity_mask: colorsToMask(card.color_identity),
        produced_mana: Array.isArray(card.produced_mana) ? card.produced_mana.join(',') : null,
        produced_mana_mask: Array.isArray(card.produced_mana) ? colorsToMask(card.produced_mana) : null,
        color_indicator: Array.isArray(card.color_indicator) ? card.color_indicator.join(',') : null,
        color_indicator_mask: Array.isArray(card.color_indicator) ? colorsToMask(card.color_indicator) : null,
        keywords: Array.isArray(card.keywords) ? card.keywords.join(',') : null,
        power: power != null ? String(power) : null,
        power_num: parseNumOrNull(power),
        toughness: toughness != null ? String(toughness) : null,
        toughness_num: parseNumOrNull(toughness),
        loyalty: loyalty != null ? String(loyalty) : null,
        loyalty_num: parseNumOrNull(loyalty),
        layout: card.layout || null,
        artist: card.artist || (face0 ? face0.artist : null) || null,
        oracle_text: oracleText || null,
        flavor_text: flavorText || null,
        legalities: card.legalities ? safeStringifyBounded(card.legalities, 4096) : null,
        games: Array.isArray(card.games) ? card.games.join(',') : null,
        reserved: card.reserved ? 1 : 0,
        foil: card.foil ? 1 : 0,
        nonfoil: card.nonfoil ? 1 : 0,
        full_art: card.full_art ? 1 : 0,
        textless: card.textless ? 1 : 0,
        promo: card.promo ? 1 : 0,
        variation: card.variation ? 1 : 0,
        border_color: card.border_color || null,
        frame: card.frame || null,
        released_at: card.released_at || null,
        edhrec_rank: typeof card.edhrec_rank === 'number' ? card.edhrec_rank : null,
        penny_rank: typeof card.penny_rank === 'number' ? card.penny_rank : null,
        watermark: card.watermark || null,
        price_usd: prices.usd ? parseFloat(prices.usd) : null,
        price_usd_foil: prices.usd_foil ? parseFloat(prices.usd_foil) : null,
        price_eur: prices.eur ? parseFloat(prices.eur) : null,
        scryfall_data: safeStringifyBounded(card, MAX_RAW_CARD_BYTES),
        updated_at: Date.now(),
        source_sync_id: syncId,
        scryfall_synced_at: Date.now(),
    };
}

const UPSERT_FROM_SCRYFALL_SQL = `
    INSERT INTO cards (scryfall_id, oracle_id, illustration_id, name, lang, set_code, set_name, set_type, collector_number,
        rarity, type_line, mana_cost, cmc, colors, color_identity, color_mask, identity_mask,
        produced_mana, produced_mana_mask, color_indicator, color_indicator_mask, keywords,
        power, power_num, toughness, toughness_num, loyalty, loyalty_num, layout, artist, oracle_text,
        flavor_text, legalities, games, reserved, foil, nonfoil, full_art, textless, promo, variation,
        border_color, frame, released_at, edhrec_rank, penny_rank, watermark, price_usd, price_usd_foil,
        price_eur, scryfall_data, updated_at, source_sync_id, scryfall_synced_at)
    VALUES (@scryfall_id, @oracle_id, @illustration_id, @name, @lang, @set_code, @set_name, @set_type, @collector_number,
        @rarity, @type_line, @mana_cost, @cmc, @colors, @color_identity, @color_mask, @identity_mask,
        @produced_mana, @produced_mana_mask, @color_indicator, @color_indicator_mask, @keywords,
        @power, @power_num, @toughness, @toughness_num, @loyalty, @loyalty_num, @layout, @artist, @oracle_text,
        @flavor_text, @legalities, @games, @reserved, @foil, @nonfoil, @full_art, @textless, @promo, @variation,
        @border_color, @frame, @released_at, @edhrec_rank, @penny_rank, @watermark, @price_usd, @price_usd_foil,
        @price_eur, @scryfall_data, @updated_at, @source_sync_id, @scryfall_synced_at)
    ON CONFLICT(scryfall_id) DO UPDATE SET
        oracle_id = COALESCE(excluded.oracle_id, cards.oracle_id),
        illustration_id = COALESCE(excluded.illustration_id, cards.illustration_id),
        name = COALESCE(excluded.name, cards.name),
        lang = COALESCE(excluded.lang, cards.lang),
        set_code = COALESCE(excluded.set_code, cards.set_code),
        set_name = COALESCE(excluded.set_name, cards.set_name),
        set_type = COALESCE(excluded.set_type, cards.set_type),
        collector_number = COALESCE(excluded.collector_number, cards.collector_number),
        rarity = COALESCE(excluded.rarity, cards.rarity),
        type_line = COALESCE(excluded.type_line, cards.type_line),
        mana_cost = COALESCE(excluded.mana_cost, cards.mana_cost),
        cmc = COALESCE(excluded.cmc, cards.cmc),
        colors = COALESCE(excluded.colors, cards.colors),
        color_identity = COALESCE(excluded.color_identity, cards.color_identity),
        color_mask = COALESCE(excluded.color_mask, cards.color_mask),
        identity_mask = COALESCE(excluded.identity_mask, cards.identity_mask),
        produced_mana = COALESCE(excluded.produced_mana, cards.produced_mana),
        produced_mana_mask = COALESCE(excluded.produced_mana_mask, cards.produced_mana_mask),
        color_indicator = COALESCE(excluded.color_indicator, cards.color_indicator),
        color_indicator_mask = COALESCE(excluded.color_indicator_mask, cards.color_indicator_mask),
        keywords = COALESCE(excluded.keywords, cards.keywords),
        power = COALESCE(excluded.power, cards.power),
        power_num = COALESCE(excluded.power_num, cards.power_num),
        toughness = COALESCE(excluded.toughness, cards.toughness),
        toughness_num = COALESCE(excluded.toughness_num, cards.toughness_num),
        loyalty = COALESCE(excluded.loyalty, cards.loyalty),
        loyalty_num = COALESCE(excluded.loyalty_num, cards.loyalty_num),
        layout = COALESCE(excluded.layout, cards.layout),
        artist = COALESCE(excluded.artist, cards.artist),
        oracle_text = COALESCE(excluded.oracle_text, cards.oracle_text),
        flavor_text = COALESCE(excluded.flavor_text, cards.flavor_text),
        legalities = COALESCE(excluded.legalities, cards.legalities),
        games = COALESCE(excluded.games, cards.games),
        reserved = COALESCE(excluded.reserved, cards.reserved),
        foil = COALESCE(excluded.foil, cards.foil),
        nonfoil = COALESCE(excluded.nonfoil, cards.nonfoil),
        full_art = COALESCE(excluded.full_art, cards.full_art),
        textless = COALESCE(excluded.textless, cards.textless),
        promo = COALESCE(excluded.promo, cards.promo),
        variation = COALESCE(excluded.variation, cards.variation),
        border_color = COALESCE(excluded.border_color, cards.border_color),
        frame = COALESCE(excluded.frame, cards.frame),
        released_at = COALESCE(excluded.released_at, cards.released_at),
        edhrec_rank = COALESCE(excluded.edhrec_rank, cards.edhrec_rank),
        penny_rank = COALESCE(excluded.penny_rank, cards.penny_rank),
        watermark = COALESCE(excluded.watermark, cards.watermark),
        price_usd = COALESCE(excluded.price_usd, cards.price_usd),
        price_usd_foil = COALESCE(excluded.price_usd_foil, cards.price_usd_foil),
        price_eur = COALESCE(excluded.price_eur, cards.price_eur),
        scryfall_data = excluded.scryfall_data,
        updated_at = excluded.updated_at,
        source_sync_id = excluded.source_sync_id,
        scryfall_synced_at = excluded.scryfall_synced_at
`;

function deriveMetadataTags(card) {
    const tags = new Set();
    try {
        if (Array.isArray(card.keywords)) for (const k of card.keywords) tags.add(`keyword:${String(k).toLowerCase()}`);
        if (card.set_type) tags.add(`settype:${card.set_type}`);
        if (Array.isArray(card.frame_effects)) for (const fe of card.frame_effects) tags.add(`frame:${fe}`);
        if (Array.isArray(card.promo_types)) for (const pt of card.promo_types) tags.add(`promo:${pt}`);
        if (card.border_color) tags.add(`border:${card.border_color}`);
        if (card.full_art) tags.add('full_art');
        if (card.textless) tags.add('textless');
        if (card.reserved) tags.add('reserved');
        if (card.oversized) tags.add('oversized');
        if (card.digital) tags.add('digital');
        if (card.booster === false) tags.add('non_booster');
    } catch (e) { /* tag derivation is a nice-to-have; never fail the ingest over it */ }
    return [...tags];
}

function upsertCardTags(scryfallId, tags, source) {
    if (!tags || tags.length === 0) return;
    try {
        const stmt = db.prepare(`INSERT INTO card_tags (scryfall_id, tag, source) VALUES (?, ?, ?) ON CONFLICT(scryfall_id, tag) DO NOTHING`);
        const tx = db.transaction((list) => { for (const t of list) stmt.run(scryfallId, t, source); });
        tx(tags);
    } catch (e) {
        vLog('TAGS_ERR', `Failed to upsert tags for ${scryfallId}: ${e.message}`);
    }
}

// ----------------------------------------------------------------------------
// Backup-driven rehydration: repopulate missing `cards` rows straight from
// whatever local archives are on disk, with no network required. Used at
// boot when the card table looks suspiciously empty, and as a last-resort
// fallback when every snapshot has failed to restore.
// ----------------------------------------------------------------------------
async function findLatestBackupFile(dir, matchExt) {
    try {
        const dateDirs = (await fs.readdir(dir)).sort().reverse();
        for (const dateDir of dateDirs) {
            const full = path.join(dir, dateDir);
            const stat = await fs.stat(full).catch(() => null);
            if (!stat || !stat.isDirectory()) continue;
            const files = (await fs.readdir(full)).filter((f) => f.endsWith(matchExt));
            if (files.length > 0) return path.join(full, files[0]);
        }
    } catch (e) { /* backup dir may not exist yet */ }
    return null;
}

function patchMissingCardsFromMtgjsonArchive(gzPath) {
    return new Promise((resolve, reject) => {
        const insertStmt = db.prepare(UPSERT_FROM_MTGJSON_SQL);
        const existsStmt = db.prepare('SELECT 1 FROM cards WHERE scryfall_id = ?');
        let batch = [];
        let patched = 0;
        let scanned = 0;
        let errors = 0;

        const processBatch = db.transaction((cards) => {
            for (const c of cards) {
                try { if (!existsStmt.get(c.scryfall_id)) { insertStmt.run(c); patched++; } }
                catch (e) { errors++; }
            }
        });

        const readStream = fsSync.createReadStream(gzPath);
        const gunzip = zlib.createGunzip();
        const parser = JSONStream.parse('data.*.cards.*');
        let settled = false;
        const safeResolve = (v) => { if (!settled) { settled = true; resolve(v); } };
        const safeReject = (e) => { if (!settled) { settled = true; reject(e); } };

        parser.on('data', (card) => {
            // CRITICAL: this exact handler shape (full try/catch around the
            // entire body) is the fix for a previously-documented hang: a
            // malformed record here used to throw synchronously out of a
            // stream callback, silently killing the stream's read loop
            // without ever firing 'error' or 'end', leaving the enclosing
            // Promise pending forever.
            try {
                scanned++;
                if (!card || !card.identifiers || !card.identifiers.scryfallId || !UUID_RE.test(card.identifiers.scryfallId)) return;
                batch.push(mapMtgjsonCardToRow(card, 'backup-patch'));
                if (batch.length >= MTGJSON_BATCH_SIZE) {
                    const toProcess = batch; batch = [];
                    processBatch(toProcess);
                }
            } catch (err) {
                errors++;
                vLog('REHYDRATE_RECORD_ERR', `Skipped one malformed archive record: ${err.message}`);
            }
        });
        parser.on('end', () => {
            try { if (batch.length > 0) processBatch(batch); } catch (e) { return safeReject(e); }
            vLog('REHYDRATE', `MTGJSON archive scan complete: ${scanned} scanned, ${patched} patched, ${errors} skipped-malformed.`);
            safeResolve(patched);
        });
        parser.on('error', (e) => { vLog('REHYDRATE_ERR', `Archive parser error (non-fatal, treated as partial data): ${e.message}`); safeResolve(patched); });
        readStream.on('error', safeReject);
        gunzip.on('error', (e) => { vLog('REHYDRATE_ERR', `Archive decompression error (archive may be truncated): ${e.message}`); safeResolve(patched); });

        readStream.pipe(gunzip).pipe(parser);
    });
}

function patchMissingCardsFromScryfallArchive(gzPath) {
    return new Promise((resolve) => {
        const insertStmt = db.prepare(UPSERT_FROM_SCRYFALL_SQL);
        const existsStmt = db.prepare('SELECT 1 FROM cards WHERE scryfall_id = ?');
        let batch = [];
        let patched = 0;
        let scanned = 0;
        let errors = 0;
        let settled = false;
        const safeResolve = (v) => { if (!settled) { settled = true; resolve(v); } };

        const processBatch = db.transaction((cards) => {
            for (const c of cards) {
                try { if (!existsStmt.get(c.scryfall_id)) { insertStmt.run(c); patched++; } }
                catch (e) { errors++; }
            }
        });

        const readStream = fsSync.createReadStream(gzPath);
        const gunzip = zlib.createGunzip();
        const parser = JSONStream.parse('*');

        parser.on('data', (card) => {
            try {
                scanned++;
                if (!card || !card.id || !UUID_RE.test(card.id)) return;
                batch.push(mapScryfallCardToRow(card, 'backup-patch'));
                if (batch.length >= SCRYFALL_BATCH_SIZE) { const t = batch; batch = []; processBatch(t); }
            } catch (err) {
                errors++;
                vLog('REHYDRATE_RECORD_ERR', `Skipped one malformed Scryfall archive record: ${err.message}`);
            }
        });
        parser.on('end', () => {
            try { if (batch.length > 0) processBatch(batch); } catch (e) { /* keep whatever succeeded */ }
            vLog('REHYDRATE', `Scryfall archive scan complete: ${scanned} scanned, ${patched} patched, ${errors} skipped-malformed.`);
            safeResolve(patched);
        });
        parser.on('error', (e) => { vLog('REHYDRATE_ERR', `Scryfall archive parser error (non-fatal): ${e.message}`); safeResolve(patched); });
        readStream.on('error', () => safeResolve(patched));
        gunzip.on('error', (e) => { vLog('REHYDRATE_ERR', `Scryfall archive decompression error: ${e.message}`); safeResolve(patched); });

        readStream.pipe(gunzip).pipe(parser);
    });
}

async function rehydrateFromBackups() {
    let totalPatched = 0;
    const mtgjsonArchive = await findLatestBackupFile(BACKUP_MTGJSON_DIR, '.json.gz');
    if (mtgjsonArchive) {
        vLog('REHYDRATE', `Rehydrating from local MTGJSON archive: ${path.relative(ROOT_DIR, mtgjsonArchive)}`);
        try {
            const patched = await withTimeout(patchMissingCardsFromMtgjsonArchive(mtgjsonArchive), BOOT_REHYDRATE_TIMEOUT_MS, 'rehydrate-mtgjson');
            totalPatched += patched;
        } catch (e) { vLog('REHYDRATE_ERR', `MTGJSON archive rehydration failed/timed out: ${e.message}`); }
    } else {
        vLog('REHYDRATE', 'No local MTGJSON backup archive found.');
    }

    const scryfallArchive = await findLatestBackupFile(BACKUP_SCRYFALL_DIR, '.json.gz');
    if (scryfallArchive) {
        vLog('REHYDRATE', `Rehydrating from local Scryfall archive: ${path.relative(ROOT_DIR, scryfallArchive)}`);
        try {
            const patched = await withTimeout(patchMissingCardsFromScryfallArchive(scryfallArchive), BOOT_REHYDRATE_TIMEOUT_MS, 'rehydrate-scryfall');
            totalPatched += patched;
        } catch (e) { vLog('REHYDRATE_ERR', `Scryfall archive rehydration failed/timed out: ${e.message}`); }
    } else {
        vLog('REHYDRATE', 'No local Scryfall backup archive found.');
    }

    stats.patchedFromBackup += totalPatched;
    if (totalPatched > 0) auditLog('INFO', 'REHYDRATE_SUCCESS', `Rehydration complete. Patched ${totalPatched} missing card(s) from local backups.`);

    // Last-resort ManaPool recovery: only attempted when the live table
    // looks genuinely empty (not on every boot — the ledger can grow large
    // over months of operation, so this is deliberately not a routine
    // check). This is the one dataset that can never be re-fetched once
    // lost, so if the DB lost it, the ledger is the only way back.
    try {
        const liveSalesCount = db.prepare('SELECT COUNT(*) AS cnt FROM manapool_sales').get().cnt;
        if (liveSalesCount === 0 && fsSync.existsSync(MANAPOOL_LEDGER_PATH)) {
            vLog('REHYDRATE', 'manapool_sales table is empty but a sales ledger exists locally — restoring from it (no network needed)...');
            const ledgerResult = await withTimeout(restoreManapoolFromLedger(), BOOT_REHYDRATE_TIMEOUT_MS, 'rehydrate-manapool-ledger');
            if (ledgerResult.restored > 0) {
                auditLog('INFO', 'LEDGER_RESTORE_SUCCESS', `Restored ${ledgerResult.restored} sale(s) from the permanent ManaPool ledger.`);
            }
        }
    } catch (e) { vLog('REHYDRATE_ERR', `ManaPool ledger restore failed/timed out: ${e.message}`); }

    updateCounts();
    return totalPatched;
}

// ============================================================================
// SECTION 10: MTGJSON SYNC PIPELINE
// ============================================================================
async function computeFileSha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fsSync.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

async function checkMtgJsonSync(force = false) {
    try {
        vLog('STAGE1_MTGJSON', 'Initialize MTGJSON Sync Protocol & SHA256 Verification');
        stats.mtgjsonState = 'Checking SHA'; updateUI();

        const resSha = await fetch(MTGJSON_SHA_API);
        if (!resSha.ok) throw new Error(`HTTP ${resSha.status} fetching remote sha256`);
        const remoteSha = (await resSha.text()).trim().split(/\s+/)[0];
        vLog('MTGJSON_NET', `Remote SHA acquired: ${remoteSha}`);

        const localSha = getSyncState('mtgjson_sha256');
        if (!force && localSha === remoteSha) {
            stats.mtgjsonState = 'Up to Date'; updateUI();
            vLog('MTGJSON', 'Local dataset SHA matches remote. Skipping download — no changes upstream.');
            return;
        }

        vLog('STAGE2_MTGJSON', 'Fetch Master Payload (atomic: temp -> verify -> rename)');
        stats.mtgjsonState = 'Downloading'; updateUI();

        const today = todayStamp();
        const backupDayDir = path.join(BACKUP_MTGJSON_DIR, today);
        const tmpPath = path.join(TMP_DIR, `AllPrintings_${Date.now()}.json`);
        activeDownloads.set('mtgjson', { name: 'MTGJSON Master', percent: 0, bytes: 0, totalBytes: 0, detail: 'Connecting...' });
        updateUI();

        let dlResult;
        try {
            dlResult = await downloadAtomic(MTGJSON_API, tmpPath, {
                timeoutMs: DEFAULT_OP_TIMEOUT_MS,
                onProgress: (downloaded, total) => {
                    const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
                    const detail = total > 0 ? `${formatBytes(downloaded)} / ${formatBytes(total)}` : formatBytes(downloaded);
                    activeDownloads.set('mtgjson', { name: 'MTGJSON Master', percent: pct, bytes: downloaded, totalBytes: total, detail });
                },
            });
        } finally {
            activeDownloads.delete('mtgjson');
        }
        addHistory('MTGJSON Master', formatBytes(dlResult.bytes));
        vLog('MTGJSON_DL_SUCCESS', `Download verified complete (${formatBytes(dlResult.bytes)}). Computed SHA256: ${dlResult.sha256}`);

        if (dlResult.sha256 !== remoteSha) {
            auditLog('ERROR', 'MTGJSON_SHA_MISMATCH', `Downloaded SHA256 (${dlResult.sha256}) does not match published (${remoteSha}). Refusing to ingest a payload we can't verify.`);
            await fs.unlink(tmpPath).catch(() => {});
            stats.mtgjsonState = 'SHA Mismatch (Aborted)'; updateUI();
            return;
        }
        vLog('MTGJSON_VERIFY_OK', 'SHA256 verified against MTGJSON-published hash. Payload is trusted.');

        vLog('STAGE3_MTGJSON', 'Archiving verified payload (gzip) before ingestion');
        await fs.mkdir(backupDayDir, { recursive: true });
        const gzBackupPath = path.join(backupDayDir, 'AllPrintings.json.gz');
        const gzTmpPath = gzBackupPath + '.part';
        try {
            await pipeline(fsSync.createReadStream(tmpPath), zlib.createGzip({ level: 6 }), fsSync.createWriteStream(gzTmpPath));
            await fs.rename(gzTmpPath, gzBackupPath);
        } catch (archiveErr) {
            await fs.unlink(gzTmpPath).catch(() => {});
            vLog('MTGJSON_ARCHIVE_ERR', `Failed to archive payload before ingest (continuing with ingest anyway, but this backup cycle's archive is missing): ${archiveErr.message}`);
        }
        if (fsSync.existsSync(gzBackupPath)) {
            const gzSha = await computeFileSha256(gzBackupPath);
            await fs.writeFile(gzBackupPath + '.sha256', gzSha + '\n');
            vLog('MTGJSON_ARCHIVE', `Backup archived to ${path.relative(ROOT_DIR, gzBackupPath)} (${formatBytes(fsSync.statSync(gzBackupPath).size)}).`);
        }

        vLog('STAGE4_MTGJSON', 'Stream-Parse & DB Batch Ingestion (snapshot-guarded)');
        stats.mtgjsonState = 'Ingesting Data'; updateUI();
        const syncId = `mtgjson_${Date.now()}`;

        await withSnapshotGuard('mtgjson_ingest', () => new Promise((resolve, reject) => {
            const insertStmt = db.prepare(UPSERT_FROM_MTGJSON_SQL);
            let batch = [];
            let processedCount = 0;
            let skipped = 0;
            let recordErrors = 0;
            let settled = false;
            const safeResolve = (v) => { if (!settled) { settled = true; resolve(v); } };
            const safeReject = (e) => { if (!settled) { settled = true; reject(e); } };

            const processBatch = db.transaction((cards) => { for (const c of cards) insertStmt.run(c); });

            vLog('STREAM_INIT', `Opening read stream for verified MTGJSON payload: ${tmpPath}`);
            const stream = fsSync.createReadStream(tmpPath);
            const parserStream = JSONStream.parse('data.*.cards.*');

            parserStream.on('data', (card) => {
                // See Section 9's comment on this exact pattern: NOTHING may
                // throw out of this callback uncaught, ever.
                try {
                    if (!card || !card.identifiers || !card.identifiers.scryfallId || !UUID_RE.test(card.identifiers.scryfallId)) {
                        skipped++;
                        return;
                    }
                    batch.push(mapMtgjsonCardToRow(card, syncId));
                    processedCount++;

                    if (processedCount % 10000 === 0) {
                        const mem = process.memoryUsage();
                        vLog('PARSE_VERBOSE', `[MTGJSON] Parsed card #${processedCount} (${card.name}). Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`);
                    }
                    if (batch.length >= MTGJSON_BATCH_SIZE) {
                        const toProcess = batch; batch = [];
                        pauseFlushResume(stream, () => { processBatch(toProcess); updateCounts(); });
                    }
                } catch (err) {
                    recordErrors++;
                    vLog('MTGJSON_RECORD_ERR', `Skipped one malformed MTGJSON record: ${err.message}`);
                }
            });

            parserStream.on('end', () => {
                try { if (batch.length > 0) processBatch(batch); updateCounts(); } catch (err) { return safeReject(err); }
                vLog('MTGJSON', `Streaming parse complete. Ingested ${processedCount}, skipped ${skipped} (no valid Scryfall UUID), ${recordErrors} malformed.`);
                safeResolve();
            });
            parserStream.on('error', (parseErr) => {
                vLog('MTGJSON_PARSE_ERR', `Stream parse error: ${parseErr.message}`);
                safeReject(parseErr);
            });
            stream.on('error', safeReject);
            stream.pipe(parserStream);
        }));

        await fs.unlink(tmpPath).catch((e) => vLog('MTGJSON_CLEANUP_WARN', `Could not remove temp file: ${e.message}`));

        setSyncState('mtgjson_sha256', remoteSha);
        setSyncState('mtgjson_last_sync', String(Date.now()));
        stats.mtgjsonState = 'Idle (Synced)';
        stats.lastMtgjsonSyncAt = Date.now();
        updateUI();
        auditLog('INFO', 'MTGJSON_SUCCESS', 'MTGJSON sync completed successfully.');
        runSelfAudit().catch((e) => vLog('AUDIT_ERR', e.message));
    } catch (err) {
        activeDownloads.delete('mtgjson');
        stats.mtgjsonState = 'Error (will retry)'; updateUI();
        auditLog('ERROR', 'MTGJSON_ERR', `Sync failure: ${err.message}`);
    }
}

async function startMtgJsonWorker() {
    vLog('MTGJSON_WORKER', 'MTGJSON background worker initialized.');
    // Initial check happens from start(); this loop just keeps it current.
    while (!shuttingDown) {
        await sleep(MTGJSON_SYNC_INTERVAL_MS);
        if (shuttingDown) break;
        try { await checkMtgJsonSync(); } catch (e) { vLog('MTGJSON_ERR', `Periodic sync failed: ${e.message}`); }
    }
}

// ============================================================================
// SECTION 11: MANAPOOL SYNC PIPELINE + IMPORT COMPLETENESS AUDIT
// ============================================================================
const CONDITION_LABELS = { DMG: 'Damaged', HP: 'Heavily Played', MP: 'Moderately Played', LP: 'Lightly Played', NM: 'Near Mint' };
const MANAPOOL_PRICE_FIELDS = [
    { field: 'price_cents_nm', condition: 'NM', foil: 0 },
    { field: 'price_cents_lp_plus', condition: 'LP+', foil: 0 },
    { field: 'price_cents', condition: 'PLD', foil: 0 },
    { field: 'price_cents_nm_foil', condition: 'NM', foil: 1 },
    { field: 'price_cents_lp_plus_foil', condition: 'LP+', foil: 1 },
    { field: 'price_cents_foil', condition: 'PLD', foil: 1 },
    { field: 'price_cents_nm_etched', condition: 'NM (etched)', foil: 1 },
    { field: 'price_cents_lp_plus_etched', condition: 'LP+ (etched)', foil: 1 },
    { field: 'price_cents_etched', condition: 'PLD (etched)', foil: 1 },
];

function dayStartTimestamp(sourceDateStr) {
    const t = Date.parse(`${sourceDateStr}T00:00:00.000Z`);
    return Number.isFinite(t) ? t : Date.now();
}

/**
 * Expands one ManaPool catalog entry (root shape: {"data":[<card>,...]},
 * confirmed via live inspection) into zero or more `manapool_sales` rows.
 * Preferred source is each variant's `recent_sales[]` — genuine historical
 * transactions with real timestamps. When a card has no recorded sales yet
 * (common for low-volume cards), falls back to the flat price_cents ladder
 * as a single dated snapshot so we still capture *something* for every
 * card, every day.
 */
function expandManapoolEntryToRows(scryfallId, entry, sourceDate) {
    const rows = [];
    if (!entry || typeof entry !== 'object') return rows;
    const dayTs = dayStartTimestamp(sourceDate);

    if (Array.isArray(entry.variants) && entry.variants.length > 0) {
        for (const variant of entry.variants) {
            try {
                if (!variant || typeof variant !== 'object') continue;
                const condition = CONDITION_LABELS[variant.condition_id] || variant.condition_id || 'NM';
                const foil = (variant.finish_id === 'FO' || variant.finish_id === 'ET') ? 1 : 0;
                const language = variant.language_id || 'EN';
                if (!Array.isArray(variant.recent_sales) || variant.recent_sales.length === 0) continue;
                // BUGFIX (found via live testing): two genuinely separate
                // sales can legitimately share identical (created_at, price,
                // quantity) — e.g. a single buyer's order producing several
                // line items batched at the same timestamp. Conflict
                // resolution is on the `id` primary key alone (see the
                // manapool_sales schema note), so an `occurrence` counter is
                // folded into the hash to keep such sales as distinct rows
                // instead of one silently swallowing the other as a "dupe".
                // The counter is deterministic for a re-parse of the exact
                // same file (same array order => same occurrence numbers),
                // so re-ingesting the same day's archive still dedupes
                // correctly against itself.
                const occurrenceCounts = new Map();
                for (const sale of variant.recent_sales) {
                    try {
                        if (!sale || typeof sale !== 'object') continue;
                        const cents = Number(sale.price);
                        if (!cents || cents <= 0) continue;
                        const saleDate = Date.parse(sale.created_at);
                        const dateVal = Number.isFinite(saleDate) ? saleDate : dayTs;
                        const quantity = Number(sale.quantity) > 0 ? Number(sale.quantity) : 1;
                        const dedupKey = `${sale.created_at}|${cents}|${quantity}`;
                        const occurrence = occurrenceCounts.get(dedupKey) || 0;
                        occurrenceCounts.set(dedupKey, occurrence + 1);
                        const uniqueString = `${scryfallId}-${variant.product_id || variant.tcgplayer_sku_id || ''}-${sale.created_at}-${cents}-${quantity}-${occurrence}`;
                        rows.push({
                            id: crypto.createHash('md5').update(uniqueString).digest('hex'),
                            scryfall_id: scryfallId,
                            date: dateVal,
                            price: cents / 100,
                            condition,
                            foil,
                            language,
                            quantity,
                            raw_data: safeStringifyBounded({ variant_product_id: variant.product_id, condition_id: variant.condition_id, finish_id: variant.finish_id, language_id: language, sale }, MAX_RAW_ORDER_BYTES),
                            source_date: sourceDate,
                            ingested_at: Date.now(),
                        });
                    } catch (e) { /* one bad sale entry never aborts the rest */ }
                }
            } catch (e) { /* one bad variant never aborts the rest */ }
        }
        if (rows.length > 0) return rows;
    }

    try {
        const baseQty = Number(entry.available_quantity) > 0 ? Number(entry.available_quantity) : 1;
        for (const { field, condition, foil } of MANAPOOL_PRICE_FIELDS) {
            const cents = entry[field];
            if (typeof cents !== 'number' || cents <= 0) continue;
            const uniqueString = `${scryfallId}-${sourceDate}-${field}`;
            rows.push({
                id: crypto.createHash('md5').update(uniqueString).digest('hex'),
                scryfall_id: scryfallId,
                date: dayTs,
                price: cents / 100,
                condition,
                foil,
                language: 'EN',
                quantity: baseQty,
                raw_data: safeStringifyBounded(entry, MAX_RAW_ORDER_BYTES),
                source_date: sourceDate,
                ingested_at: Date.now(),
            });
        }
    } catch (e) { /* non-fatal */ }
    return rows;
}

/** Downloads the ManaPool GZ (real gzip bytes — unlike Scryfall's API,
 * this object is served as opaque binary, so we must decompress it
 * ourselves) atomically, then decompresses it into the final dated archive
 * path, ALSO atomically. Two separate temp->rename hops means a crash at
 * any point in either the download or the decompression can never leave a
 * partial file sitting at a path a later boot would mistake for done. */
async function downloadManapoolArchive(destJsonPath) {
    const rawGzTmp = path.join(TMP_DIR, `manapool_raw_${Date.now()}.json.gz`);
    activeDownloads.set('manapool', { name: 'ManaPool Catalog', percent: 0, bytes: 0, totalBytes: 0, detail: 'Connecting...' });
    updateUI();
    let dl;
    try {
        dl = await downloadAtomic(MANAPOOL_SINGLES_GZ, rawGzTmp, {
            timeoutMs: DEFAULT_OP_TIMEOUT_MS,
            onProgress: (downloaded, total) => {
                const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
                const detail = total > 0 ? `${formatBytes(downloaded)} / ${formatBytes(total)}` : formatBytes(downloaded);
                activeDownloads.set('manapool', { name: 'ManaPool Catalog', percent: pct, bytes: downloaded, totalBytes: total, detail });
            },
        });
    } finally {
        activeDownloads.delete('manapool');
    }

    const destTmp = destJsonPath + '.part';
    try {
        await pipeline(fsSync.createReadStream(rawGzTmp), zlib.createGunzip(), fsSync.createWriteStream(destTmp));
        await fs.rename(destTmp, destJsonPath);
    } finally {
        await fs.unlink(rawGzTmp).catch(() => {});
        await fs.unlink(destTmp).catch(() => {});
    }
    return dl;
}

/** Independent, cheap, count-only pass over an archived singles.json file.
 * Never rejects — always resolves with whatever it managed to count plus a
 * `cleanEnd` flag, so callers can tell "the file is fine, here's its count"
 * apart from "the file is truncated/corrupt, here's how far we got." This
 * is intentionally a SEPARATE code path from the real ingest, so a bug in
 * one can never mask a bug in the other — true independent verification. */
function countManapoolEntries(filePath) {
    return new Promise((resolve) => {
        let count = 0;
        let resolved = false;
        const finish = (cleanEnd, error) => { if (!resolved) { resolved = true; resolve({ count, cleanEnd, error }); } };
        try {
            const stream = fsSync.createReadStream(filePath);
            const parser = JSONStream.parse('data.*');
            parser.on('data', () => { try { count++; } catch (e) { /* noop */ } });
            parser.on('end', () => finish(true, null));
            parser.on('error', (e) => finish(false, e.message));
            stream.on('error', (e) => finish(false, e.message));
            stream.pipe(parser);
        } catch (e) {
            finish(false, e.message);
        }
    });
}

/**
 * Appends newly-inserted sale rows to the permanent JSONL ledger
 * (MANAPOOL_LEDGER_PATH). Fire-and-forget from the ingest pipeline's
 * perspective (never awaited inline with the batch transaction, so a slow
 * disk can't stall ingestion) but each call is itself awaited internally
 * so appends from concurrent batches don't interleave/corrupt each other —
 * see the serialization note on `ledgerWriteChain` below.
 */
let ledgerWriteChain = Promise.resolve();
function appendToManapoolLedger(rows) {
    if (!rows || rows.length === 0) return;
    const lines = rows.map((r) => { try { return JSON.stringify(r); } catch (e) { return null; } }).filter(Boolean).join('\n') + '\n';
    // Chain onto the previous write so concurrent batch flushes (which can
    // legitimately overlap slightly around a pauseFlushResume boundary)
    // never race each other's fs.appendFile calls.
    ledgerWriteChain = ledgerWriteChain
        .then(() => fs.appendFile(MANAPOOL_LEDGER_PATH, lines))
        .catch((e) => vLog('LEDGER_ERR', `Failed to append ${rows.length} row(s) to the ManaPool sales ledger: ${e.message}`));
    return ledgerWriteChain;
}

/**
 * Disaster-recovery path: rebuilds manapool_sales entirely from the
 * ledger, which is the ONE copy of this data that doesn't depend on the
 * SQLite file at all. Safe to run against a partially-populated table —
 * every row uses the same `ON CONFLICT(id) DO NOTHING` as normal ingest,
 * so this is purely additive. Wired into rehydrateFromBackups() as a
 * last-resort source when the live table looks emptier than the ledger.
 */
function restoreManapoolFromLedger() {
    return new Promise((resolve) => {
        if (!fsSync.existsSync(MANAPOOL_LEDGER_PATH)) { resolve({ restored: 0, malformed: 0 }); return; }
        const insertSaleStmt = db.prepare(`
            INSERT INTO manapool_sales (id, scryfall_id, date, price, condition, foil, language, quantity, raw_data, source_date, ingested_at)
            VALUES (@id, @scryfall_id, @date, @price, @condition, @foil, @language, @quantity, @raw_data, @source_date, @ingested_at)
            ON CONFLICT(id) DO NOTHING
        `);
        let batch = [];
        let restored = 0, malformed = 0;
        const processBatch = db.transaction((rows) => { for (const r of rows) { const c = insertSaleStmt.run(r); if (c.changes > 0) restored++; } });

        const rl = readline.createInterface({ input: fsSync.createReadStream(MANAPOOL_LEDGER_PATH), crlfDelay: Infinity });
        rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            try {
                batch.push(JSON.parse(trimmed));
                if (batch.length >= MANAPOOL_BATCH_SIZE) { const b = batch; batch = []; processBatch(b); }
            } catch (e) { malformed++; }
        });
        rl.on('close', () => {
            try { if (batch.length > 0) processBatch(batch); } catch (e) { /* keep whatever succeeded */ }
            vLog('LEDGER', `Restore from ledger complete: ${restored} row(s) restored, ${malformed} malformed line(s) skipped.`);
            resolve({ restored, malformed });
        });
        rl.on('error', () => resolve({ restored, malformed }));
    });
}

function ingestManapoolFile(singlesPath, sourceDate) {
    return withSnapshotGuard('manapool_ingest', () => new Promise((resolve, reject) => {
        const insertSaleStmt = db.prepare(`
            INSERT INTO manapool_sales (id, scryfall_id, date, price, condition, foil, language, quantity, raw_data, source_date, ingested_at)
            VALUES (@id, @scryfall_id, @date, @price, @condition, @foil, @language, @quantity, @raw_data, @source_date, @ingested_at)
            ON CONFLICT(id) DO NOTHING
        `);
        let batch = [];
        let newSalesAdded = 0;
        let dupesSkipped = 0;
        let cardsScanned = 0;
        let recordErrors = 0;
        let settled = false;
        const safeResolve = (v) => { if (!settled) { settled = true; resolve(v); } };
        const safeReject = (e) => { if (!settled) { settled = true; reject(e); } };

        const processBatch = db.transaction((entries) => {
            let added = 0;
            const newlyInserted = [];
            for (const entry of entries) {
                const changes = insertSaleStmt.run(entry);
                if (changes.changes > 0) { added++; newlyInserted.push(entry); } else dupesSkipped++;
            }
            return { added, newlyInserted };
        });

        vLog('STREAM_INIT', `Opening read stream for ManaPool singles catalog: ${singlesPath}`);
        const readStream = fsSync.createReadStream(singlesPath);
        const jsonStream = JSONStream.parse('data.*');
        let confirmedReading = false;

        jsonStream.on('data', (entry) => {
            try {
                cardsScanned++;
                if (!confirmedReading) {
                    confirmedReading = true;
                    vLog('MANAPOOL', 'Catalog stream confirmed readable — beginning import.');
                }
                if (cardsScanned % 5000 === 0) {
                    const mem = process.memoryUsage();
                    vLog('PARSE_VERBOSE', `[MANAPOOL] Scanned ${cardsScanned}. New: ${newSalesAdded}, dupes: ${dupesSkipped}. Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`);
                }
                if (!entry || typeof entry !== 'object') return;
                const rawId = entry.scryfall_id || entry.scryfallId || '';
                const scryfallId = String(rawId).toLowerCase();
                if (!scryfallId || !UUID_RE.test(scryfallId)) return;

                const rows = expandManapoolEntryToRows(scryfallId, entry, sourceDate);
                for (const row of rows) batch.push(row);

                if (batch.length >= MANAPOOL_BATCH_SIZE) {
                    const toProcess = batch; batch = [];
                    // Cooperative yield: pause the stream, run this batch's
                    // transaction, then resume on the next event-loop tick
                    // so the TUI's 1s redraw timer, heartbeat pings, and any
                    // in-flight HTTP requests get a real chance to run
                    // instead of the whole process appearing to freeze for
                    // however long the full file takes to ingest.
                    let flushResult;
                    pauseFlushResume(readStream, () => {
                        flushResult = processBatch(toProcess);
                        newSalesAdded += flushResult.added;
                        updateCounts();
                    });
                    appendToManapoolLedger(flushResult.newlyInserted);
                }
            } catch (err) {
                recordErrors++;
                vLog('MANAPOOL_RECORD_ERR', `Skipped one malformed catalog entry: ${err.message}`);
            }
        });

        jsonStream.on('end', () => {
            try {
                if (batch.length > 0) {
                    const finalResult = processBatch(batch);
                    newSalesAdded += finalResult.added;
                    appendToManapoolLedger(finalResult.newlyInserted);
                }
                updateCounts();
            } catch (err) { return safeReject(err); }
            vLog('MANAPOOL_PARSE', `Ingestion complete. Scanned ${cardsScanned}, added ${newSalesAdded}, dupes ${dupesSkipped}, malformed ${recordErrors}.`);
            safeResolve({ cardsScanned, newSalesAdded, dupesSkipped, recordErrors });
        });
        jsonStream.on('error', (parseErr) => {
            vLog('MANAPOOL_PARSE_ERR', `Stream parse error: ${parseErr.message}`);
            safeReject(parseErr);
        });
        readStream.on('error', safeReject);
        readStream.pipe(jsonStream);
    }));
}

function recordManapoolImportAudit(date, fileEntryCount, ingestResult) {
    try {
        const expectedRowTotal = ingestResult.newSalesAdded + ingestResult.dupesSkipped;
        db.prepare(`
            INSERT INTO import_audit (date, source, file_entry_count, imported_count, skipped_count, expected_row_total, status, checked_at)
            VALUES (?, 'manapool', ?, ?, ?, ?, ?, ?)
            ON CONFLICT(date, source) DO UPDATE SET
                file_entry_count = excluded.file_entry_count,
                imported_count = excluded.imported_count,
                skipped_count = excluded.skipped_count,
                expected_row_total = excluded.expected_row_total,
                status = excluded.status,
                checked_at = excluded.checked_at
        `).run(date, fileEntryCount, ingestResult.cardsScanned, ingestResult.recordErrors, expectedRowTotal,
            ingestResult.cardsScanned >= fileEntryCount ? 'complete' : 'partial', Date.now());
    } catch (e) {
        vLog('AUDIT_ERR', `Failed to record import_audit row: ${e.message}`);
    }
}

/**
 * The direct answer to "audit how many rows we have vs. how many were
 * actually imported, and make sure they match": independently re-counts
 * today's archived file, compares against what the last ingest run
 * recorded, and — critically — also compares the CURRENT live row count in
 * `manapool_sales` against the `expected_row_total` recorded at the time of
 * a successful ingest. If the live count has since dropped (e.g. an
 * unrelated rollback wiped rows written after its snapshot point), that is
 * detected here and triggers an automatic, no-network re-ingest straight
 * from the local archive file. Only if the local archive itself turns out
 * to be corrupt/truncated does this escalate to forcing a fresh download.
 */
/**
 * The direct answer to "audit how many rows we have vs. how many were
 * actually imported, and make sure they match": independently re-counts
 * today's archived file and compares against what the last ingest run for
 * TODAY recorded.
 *
 * BUGFIX (found via live testing): this used to also compare live
 * manapool_sales rows WHERE source_date = today against an expected total,
 * flagging "rows went missing" whenever that came up short. That
 * comparison was simply wrong: ManaPool's recent_sales window overlaps
 * across days, so a sale first recorded yesterday keeps yesterday's
 * source_date forever (ON CONFLICT DO NOTHING never touches it) even
 * though today's file legitimately contains it again — that's dedup
 * working correctly, not data loss, and it triggered a full false-alarm
 * re-ingest on every single audit cycle. Real data loss (e.g. an unrelated
 * rollback wiping rows) is now detected the correct way: total
 * manapool_sales rows should only ever grow or hold steady over time, so a
 * meaningful DROP below the highest total ever recorded is the actual
 * signal, tracked via a simple high-water-mark in sync_state.
 */
async function auditManapoolCompleteness() {
    const today = todayStamp();
    const dir = path.join(BACKUP_MANAPOOL_DIR, today);
    const singlesPath = path.join(dir, 'singles.json');
    if (!fsSync.existsSync(singlesPath)) {
        stats.manapoolIntegrityStatus = 'No archive for today yet';
        return { triggeredReimport: false };
    }

    vLog('AUDIT', `Auditing ManaPool archive completeness for ${today}...`);
    const countResult = await countManapoolEntries(singlesPath);
    stats.manapoolFileEntries = countResult.count;

    if (!countResult.cleanEnd) {
        stats.manapoolIntegrityStatus = `CORRUPT/TRUNCATED (${countResult.error || 'did not end cleanly'})`;
        auditLog('CRITICAL', 'MANAPOOL_AUDIT_CORRUPT', `Local archive for ${today} is corrupt/truncated (${countResult.error}). Deleting; a fresh download will be attempted on the next sync cycle.`);
        try { await fs.unlink(singlesPath); } catch (e) { /* noop */ }
        return { triggeredReimport: true };
    }

    const row = db.prepare('SELECT * FROM import_audit WHERE date = ? AND source = ?').get(today, 'manapool');
    stats.manapoolImportedEntries = row ? row.imported_count : 0;

    const totalLiveRows = db.prepare('SELECT COUNT(*) AS cnt FROM manapool_sales').get().cnt;
    const highWaterMark = parseInt(getSyncState('manapool_total_high_water_mark') || '0', 10);
    if (totalLiveRows > highWaterMark) setSyncState('manapool_total_high_water_mark', String(totalLiveRows));

    // A drop of more than 1% below the highest total ever recorded is real
    // data loss, not normal day-to-day rolling-window churn.
    const droppedBelowHighWaterMark = highWaterMark > 0 && totalLiveRows < highWaterMark * 0.99;

    const neverImported = !row;
    const scanMismatch = row && row.file_entry_count && row.file_entry_count !== countResult.count;

    if (neverImported || scanMismatch || droppedBelowHighWaterMark) {
        const reason = neverImported ? 'no prior import recorded for today'
            : scanMismatch ? `file entry count changed since last check (${row.file_entry_count} -> ${countResult.count})`
            : `total sales rows (${totalLiveRows}) dropped notably below the historical high of ${highWaterMark} — likely lost to an unrelated rollback`;
        auditLog('ERROR', 'MANAPOOL_AUDIT_MISMATCH', `ManaPool data needs re-ingest: ${reason}. Re-ingesting from the existing local archive (no re-download needed).`);
        stats.manapoolIntegrityStatus = `Re-ingesting (${reason})`;
        try {
            const result = await ingestManapoolFile(singlesPath, today);
            recordManapoolImportAudit(today, countResult.count, result);
            stats.manapoolIntegrityStatus = 'OK (re-ingested)';
        } catch (e) {
            stats.manapoolIntegrityStatus = `Re-ingest FAILED: ${e.message}`;
            auditLog('ERROR', 'MANAPOOL_REIMPORT_ERR', `Re-ingest attempt failed: ${e.message}`);
        }
        return { triggeredReimport: true };
    }

    stats.manapoolIntegrityStatus = 'OK';
    return { triggeredReimport: false };
}

async function runManapoolSync(force = false) {
    try {
        const today = todayStamp();
        const mpDir = path.join(BACKUP_MANAPOOL_DIR, today);
        await fs.mkdir(mpDir, { recursive: true });
        const singlesDest = path.join(mpDir, 'singles.json');

        const forceRedownloadFlag = getSyncState('manapool_force_redownload') === today;
        let needDownload = force || forceRedownloadFlag || !fsSync.existsSync(singlesDest);
        if (!needDownload && fsSync.existsSync(singlesDest)) {
            const st = fsSync.statSync(singlesDest);
            if (st.size < 1024 * 1024) needDownload = true; // suspiciously small — treat as incomplete
        }

        if (needDownload) {
            vLog('STAGE1_MANAPOOL', 'Initialize ManaPool GZ Download & Decompression (atomic)');
            stats.manapoolState = 'Downloading'; updateUI();
            const dl = await downloadManapoolArchive(singlesDest);
            addHistory('ManaPool Archive', formatBytes(dl.bytes));
            vLog('MANAPOOL_DL_SUCCESS', `Archived original-format catalog to ${path.relative(ROOT_DIR, singlesDest)} (${formatBytes(fsSync.statSync(singlesDest).size)}).`);
            setSyncState('manapool_force_redownload', '');
        } else {
            vLog('MANAPOOL_CACHE', `Existing archive for ${today} looks present and non-trivial in size; skipping re-download.`);
        }

        vLog('STAGE2_MANAPOOL', 'Stream-Parse & Snapshot-Guarded Sales Ingestion');
        stats.manapoolState = 'Parsing & Ingesting'; updateUI();

        const result = await ingestManapoolFile(singlesDest, today);
        const countResult = await countManapoolEntries(singlesDest);
        recordManapoolImportAudit(today, countResult.count, result);
        stats.manapoolFileEntries = countResult.count;
        stats.manapoolImportedEntries = result.cardsScanned;
        stats.manapoolIntegrityStatus = countResult.cleanEnd && result.cardsScanned >= countResult.count ? 'OK' : 'Needs re-check (will self-heal next audit)';

        setSyncState('manapool_last_date', today);
        setSyncState('manapool_last_sync', String(Date.now()));
        stats.manapoolState = `Idle (+${result.newSalesAdded} today)`;
        stats.lastManapoolSyncAt = Date.now();
        updateUI();
        auditLog('INFO', 'MANAPOOL_SUCCESS', `ManaPool sync complete for ${today}: ${result.cardsScanned} scanned, ${result.newSalesAdded} new, ${result.dupesSkipped} dupes culled, ${result.recordErrors} malformed skipped.`);
        runSelfAudit().catch((e) => vLog('AUDIT_ERR', e.message));
    } catch (err) {
        activeDownloads.delete('manapool');
        stats.manapoolState = 'Error (will retry)'; updateUI();
        auditLog('ERROR', 'MANAPOOL_ERR', `Worker exception: ${err.message}`);
        throw err;
    }
}

async function startManapoolWorker() {
    vLog('MANAPOOL_WORKER', 'ManaPool background worker initialized and entering daily cycle.');
    while (!shuttingDown) {
        try {
            await runManapoolSync(manapoolForceFlag.force);
            manapoolForceFlag.force = false;
            vLog('MANAPOOL_SLEEP', `Sync cycle complete. Sleeping ${MANAPOOL_SYNC_INTERVAL_MS / 3600000}h until next run.`);
            await sleep(MANAPOOL_SYNC_INTERVAL_MS);
        } catch (err) {
            vLog('MANAPOOL_RETRY', `Retrying in 5 minutes after failure: ${err.message}`);
            await sleep(5 * 60 * 1000);
        }
    }
}

// ============================================================================
// SECTION 12: SCRYFALL BULK DATA + RULINGS + TAGGER (oracle_tags/art_tags)
// ============================================================================
// BUGFIX (found via live testing): Scryfall bulk-data listing entries do NOT
// have a `download_uri` field — the real field is `jsonl_download_uri`, and
// critically, every bulk file is GZIP-COMPRESSED NEWLINE-DELIMITED JSON
// (JSONL), not a plain JSON array as originally assumed. `downloadAtomic`
// was calling `fetch(undefined)` (hence "Failed to parse URL from
// undefined") and, had the URL been right, would still have handed a
// JSON-array parser a `.jsonl.gz` file it can't read. Fixed below with a
// dedicated gzip+JSONL streaming helper used by every Scryfall bulk sync.
//
// ALSO FIXED: Tagger tag data does NOT come from an unofficial GraphQL
// endpoint (confirmed to no longer exist / never reliably did) — it is
// published as two OFFICIAL bulk-data types, `oracle_tags` and `art_tags`,
// each a JSONL stream of Tag Objects with a `taggings` array linking the
// tag to cards via `oracle_id` (oracle_tags) or `illustration_id`
// (art_tags). That's what's implemented here now; the old GraphQL-guessing
// code has been removed entirely.
async function getScryfallBulkObjectInfo(type) {
    const res = await fetch(SCRYFALL_BULK_LIST_API);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching bulk-data listing`);
    const json = await res.json();
    const entry = Array.isArray(json.data) ? json.data.find((d) => d.type === type) : null;
    if (!entry) throw new Error(`No bulk-data entry found for type "${type}"`);
    if (!entry.jsonl_download_uri) throw new Error(`Bulk-data entry "${type}" has no jsonl_download_uri`);
    return entry;
}

/**
 * Generic, reusable gzip+JSONL streamer. Every Scryfall bulk file (cards,
 * rulings, oracle_tags, art_tags) is this exact format, so this one
 * function backs all four sync pipelines below. `onObject` is called once
 * per parsed line; a malformed line is counted and skipped (never thrown),
 * and a callback that itself throws is caught and counted separately so one
 * bad record can never abort the whole file — the same "nothing throws out
 * of a stream callback" rule as everywhere else in this file. Truncated
 * gzip (a partial download) resolves instead of hanging, with `truncated:
 * true` so the caller can decide whether to treat it as a real failure.
 */
function streamJsonlGz(gzPath, onObject) {
    return new Promise((resolve, reject) => {
        let processed = 0, malformed = 0, callbackErrors = 0;
        let settled = false;
        const safeResolve = (v) => { if (!settled) { settled = true; resolve(v); } };
        const safeReject = (e) => { if (!settled) { settled = true; reject(e); } };
        let rl;
        try {
            const fileStream = fsSync.createReadStream(gzPath);
            const gunzip = zlib.createGunzip();
            fileStream.on('error', safeReject);
            gunzip.on('error', (e) => {
                vLog('JSONL_ERR', `Decompression error for ${path.basename(gzPath)} (archive may be truncated): ${e.message}`);
                safeResolve({ processed, malformed, callbackErrors, truncated: true });
            });
            rl = readline.createInterface({ input: fileStream.pipe(gunzip), crlfDelay: Infinity });
        } catch (e) { return safeReject(e); }

        rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            let obj;
            try { obj = JSON.parse(trimmed); } catch (e) { malformed++; return; }
            try {
                onObject(obj);
                processed++;
                if (processed % 25000 === 0) {
                    pauseFlushResume(rl, () => {
                        const mem = process.memoryUsage();
                        vLog('PARSE_VERBOSE', `[${path.basename(gzPath)}] Processed ${processed} lines. Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`);
                    });
                }
            } catch (e) {
                callbackErrors++;
                vLog('JSONL_RECORD_ERR', `Record callback failed for ${path.basename(gzPath)}: ${e.message}`);
            }
        });
        rl.on('close', () => safeResolve({ processed, malformed, callbackErrors, truncated: false }));
        rl.on('error', safeReject);
    });
}

/**
 * `default_cards`: one object per unique printing in its primary language —
 * Scryfall's recommended general-purpose file, covering effectively every
 * field the API exposes (colors, legalities, oracle_id for rulings/tags
 * joins, prices, images, the works).
 */
async function runScryfallBulkSync(force = false) {
    try {
        vLog('STAGE1_SCRYFALL', 'Checking Scryfall bulk-data listing (default_cards)');
        stats.scryfallState = 'Checking'; updateUI();
        const info = await retryAsync(() => getScryfallBulkObjectInfo('default_cards'), { label: 'Scryfall bulk-data listing' });
        const localUpdatedAt = getSyncState('scryfall_bulk_updated_at');

        if (!force && localUpdatedAt === info.updated_at) {
            stats.scryfallState = 'Up to Date'; updateUI();
            vLog('SCRYFALL', 'Bulk data unchanged since last sync. Skipping download.');
        } else {
            stats.scryfallState = 'Downloading'; updateUI();
            const today = todayStamp();
            const backupDayDir = path.join(BACKUP_SCRYFALL_DIR, today);
            await fs.mkdir(backupDayDir, { recursive: true });
            const gzPath = path.join(backupDayDir, 'default-cards.jsonl.gz');

            activeDownloads.set('scryfall', { name: 'Scryfall Bulk (default_cards)', percent: 0, bytes: 0, totalBytes: 0, detail: 'Connecting...' });
            let dl;
            try {
                dl = await retryAsync(() => downloadAtomic(info.jsonl_download_uri, gzPath, {
                    timeoutMs: DEFAULT_OP_TIMEOUT_MS,
                    onProgress: (downloaded, total) => {
                        const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
                        const detail = total > 0 ? `${formatBytes(downloaded)} / ${formatBytes(total)}` : formatBytes(downloaded);
                        activeDownloads.set('scryfall', { name: 'Scryfall Bulk (default_cards)', percent: pct, bytes: downloaded, totalBytes: total, detail });
                    },
                }), { label: 'Scryfall default_cards download' });
            } finally { activeDownloads.delete('scryfall'); }
            addHistory('Scryfall Bulk', formatBytes(dl.bytes));
            vLog('SCRYFALL_DL_SUCCESS', `Downloaded and verified ${formatBytes(dl.bytes)} -> ${path.relative(ROOT_DIR, gzPath)}.`);
            const sha = await computeFileSha256(gzPath);
            await fs.writeFile(gzPath + '.sha256', sha + '\n');

            stats.scryfallState = 'Ingesting'; updateUI();
            const syncId = `scryfall_${Date.now()}`;
            await withSnapshotGuard('scryfall_bulk_ingest', async () => {
                const insertStmt = db.prepare(UPSERT_FROM_SCRYFALL_SQL);
                let batch = [];
                let skipped = 0;
                const processBatch = db.transaction((entries) => {
                    for (const c of entries) {
                        insertStmt.run(c.row);
                        if (c.tags.length > 0) upsertCardTags(c.row.scryfall_id, c.tags, 'metadata');
                    }
                });
                const result = await streamJsonlGz(gzPath, (card) => {
                    if (!card || !card.id || !UUID_RE.test(card.id)) { skipped++; return; }
                    const row = mapScryfallCardToRow(card, syncId);
                    const tags = deriveMetadataTags(card);
                    batch.push({ row, tags });
                    if (batch.length >= SCRYFALL_BATCH_SIZE) { const t = batch; batch = []; processBatch(t); updateCounts(); }
                });
                if (batch.length > 0) { processBatch(batch); updateCounts(); }
                vLog('SCRYFALL', `Bulk ingest complete. Processed ${result.processed}, skipped ${skipped}, malformed lines ${result.malformed}, record errors ${result.callbackErrors}.`);
            });

            setSyncState('scryfall_bulk_updated_at', info.updated_at);
            setSyncState('scryfall_bulk_last_sync', String(Date.now()));
            stats.scryfallState = 'Idle (Synced)';
            stats.lastScryfallSyncAt = Date.now();
            updateUI();
            auditLog('INFO', 'SCRYFALL_SUCCESS', 'Scryfall bulk sync completed successfully.');
        }

        await runRulingsBulkSync(force);
        await runOracleTagsSync(force);
        await runArtTagsSync(force);
        runSelfAudit().catch((e) => vLog('AUDIT_ERR', e.message));
    } catch (err) {
        activeDownloads.delete('scryfall');
        stats.scryfallState = 'Error (will retry)'; updateUI();
        auditLog('ERROR', 'SCRYFALL_ERR', `Bulk sync failure: ${err.message}`);
    }
}

async function runRulingsBulkSync(force = false) {
    try {
        stats.rulingsState = 'Checking'; updateUI();
        const info = await retryAsync(() => getScryfallBulkObjectInfo('rulings'), { label: 'rulings listing' });
        const localUpdatedAt = getSyncState('scryfall_rulings_updated_at');
        if (!force && localUpdatedAt === info.updated_at) { stats.rulingsState = 'Up to Date'; updateUI(); return; }

        stats.rulingsState = 'Downloading'; updateUI();
        const today = todayStamp();
        const backupDayDir = path.join(BACKUP_SCRYFALL_DIR, today);
        await fs.mkdir(backupDayDir, { recursive: true });
        const gzPath = path.join(backupDayDir, 'rulings.jsonl.gz');
        activeDownloads.set('rulings', { name: 'Scryfall Rulings', percent: 0, bytes: 0, totalBytes: 0, detail: 'Connecting...' });
        let dl;
        try {
            dl = await retryAsync(() => downloadAtomic(info.jsonl_download_uri, gzPath, {
                timeoutMs: DEFAULT_OP_TIMEOUT_MS,
                onProgress: (downloaded, total) => {
                    const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
                    const detail = total > 0 ? `${formatBytes(downloaded)} / ${formatBytes(total)}` : formatBytes(downloaded);
                    activeDownloads.set('rulings', { name: 'Scryfall Rulings', percent: pct, bytes: downloaded, totalBytes: total, detail });
                },
            }), { label: 'rulings download' });
        } finally { activeDownloads.delete('rulings'); }
        addHistory('Scryfall Rulings', formatBytes(dl.bytes));

        stats.rulingsState = 'Ingesting'; updateUI();
        await withSnapshotGuard('rulings_ingest', async () => {
            const insertStmt = db.prepare(`
                INSERT INTO rulings (id, oracle_id, scryfall_id, published_at, source, comment)
                VALUES (@id, @oracle_id, @scryfall_id, @published_at, @source, @comment)
                ON CONFLICT(id) DO NOTHING
            `);
            let batch = [];
            const processBatch = db.transaction((rows) => { for (const r of rows) insertStmt.run(r); });
            const result = await streamJsonlGz(gzPath, (ruling) => {
                if (!ruling || !ruling.oracle_id) return;
                const commentStr = typeof ruling.comment === 'string' ? ruling.comment.substring(0, 4000) : '';
                const idSrc = `${ruling.oracle_id}-${ruling.published_at}-${commentStr}`;
                batch.push({
                    id: crypto.createHash('md5').update(idSrc).digest('hex'),
                    oracle_id: ruling.oracle_id, scryfall_id: null,
                    published_at: ruling.published_at || null, source: ruling.source || null,
                    comment: commentStr || null,
                });
                if (batch.length >= SCRYFALL_BATCH_SIZE) { const t = batch; batch = []; processBatch(t); }
            });
            if (batch.length > 0) processBatch(batch);
            vLog('RULINGS', `Ingest complete. Processed ${result.processed}, malformed ${result.malformed}.`);
        });

        setSyncState('scryfall_rulings_updated_at', info.updated_at);
        stats.rulingsState = 'Idle (Synced)';
        updateUI();
        auditLog('INFO', 'RULINGS_SUCCESS', 'Rulings bulk sync completed.');
    } catch (err) {
        activeDownloads.delete('rulings');
        stats.rulingsState = 'Error (will retry)'; updateUI();
        auditLog('ERROR', 'RULINGS_ERR', `Rulings sync failure: ${err.message}`);
    }
}

/**
 * REAL Tagger data (confirmed official bulk types `oracle_tags`/`art_tags`
 * — see Section 15 for how `tag:`/`otag:`/`art:` search syntax joins
 * against these tables at query time). Each sync fully replaces the
 * corresponding table since the bulk file is itself a complete snapshot,
 * not a delta.
 */
async function runOracleTagsSync(force = false) {
    try {
        stats.tagsState = 'Checking'; updateUI();
        const info = await retryAsync(() => getScryfallBulkObjectInfo('oracle_tags'), { label: 'oracle_tags listing' });
        const localUpdatedAt = getSyncState('scryfall_oracle_tags_updated_at');
        if (!force && localUpdatedAt === info.updated_at) { stats.tagsState = 'Up to Date'; updateUI(); return; }

        stats.tagsState = 'Downloading'; updateUI();
        const today = todayStamp();
        const dir = path.join(BACKUP_SCRYFALL_DIR, today);
        await fs.mkdir(dir, { recursive: true });
        const gzPath = path.join(dir, 'oracle-tags.jsonl.gz');
        activeDownloads.set('oracle_tags', { name: 'Scryfall Oracle Tags', percent: 0, bytes: 0, totalBytes: 0, detail: 'Connecting...' });
        let dl;
        try {
            dl = await retryAsync(() => downloadAtomic(info.jsonl_download_uri, gzPath, {
                timeoutMs: DEFAULT_OP_TIMEOUT_MS,
                onProgress: (d, t) => { activeDownloads.set('oracle_tags', { name: 'Scryfall Oracle Tags', percent: t > 0 ? Math.round((d / t) * 100) : 0, bytes: d, totalBytes: t, detail: formatBytes(d) }); },
            }), { label: 'oracle_tags download' });
        } finally { activeDownloads.delete('oracle_tags'); }
        addHistory('Scryfall Oracle Tags', formatBytes(dl.bytes));

        stats.tagsState = 'Ingesting'; updateUI();
        await withSnapshotGuard('oracle_tags_ingest', async () => {
            db.exec('DELETE FROM oracle_tags');
            const insertStmt = db.prepare('INSERT INTO oracle_tags (tag_id, slug, label, oracle_id) VALUES (?, ?, ?, ?) ON CONFLICT(tag_id, oracle_id) DO NOTHING');
            let batch = [];
            const processBatch = db.transaction((rows) => { for (const r of rows) insertStmt.run(r.tag_id, r.slug, r.label, r.oracle_id); });
            const result = await streamJsonlGz(gzPath, (tagObj) => {
                if (!tagObj || !Array.isArray(tagObj.taggings)) return;
                for (const t of tagObj.taggings) {
                    if (!t || !t.oracle_id) continue;
                    batch.push({ tag_id: tagObj.id, slug: tagObj.slug, label: tagObj.label, oracle_id: t.oracle_id });
                    if (batch.length >= 5000) { const b = batch; batch = []; processBatch(b); }
                }
            });
            if (batch.length > 0) processBatch(batch);
            vLog('TAGS', `Oracle tags ingest complete. ${result.processed} tag objects processed, ${result.malformed} malformed lines.`);
        });
        setSyncState('scryfall_oracle_tags_updated_at', info.updated_at);
        stats.tagsState = 'Idle (Synced)';
        updateUI();
        auditLog('INFO', 'ORACLE_TAGS_SUCCESS', 'Oracle tags sync completed.');
    } catch (err) {
        activeDownloads.delete('oracle_tags');
        stats.tagsState = 'Error (will retry)'; updateUI();
        auditLog('ERROR', 'ORACLE_TAGS_ERR', `Oracle tags sync failure: ${err.message}`);
    }
}

async function runArtTagsSync(force = false) {
    try {
        const info = await retryAsync(() => getScryfallBulkObjectInfo('art_tags'), { label: 'art_tags listing' });
        const localUpdatedAt = getSyncState('scryfall_art_tags_updated_at');
        if (!force && localUpdatedAt === info.updated_at) return;

        const today = todayStamp();
        const dir = path.join(BACKUP_SCRYFALL_DIR, today);
        await fs.mkdir(dir, { recursive: true });
        const gzPath = path.join(dir, 'art-tags.jsonl.gz');
        activeDownloads.set('art_tags', { name: 'Scryfall Art Tags', percent: 0, bytes: 0, totalBytes: 0, detail: 'Connecting...' });
        let dl;
        try {
            dl = await retryAsync(() => downloadAtomic(info.jsonl_download_uri, gzPath, {
                timeoutMs: DEFAULT_OP_TIMEOUT_MS,
                onProgress: (d, t) => { activeDownloads.set('art_tags', { name: 'Scryfall Art Tags', percent: t > 0 ? Math.round((d / t) * 100) : 0, bytes: d, totalBytes: t, detail: formatBytes(d) }); },
            }), { label: 'art_tags download' });
        } finally { activeDownloads.delete('art_tags'); }
        addHistory('Scryfall Art Tags', formatBytes(dl.bytes));

        await withSnapshotGuard('art_tags_ingest', async () => {
            db.exec('DELETE FROM illustration_tags');
            const insertStmt = db.prepare('INSERT INTO illustration_tags (tag_id, slug, label, illustration_id) VALUES (?, ?, ?, ?) ON CONFLICT(tag_id, illustration_id) DO NOTHING');
            let batch = [];
            const processBatch = db.transaction((rows) => { for (const r of rows) insertStmt.run(r.tag_id, r.slug, r.label, r.illustration_id); });
            const result = await streamJsonlGz(gzPath, (tagObj) => {
                if (!tagObj || !Array.isArray(tagObj.taggings)) return;
                for (const t of tagObj.taggings) {
                    if (!t || !t.illustration_id) continue;
                    batch.push({ tag_id: tagObj.id, slug: tagObj.slug, label: tagObj.label, illustration_id: t.illustration_id });
                    if (batch.length >= 5000) { const b = batch; batch = []; processBatch(b); }
                }
            });
            if (batch.length > 0) processBatch(batch);
            vLog('TAGS', `Art tags ingest complete. ${result.processed} tag objects processed, ${result.malformed} malformed lines.`);
        });
        setSyncState('scryfall_art_tags_updated_at', info.updated_at);
        auditLog('INFO', 'ART_TAGS_SUCCESS', 'Art tags sync completed.');
    } catch (err) {
        activeDownloads.delete('art_tags');
        auditLog('ERROR', 'ART_TAGS_ERR', `Art tags sync failure: ${err.message}`);
    }
}

async function startScryfallWorker() {
    vLog('SCRYFALL_WORKER', 'Scryfall bulk-data background worker initialized.');
    while (!shuttingDown) {
        await sleep(SCRYFALL_SYNC_INTERVAL_MS);
        if (shuttingDown) break;
        try { await runScryfallBulkSync(); } catch (e) { vLog('SCRYFALL_ERR', `Periodic sync failed: ${e.message}`); }
    }
}

// ============================================================================
// SECTION 13: LAZY SCRYFALL ENRICHMENT + PERMANENT LOW-RATE TRICKLE WORKER
// ============================================================================
let activeScryfallApiCalls = 0;
const scryfallApiQueue = [];
let lastScryfallApiCallAt = 0;
async function acquireScryfallApiSlot() {
    return new Promise((resolve) => {
        const tryAcquire = async () => {
            const wait = Math.max(0, SCRYFALL_API_MIN_INTERVAL_MS - (Date.now() - lastScryfallApiCallAt));
            if (wait > 0) await sleep(wait);
            if (activeScryfallApiCalls < SCRYFALL_API_MAX_CONCURRENT) {
                activeScryfallApiCalls++;
                lastScryfallApiCallAt = Date.now();
                resolve(() => { activeScryfallApiCalls--; const next = scryfallApiQueue.shift(); if (next) next(); });
            } else {
                scryfallApiQueue.push(tryAcquire);
            }
        };
        tryAcquire();
    });
}

async function fetchSingleCardFromScryfall(scryfallId) {
    const release = await acquireScryfallApiSlot();
    try {
        const url = `${SCRYFALL_CARD_API}/${scryfallId}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        let res;
        try {
            res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'MTGOracleDaemon/4.0 (self-hosted)', 'Accept': 'application/json' } });
        } finally { clearTimeout(timeout); }

        if (res.status === 429) {
            const retryAfter = parseInt(res.headers.get('retry-after') || '2', 10);
            await sleep(Math.min(30000, Math.max(1000, retryAfter * 1000)));
            throw new Error('Rate limited by Scryfall (429) — will retry on a later trickle cycle');
        }
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching card ${scryfallId}`);
        return await res.json();
    } finally {
        release();
    }
}

async function enrichCardById(scryfallId) {
    try {
        const card = await fetchSingleCardFromScryfall(scryfallId);
        if (!card) {
            // Genuinely doesn't exist on Scryfall (rare — e.g. some
            // MTGJSON-only entries). Mark as "checked" with a sentinel so
            // the trickle worker doesn't retry it forever.
            await withWriteLock(async () => {
                try { db.prepare('UPDATE cards SET scryfall_synced_at = ? WHERE scryfall_id = ?').run(-1, scryfallId); }
                catch (e) { vLog('ENRICH_ERR', `Failed to mark ${scryfallId} as checked-absent: ${e.message}`); }
            });
            return false;
        }
        const row = mapScryfallCardToRow(card, 'enrichment');
        const tags = deriveMetadataTags(card);
        await withWriteLock(async () => {
            db.prepare(UPSERT_FROM_SCRYFALL_SQL).run(row);
            if (tags.length > 0) upsertCardTags(row.scryfall_id, tags, 'metadata');
        });
        stats.cardsEnrichedThisSession++;
        updateCounts();
        return true;
    } catch (err) {
        vLog('ENRICH_ERR', `Failed to enrich ${scryfallId}: ${err.message}`);
        return false;
    }
}

async function runEnrichmentTrickleWorker() {
    vLog('ENRICH_WORKER', `Scryfall enrichment trickle worker initialized (permanent, low-rate background job; ~1 card / ${ENRICHMENT_TRICKLE_INTERVAL_MS}ms when there's a backlog).`);
    let idleCycles = 0;
    while (!shuttingDown) {
        try {
            if (!db) { await sleep(5000); continue; }
            if (enrichmentForceFlag.force) {
                enrichmentForceFlag.force = false;
            } else {
                await sleep(ENRICHMENT_TRICKLE_INTERVAL_MS);
            }
            if (shuttingDown) break;

            let candidate = null;
            try { candidate = db.prepare('SELECT scryfall_id FROM cards WHERE scryfall_synced_at IS NULL LIMIT 1').get(); }
            catch (e) { vLog('ENRICH_WORKER_ERR', `Could not query for enrichment candidates: ${e.message}`); }

            if (!candidate) {
                idleCycles++;
                stats.enrichmentState = 'Fully caught up';
                await sleep(Math.min(5 * 60 * 1000, 10000 * idleCycles));
                continue;
            }
            idleCycles = 0;
            stats.enrichmentState = `Enriching ${candidate.scryfall_id.substring(0, 8)}...`;
            updateUI();
            await enrichCardById(candidate.scryfall_id);
        } catch (err) {
            vLog('ENRICH_WORKER_ERR', `Trickle worker iteration failed (continuing indefinitely): ${err.message}`);
            await sleep(5000);
        }
    }
}

/** Queues a card for priority enrichment the next time the trickle worker
 * wakes (used opportunistically on cache-miss image requests) by simply
 * ensuring its scryfall_synced_at is NULL if we don't yet have real
 * Scryfall data for it — the trickle worker will pick it up on its very
 * next tick since it always queries for the oldest/any NULL row. */
function queueForEnrichmentIfMissing(scryfallId) {
    if (!db) return;
    try {
        const row = db.prepare('SELECT scryfall_synced_at FROM cards WHERE scryfall_id = ?').get(scryfallId);
        if (row && row.scryfall_synced_at == null) {
            enrichmentForceFlag.force = true; // nudge the trickle worker to wake immediately
        }
    } catch (e) { /* non-critical */ }
}

// ============================================================================
// SECTION 14: IMAGE CACHE PROXY (rate-limited, integrity-checked, atomic)
// ============================================================================
let activeImageFetches = 0;
const urgentImageQueue = [];
const backgroundImageQueue = [];
let lastImageFetchAt = 0;

/**
 * Two-tier priority queue for outbound Scryfall image fetches. On-demand
 * requests (someone is actually looking at this image right now) always go
 * in `urgentImageQueue` and are drained completely before a single
 * `backgroundImageQueue` (opportunistic preloading of other sizes/faces)
 * item gets a slot. This is the mechanism behind "always serve immediate
 * cache requests first" — background preloading can never make a live
 * request wait longer than the concurrency limit already implies.
 */
async function acquireImageSlot(priority = 'urgent') {
    return new Promise((resolve) => {
        const tryAcquire = async () => {
            const wait = Math.max(0, IMG_MIN_INTERVAL_MS - (Date.now() - lastImageFetchAt));
            if (wait > 0) await sleep(wait);
            if (activeImageFetches < IMG_MAX_CONCURRENT_FETCHES) {
                activeImageFetches++;
                lastImageFetchAt = Date.now();
                resolve(() => {
                    activeImageFetches--;
                    const next = urgentImageQueue.shift() || backgroundImageQueue.shift();
                    if (next) next();
                });
            } else {
                (priority === 'background' ? backgroundImageQueue : urgentImageQueue).push(tryAcquire);
            }
        };
        tryAcquire();
    });
}

const IMAGE_TYPES = ['small', 'normal', 'large', 'png', 'art_crop', 'border_crop'];
const DFC_LAYOUTS = new Set(['transform', 'modal_dfc', 'double_faced_token', 'reversible_card']);
function isDoubleFacedLayout(layout) { return DFC_LAYOUTS.has(layout); }

/**
 * Single shared "generic card back" asset, served for the `face=back`
 * request on any card whose layout isn't genuinely double-faced — a
 * non-double-faced card's "back" is always the same generic image by
 * definition, so there's never a per-card network fetch for this.
 *
 * Two layers, tried in order by genericCardBackAssetPath():
 *  1. GENERIC_CARD_BACK_PHOTO_PATH — a REAL photo of the standard Magic
 *     card back, downloaded once (see ensureGenericCardBackPhoto()) from
 *     one of a short list of known-good direct image URLs. This is the one
 *     actually used in normal operation.
 *  2. GENERIC_CARD_BACK_SVG_PATH — a hand-drawn placeholder, generated
 *     locally with no network dependency at all. Pure last-resort fallback
 *     for the (rare, and self-healing on next boot) case where none of the
 *     photo URLs could be reached.
 *
 * CORRECTION (read this if touching this code again): an earlier version
 * of this tried to build a URL from a card's `card_back_id`
 * (0aeebaf5-8c7d-4636-9e82-8c27447861f7) using the same
 * SCRYFALL_IMG_BASE/type/face/d1/d2/id.jpg path used for real card images.
 * That does NOT work — card_back_id identifies the *design*, not a
 * fetchable image on Scryfall's per-card image CDN, so every request 404'd
 * and it silently fell back to the SVG forever. GENERIC_CARD_BACK_PHOTO_URLS
 * below lists actual direct image URLs instead (Scryfall's own documented
 * "no back face" fallback asset, then a known real photo mirror as backup),
 * tried in order until one downloads successfully.
 */
const GENERIC_CARD_BACK_PHOTO_URLS = [
    ...(process.env.MTG_CARD_BACK_PHOTO_URL ? [process.env.MTG_CARD_BACK_PHOTO_URL] : []), // manual override — set this env var to a known-working direct image URL if the defaults below ever stop working
    'https://cards.scryfall.io/back.png', // Scryfall's own documented fallback asset for cards with no back face (what their client libraries return for getBackImage() on a single-faced card)
    'https://gamepedia.cursecdn.com/mtgsalvation_gamepedia/f/f8/Magic_card_back.jpg', // known-good mirror of the same art, used as backup in case the above ever moves/404s
];
const GENERIC_CARD_BACK_SVG_PATH = path.join(IMG_CACHE_DIR, '_generic_card_back.svg');
const GENERIC_CARD_BACK_PHOTO_PATH = path.join(IMG_CACHE_DIR, '_generic_card_back_photo.jpg');
let genericCardBackPhotoReady = false;

function ensureGenericCardBack() {
    if (fsSync.existsSync(GENERIC_CARD_BACK_SVG_PATH)) return;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680" viewBox="0 0 488 680">
        <rect width="488" height="680" rx="24" fill="#1a1a2e"/>
        <rect x="14" y="14" width="460" height="652" rx="18" fill="#0f0f1a" stroke="#c9a86a" stroke-width="4"/>
        <circle cx="244" cy="340" r="150" fill="none" stroke="#c9a86a" stroke-width="6"/>
        <circle cx="244" cy="340" r="110" fill="none" stroke="#c9a86a" stroke-width="3"/>
        <text x="244" y="354" font-family="Georgia, serif" font-size="44" fill="#c9a86a" text-anchor="middle" font-weight="bold">MTG</text>
        <text x="244" y="640" font-family="Georgia, serif" font-size="15" fill="#6a6a7a" text-anchor="middle">No back face — single-faced card</text>
    </svg>`;
    try { fsSync.writeFileSync(GENERIC_CARD_BACK_SVG_PATH, svg); } catch (e) { vLog('CACHE_ERR', `Failed to write generic card back SVG fallback: ${e.message}`); }
}

/**
 * Downloads the real generic card-back photo exactly once and caches it to
 * disk. Tries each URL in GENERIC_CARD_BACK_PHOTO_URLS in turn (one fetch
 * attempt each, short timeout) rather than betting everything on a single
 * URL — direct image links like these do occasionally move, and this way a
 * single dead link doesn't strand every single-faced card on the SVG
 * fallback. Safe to call repeatedly: short-circuits instantly once the file
 * exists. NEVER awaited by boot (see start(), which fires this and moves
 * on) — strictly best-effort, and failure just means the SVG fallback
 * keeps being served until the next boot retries.
 */
async function ensureGenericCardBackPhoto() {
    if (fsSync.existsSync(GENERIC_CARD_BACK_PHOTO_PATH) && fsSync.statSync(GENERIC_CARD_BACK_PHOTO_PATH).size > 0) {
        genericCardBackPhotoReady = true;
        return true;
    }
    const errors = [];
    for (const url of GENERIC_CARD_BACK_PHOTO_URLS) {
        const tmpFile = GENERIC_CARD_BACK_PHOTO_PATH + '.part';
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 20000);
            let res;
            try {
                res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'MTG-Oracle-Daemon/4.0' } });
            } finally {
                clearTimeout(timeout);
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await pipeline(Readable.fromWeb(res.body), fsSync.createWriteStream(tmpFile));
            const stat = await fs.stat(tmpFile);
            if (stat.size === 0) throw new Error('downloaded file was empty');
            await fs.rename(tmpFile, GENERIC_CARD_BACK_PHOTO_PATH);
            genericCardBackPhotoReady = true;
            vLog('CACHE', `Generic card back photo cached from ${url} — single-faced cards will now show the real card back on flip instead of the SVG placeholder.`);
            return true;
        } catch (e) {
            await fs.unlink(tmpFile).catch(() => {}); // never leave a stray .part file behind, whichever step failed
            errors.push(`${url} (${e.message})`);
        }
    }
    genericCardBackPhotoReady = false;
    vLog('CACHE_ERR', `Could not download the real generic card back photo from any candidate URL — ${errors.join('; ')}. Falling back to the SVG placeholder for now — will retry on next boot.`);
    return false;
}

/** Whichever generic back asset is actually available right now — real photo if it downloaded, SVG otherwise. Callers should call ensureGenericCardBack() first so the SVG fallback is guaranteed to exist. */
function genericCardBackAssetPath() {
    return genericCardBackPhotoReady ? GENERIC_CARD_BACK_PHOTO_PATH : GENERIC_CARD_BACK_SVG_PATH;
}

/**
 * Records a real "someone actually looked at this" event for one cached
 * image, driving usage-weighted eviction (see runImageCacheBudgetAudit).
 * Deliberately called ONLY from the code path that serves an image to a
 * live request — never from background preloading (queueImagePreload),
 * since a speculatively-preloaded-but-never-viewed image should stay at
 * hit_count 0 and be first in line for culling, not get artificially
 * boosted just because the daemon fetched it opportunistically. Fire-and-
 * forget from callers (never awaited) so a counter update can never add
 * latency to an image response.
 */
async function recordImageHit(scryfallId, type, face) {
    if (!db) return;
    try {
        await withWriteLock(async () => {
            db.prepare(`
                UPDATE image_cache SET hit_count = hit_count + 1, last_hit_at = ?
                WHERE scryfall_id = ? AND type = ? AND face = ?
            `).run(Date.now(), scryfallId, type, face);
        });
    } catch (e) {
        vLog('CACHE_ERR', `Failed to record image hit for ${scryfallId}/${type}/${face}: ${e.message}`);
    }
}

async function fetchAndCacheImage(id, type, face = 'front', priority = 'urgent') {
    const relPath = `${id}_${type}_${face}.jpg`;
    const fullPath = path.join(IMG_CACHE_DIR, relPath);
    const dlKey = `img_${id}_${type}_${face}`;
    const release = await acquireImageSlot(priority);

    try {
        const dir1 = id.charAt(0);
        const dir2 = id.charAt(1);
        const url = `${SCRYFALL_IMG_BASE}/${type}/${face}/${dir1}/${dir2}/${id}.jpg`;

        activeDownloads.set(dlKey, { name: `Img: ${id.substring(0, 8)} (${type}/${face})`, percent: 0, bytes: 0, totalBytes: 0, detail: 'Connecting...' });
        updateUI();

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        let imgRes;
        try {
            imgRes = await fetch(url, { signal: controller.signal });
        } finally {
            clearTimeout(timeout);
        }

        if (!imgRes.ok) {
            activeDownloads.delete(dlKey); updateUI();
            // A missing 'back' face is completely normal for single-faced
            // cards being opportunistically preloaded — only log loudly for
            // urgent (actually-requested) misses.
            if (priority === 'urgent') vLog('CACHE_ERR', `Scryfall returned HTTP ${imgRes.status} for ${url}`);
            return { ok: false, status: imgRes.status === 404 ? 404 : 502 };
        }

        const totalHeader = imgRes.headers.get('content-length');
        const totalBytes = totalHeader ? parseInt(totalHeader, 10) : 0;
        let downloadedBytes = 0;
        const hash = crypto.createHash('sha256');

        const progressTee = new PassThrough();
        progressTee.on('data', (chunk) => {
            hash.update(chunk);
            downloadedBytes += chunk.length;
            const pct = totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
            const detail = totalBytes > 0 ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}` : formatBytes(downloadedBytes);
            activeDownloads.set(dlKey, { name: `Img: ${id.substring(0, 8)} (${type}/${face})`, percent: pct, bytes: downloadedBytes, totalBytes, detail });
            updateUI();
        });

        const tmpFile = fullPath + '.part';
        try {
            await pipeline(Readable.fromWeb(imgRes.body), progressTee, fsSync.createWriteStream(tmpFile));
            if (totalBytes > 0 && downloadedBytes !== totalBytes) throw new Error(`Image download size mismatch (expected ${totalBytes}, got ${downloadedBytes})`);
            await fs.rename(tmpFile, fullPath);
        } catch (dlErr) {
            await fs.unlink(tmpFile).catch(() => {});
            throw dlErr;
        }
        activeDownloads.delete(dlKey);

        const sha256 = hash.digest('hex');
        await withWriteLock(async () => {
            db.prepare(`
                INSERT INTO image_cache (scryfall_id, type, face, rel_path, bytes, sha256, cached_at, hit_count, last_hit_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)
                ON CONFLICT(scryfall_id, type, face) DO UPDATE SET
                    rel_path = excluded.rel_path, bytes = excluded.bytes, sha256 = excluded.sha256, cached_at = excluded.cached_at
                    -- hit_count/last_hit_at deliberately NOT touched here: a
                    -- re-fetch (e.g. after eviction or a stale-file repair)
                    -- is not a new image, and resetting its popularity to 0
                    -- would make it look artificially "least used" and an
                    -- immediate re-eviction target on the very next audit.
            `).run(id, type, face, relPath, downloadedBytes, sha256, Date.now());
        });

        addHistory(`Scryfall Img (${id.substring(0, 6)}.../${face})`, formatBytes(downloadedBytes));
        vLog('CACHE_SUCCESS', `Cached image ${relPath} (${formatBytes(downloadedBytes)}, sha256=${sha256.substring(0, 12)}...)`);
        updateCounts();
        return { ok: true, path: fullPath };
    } catch (err) {
        activeDownloads.delete(dlKey); updateUI();
        vLog('CACHE_ERR', `Failed to fetch/cache image ${id}/${type}/${face}: ${err.message}`);
        return { ok: false, status: 500, error: err.message };
    } finally {
        release();
    }
}

/**
 * Fired-and-forgotten after ANY image touch (hit or miss) on a card: fills
 * in every other size for the front face, and — if the card is genuinely
 * double-faced (layout check, not a guess) — every size for the back face
 * too, all at 'background' priority so they can never delay a real request.
 * Each combination is checked against image_cache first so repeat touches
 * of the same card are nearly free (a handful of cheap SELECTs, no network).
 */
async function queueImagePreload(scryfallId) {
    try {
        if (!db) return;
        const card = db.prepare('SELECT layout FROM cards WHERE scryfall_id = ?').get(scryfallId);
        const faces = isDoubleFacedLayout(card && card.layout) ? ['front', 'back'] : ['front'];
        const already = new Set(
            db.prepare('SELECT type, face FROM image_cache WHERE scryfall_id = ?').all(scryfallId)
                .map((r) => `${r.type}:${r.face}`)
        );
        for (const face of faces) {
            for (const type of IMAGE_TYPES) {
                if (already.has(`${type}:${face}`)) continue;
                // Deliberately NOT awaited in sequence — each call queues
                // itself behind the shared rate limiter independently, so
                // these trickle out at the same polite pace as everything
                // else hitting Scryfall's image CDN, just always yielding
                // to urgent requests.
                fetchAndCacheImage(scryfallId, type, face, 'background').catch(() => {});
            }
        }
    } catch (e) {
        vLog('CACHE_ERR', `Background image preload failed to queue for ${scryfallId}: ${e.message}`);
    }
}

// ============================================================================
// SECTION 15: SCRYFALL-SYNTAX SEARCH QUERY PARSER + SQL COMPILER
// ============================================================================
/**
 * A hand-rolled tokenizer + recursive-descent parser + SQL compiler for a
 * large, practical subset of Scryfall's search grammar, so a query pasted
 * straight from scryfall.com/search generally "just works" here too.
 *
 * COVERED: free text (bare words get FTS5 PREFIX matching per word for
 * narrow "fuzzy" behavior — liliana matches liliana's, never frederick —
 * short (<=3 char) words use exact-token matching instead, since e.g. a
 * "sol*" prefix would otherwise match "Soldier"; "quoted phrases" are exact;
 * consecutive bare words group into one phrase for both matching and
 * name-relevance ranking), !Name/!"Full Name" exact name match, c:/color:,
 * id:/identity: (letters, guild/shard/wedge names, `m` multicolor, `c`
 * colorless, all comparison operators with real superset/subset semantics),
 * t:/type:, o:/oracle:, ft:/flavor:, m:/mana: (real symbol-multiset
 * matching via a registered MANA_MATCH SQL function — "uu" matches any cost
 * containing at least two blue pips, "=" requires an exact symbol-for-
 * symbol match), mv:/cmc:, pow:/power:, tou:/toughness:, loy:/loyalty:
 * (all with full comparison operators), devotion: (pip-count per color),
 * produces: / indicator: (color-mask fields, same operator semantics as
 * color:), r:/rarity: (ordinal comparisons), s:/set:/e:/edition:,
 * cn:/number:, f:/format: and banned:/restricted: (via each card's
 * legalities JSON), is: (a broad set of flags — foil/nonfoil/fullart/
 * textless/promo/variation/reserved/hybrid/split/transform/flip/meld/
 * adventure/modal_dfc/dfc/mdfc/vanilla/spell/permanent/commander/paper/
 * arena/mtgo/digital/funny/extra/colorless/multicolor — falling back to
 * the card_tags table for anything not backed by a dedicated column),
 * a:/artist:, wm:/watermark:, border:, frame:, year:/date:, game:, lang:,
 * layout:, name:, tag:/otag: (checks card_tags AND real oracle_tags),
 * art: (checks real illustration_tags), oracleid:, negation with a leading
 * `-` on any term, boolean OR, implicit AND, parenthesized grouping, and
 * order:/direction:/unique: result modifiers — unique:cards (default)
 * collapses to one row per oracle_id (most recent printing), unique:art
 * collapses to one row per illustration_id, unique:prints shows everything,
 * all via a ROW_NUMBER() window rather than a lossy GROUP BY. Default
 * ordering (no explicit order:) is by NAME RELEVANCE when the query has
 * free text (exact name > starts-with > contains > everything else), not
 * plain alphabetical.
 *
 * NOT COVERED (documented honestly rather than silently mishandled):
 * regex oracle search (o:/pattern/), function: (would need a curated
 * functional-reprint mapping this project doesn't have), include:extras,
 * and a few very long-tail operators (cube:, in:, new:, prefer:). Anything
 * unrecognized degrades to a harmless 1=1 (i.e. it's ignored) rather than
 * breaking the whole query.
 */
function stripQuotes(s) {
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.substring(1, s.length - 1);
    return s;
}

function tokenizeScryfallQuery(input) {
    const tokens = [];
    let i = 0;
    const n = input.length;
    while (i < n) {
        const ch = input[i];
        if (/\s/.test(ch)) { i++; continue; }
        if (ch === '(') { tokens.push({ type: 'lparen' }); i++; continue; }
        if (ch === ')') { tokens.push({ type: 'rparen' }); i++; continue; }
        let negate = false;
        if (ch === '-' && i + 1 < n && !/\s/.test(input[i + 1]) && input[i + 1] !== '-') { negate = true; i++; }
        let exact = false;
        if (input[i] === '!' && i + 1 < n && !/\s/.test(input[i + 1])) { exact = true; i++; }
        if (input[i] === '"') {
            let j = i + 1;
            let buf = '';
            while (j < n && input[j] !== '"') { buf += input[j]; j++; }
            i = (j < n) ? j + 1 : j;
            tokens.push({ type: 'text', value: buf, negate, exact });
            continue;
        }
        let j = i;
        let buf = '';
        while (j < n && !/\s/.test(input[j]) && input[j] !== '(' && input[j] !== ')') {
            if (input[j] === '"') {
                buf += input[j]; j++;
                while (j < n && input[j] !== '"') { buf += input[j]; j++; }
                if (j < n) { buf += input[j]; j++; }
                continue;
            }
            buf += input[j]; j++;
        }
        i = j;
        if (buf === '') continue;
        if (buf.toUpperCase() === 'OR' && !negate) { tokens.push({ type: 'or' }); continue; }
        if (buf.toUpperCase() === 'AND' && !negate) { continue; }
        tokens.push({ type: 'word', value: buf, negate, exact });
    }
    return tokens;
}

const FIELD_ALIASES = {
    c: 'color', color: 'color',
    id: 'identity', identity: 'identity', ci: 'identity',
    t: 'type', type: 'type',
    o: 'oracle', oracle: 'oracle', fo: 'oracle',
    m: 'manacost', mana: 'manacost',
    mv: 'cmc', cmc: 'cmc', manavalue: 'cmc',
    pow: 'power', power: 'power',
    tou: 'toughness', toughness: 'toughness',
    loy: 'loyalty', loyalty: 'loyalty',
    r: 'rarity', rarity: 'rarity',
    s: 'set', set: 'set', e: 'set', edition: 'set',
    cn: 'number', number: 'number', collector: 'number',
    f: 'format', format: 'format',
    banned: 'banned', restricted: 'restricted',
    is: 'is', not: 'is',
    a: 'artist', artist: 'artist',
    wm: 'watermark', watermark: 'watermark',
    border: 'border',
    frame: 'frame',
    year: 'year', date: 'year',
    game: 'game',
    lang: 'lang', language: 'lang',
    layout: 'layout',
    name: 'name',
    tag: 'tag', otag: 'tag', art: 'arttag',
    oracleid: 'oracleid',
    ft: 'flavor', flavor: 'flavor',
    produces: 'produces',
    indicator: 'indicator', coloroindicator: 'indicator',
    devotion: 'devotion',
};

function parseWordToken(raw, negate) {
    const m = raw.match(/^([A-Za-z]+)(:|>=|<=|!=|<>|=|>|<)(.*)$/s);
    if (!m || !FIELD_ALIASES[m[1].toLowerCase()]) {
        return { type: 'freetext', value: stripQuotes(raw), negate };
    }
    const key = FIELD_ALIASES[m[1].toLowerCase()];
    let op = m[2] === '!=' ? '<>' : m[2];
    const value = stripQuotes(m[3]);
    return { type: 'field', field: key, op, value, negate };
}

function parseTokensToAst(tokens) {
    let pos = 0;
    const peek = () => tokens[pos];
    const consume = () => tokens[pos++];
    const freeTextTerms = [];

    function parseOr() {
        let node = parseAnd();
        while (peek() && peek().type === 'or') {
            consume();
            node = { type: 'or', left: node, right: parseAnd() };
        }
        return node;
    }
    function parseAnd() {
        const terms = [];
        while (peek() && peek().type !== 'or' && peek().type !== 'rparen') {
            // Greedily group a run of consecutive, un-negated bare words
            // that DON'T resolve to a recognized field:value clause into a
            // single multi-word freetext phrase ("sol ring" -> one node)
            // instead of two independently-ANDed single-word clauses. This
            // is what lets both prefix-matching and name-relevance scoring
            // treat "sol ring" as one query instead of two.
            const cur = peek();
            if (cur && cur.type === 'word' && !cur.negate && !cur.exact && parseWordToken(cur.value, false).type === 'freetext') {
                const words = [];
                while (peek() && peek().type === 'word' && !peek().negate && !peek().exact) {
                    const probe = parseWordToken(peek().value, false);
                    if (probe.type !== 'freetext') break;
                    words.push(probe.value);
                    consume();
                }
                const phrase = words.join(' ');
                freeTextTerms.push(phrase);
                terms.push({ type: 'freetext', value: phrase, negate: false, quoted: false, words });
                continue;
            }
            const t = parseTerm();
            if (t && t.type === 'freetext' && t.quoted && !t.exact) freeTextTerms.push(t.value);
            terms.push(t);
        }
        if (terms.length === 0) return { type: 'true' };
        return terms.reduce((acc, t) => (acc ? { type: 'and', left: acc, right: t } : t), null);
    }
    function parseTerm() {
        const tok = peek();
        if (!tok) return { type: 'true' };
        if (tok.type === 'lparen') {
            consume();
            const inner = parseOr();
            if (peek() && peek().type === 'rparen') consume();
            return inner;
        }
        // `!Name` / `!"Full Name"` — exact card-name match (Scryfall syntax).
        // Handled as its own node type rather than routed through FTS, since
        // it's a precise structured comparison, not a text search.
        if (tok.exact) { consume(); return { type: 'exactname', value: tok.value, negate: !!tok.negate }; }
        if (tok.type === 'text') { consume(); return { type: 'freetext', value: tok.value, negate: !!tok.negate, quoted: true }; }
        if (tok.type === 'word') { consume(); return parseWordToken(tok.value, !!tok.negate); }
        consume();
        return { type: 'true' };
    }
    const ast = tokens.length === 0 ? { type: 'true' } : parseOr();
    return { ast, freeTextTerms };
}

function numericFieldClause(colName, op, value) {
    const num = parseFloat(value);
    if (!Number.isFinite(num)) return { sql: '1=1', params: [] };
    const sqlOp = op === ':' ? '=' : op;
    return { sql: `${colName} ${sqlOp} ?`, params: [num] };
}

const RARITY_ORDER = { common: 1, uncommon: 2, rare: 3, special: 4, mythic: 5, bonus: 6 };
const RARITY_CASE_EXPR = `CASE rarity ${Object.entries(RARITY_ORDER).map(([k, n]) => `WHEN '${k}' THEN ${n}`).join(' ')} ELSE 0 END`;
function rarityFieldClause(op, value) {
    const v = value.toLowerCase();
    if (op === ':' || op === '=') return { sql: `rarity = ?`, params: [v] };
    if (op === '<>') return { sql: `rarity != ?`, params: [v] };
    const target = RARITY_ORDER[v];
    if (target === undefined) return { sql: `rarity = ?`, params: [v] };
    return { sql: `${RARITY_CASE_EXPR} ${op} ?`, params: [target] };
}

const COLOR_NAME_MAP = {
    azorius: 1 | 2, dimir: 2 | 4, rakdos: 4 | 8, gruul: 8 | 16, selesnya: 16 | 1,
    orzhov: 1 | 4, izzet: 2 | 8, golgari: 4 | 16, boros: 8 | 1, simic: 16 | 2,
    bant: 1 | 2 | 16, esper: 1 | 2 | 4, grixis: 2 | 4 | 8, jund: 4 | 8 | 16, naya: 8 | 16 | 1,
    abzan: 1 | 4 | 16, jeskai: 1 | 2 | 8, sultai: 2 | 4 | 16, mardu: 1 | 4 | 8, temur: 2 | 8 | 16,
    wubrg: 1 | 2 | 4 | 8 | 16,
    white: 1, blue: 2, black: 4, red: 8, green: 16,
};
function parseColorExpr(value) {
    const v = value.toLowerCase();
    if (COLOR_NAME_MAP[v] !== undefined) return COLOR_NAME_MAP[v];
    let mask = 0;
    for (const ch of v) { const bit = COLOR_BITS[ch.toUpperCase()]; if (bit) mask |= bit; }
    return mask;
}
function colorFieldClause(colName, op, value) {
    const v = value.toLowerCase();
    if (v === 'm' || v === 'multicolor' || v === 'multicolour') {
        const popcount = `((${colName}&1)+((${colName}>>1)&1)+((${colName}>>2)&1)+((${colName}>>3)&1)+((${colName}>>4)&1))`;
        return { sql: `${popcount} >= 2`, params: [] };
    }
    if (v === 'c' || v === 'colorless') return { sql: `${colName} = 0`, params: [] };
    const mask = parseColorExpr(v);
    switch (op) {
        case ':': case '>=': return { sql: `(${colName} & ?) = ?`, params: [mask, mask] };
        case '=': return { sql: `${colName} = ?`, params: [mask] };
        case '<>': return { sql: `${colName} != ?`, params: [mask] };
        case '<=': return { sql: `(${colName} | ?) = ?`, params: [mask, mask] };
        case '>': return { sql: `(${colName} & ?) = ? AND ${colName} != ?`, params: [mask, mask, mask] };
        case '<': return { sql: `(${colName} | ?) = ? AND ${colName} != ?`, params: [mask, mask, mask] };
        default: return { sql: '1=1', params: [] };
    }
}

/** devotion:u>=3 style — counts non-hybrid pip occurrences of one color in
 * the stored mana_cost string (e.g. "{2}{U}{U}" -> 2 U pips). Hybrid/Phyrexian
 * mana symbols ({U/B}, {U/P}) are NOT counted toward devotion here — a real
 * devotion count would need each symbol parsed individually rather than a
 * plain substring count; this is a documented simplification, not silent
 * wrong behavior. */
function devotionFieldClause(rawValue) {
    const m = String(rawValue).match(/^([wubrgc])\s*(:|>=|<=|!=|<>|=|>|<)?\s*(\d+)?$/i);
    if (!m) return { sql: '1=1', params: [] };
    const colorLetter = m[1].toUpperCase();
    const op = m[2] === '!=' ? '<>' : (m[2] || '>=');
    const num = m[3] !== undefined ? parseInt(m[3], 10) : 1;
    const symbol = `{${colorLetter}}`;
    const countExpr = `((LENGTH(COALESCE(mana_cost,'')) - LENGTH(REPLACE(COALESCE(mana_cost,''), '${symbol}', ''))) / ${symbol.length})`;
    const sqlOp = op === ':' ? '>=' : op;
    return { sql: `${countExpr} ${sqlOp} ?`, params: [num] };
}

const IS_FLAG_SQL_MAP = {
    foil: `foil = 1`, nonfoil: `nonfoil = 1`,
    fullart: `full_art = 1`, full: `full_art = 1`,
    textless: `textless = 1`, promo: `promo = 1`, variation: `variation = 1`,
    reserved: `reserved = 1`,
    hybrid: `mana_cost LIKE '%/%'`,
    split: `layout = 'split'`, transform: `layout = 'transform'`, flip: `layout = 'flip'`,
    meld: `layout = 'meld'`, adventure: `layout = 'adventure'`, modal_dfc: `layout = 'modal_dfc'`,
    vanilla: `(oracle_text IS NULL OR oracle_text = '')`,
    spell: `(type_line LIKE '%Instant%' OR type_line LIKE '%Sorcery%')`,
    permanent: `(type_line NOT LIKE '%Instant%' AND type_line NOT LIKE '%Sorcery%')`,
    commander: `(type_line LIKE '%Legendary%Creature%' OR oracle_text LIKE '%can be your commander%')`,
    dfc: `layout IN ('transform','modal_dfc','double_faced_token','reversible_card')`,
    mdfc: `layout = 'modal_dfc'`,
    paper: `games LIKE '%paper%'`,
    arena: `games LIKE '%arena%'`,
    mtgo: `games LIKE '%mtgo%'`,
    digital: `(games IS NOT NULL AND games NOT LIKE '%paper%')`,
    funny: `set_type = 'funny'`,
    extra: `layout IN ('token','emblem','art_series')`,
    colorless: `color_mask = 0`,
    multicolor: `((color_mask&1)+((color_mask>>1)&1)+((color_mask>>2)&1)+((color_mask>>3)&1)+((color_mask>>4)&1)) >= 2`,
};
function isFlagClause(value) {
    const v = value.toLowerCase();
    if (IS_FLAG_SQL_MAP[v]) return { sql: IS_FLAG_SQL_MAP[v], params: [] };
    return { sql: `EXISTS (SELECT 1 FROM card_tags WHERE scryfall_id = cards.scryfall_id AND tag = ?)`, params: [v] };
}

function yearFieldClause(op, value) {
    const y = String(parseInt(value, 10)).padStart(4, '0');
    if (op === ':' || op === '=') return { sql: `substr(released_at,1,4) = ?`, params: [y] };
    if (op === '<>') return { sql: `substr(released_at,1,4) != ?`, params: [y] };
    const boundary = (op === '>' || op === '>=') ? `${y}-12-31` : `${y}-01-01`;
    return { sql: `released_at ${op} ?`, params: [boundary] };
}

function compileFieldClause(node) {
    const { field, op, value } = node;
    try {
        switch (field) {
            case 'color': return colorFieldClause('color_mask', op, value);
            case 'identity': return colorFieldClause('identity_mask', op, value);
            case 'type': return { sql: `type_line LIKE ? COLLATE NOCASE`, params: [`%${value}%`] };
            case 'oracle': return { sql: `cards.rowid IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)`, params: [`oracle_text:"${value.replace(/"/g, '""')}"`] };
            case 'manacost': return { sql: `MANA_MATCH(mana_cost, ?, ?) = 1`, params: [value, op === ':' ? '>=' : op] };
            case 'cmc': return numericFieldClause('cmc', op, value);
            case 'power': return numericFieldClause('power_num', op, value);
            case 'toughness': return numericFieldClause('toughness_num', op, value);
            case 'loyalty': return numericFieldClause('loyalty_num', op, value);
            case 'rarity': return rarityFieldClause(op, value);
            case 'set': return { sql: `set_code = ? COLLATE NOCASE`, params: [value] };
            case 'number': return { sql: `collector_number = ? COLLATE NOCASE`, params: [value] };
            case 'format': return { sql: `json_extract(legalities, '$.' || ?) = 'legal'`, params: [value.toLowerCase()] };
            case 'banned': return { sql: `json_extract(legalities, '$.' || ?) = 'banned'`, params: [value.toLowerCase()] };
            case 'restricted': return { sql: `json_extract(legalities, '$.' || ?) = 'restricted'`, params: [value.toLowerCase()] };
            case 'is': return isFlagClause(value);
            case 'artist': return { sql: `artist LIKE ? COLLATE NOCASE`, params: [`%${value}%`] };
            case 'watermark': return { sql: `watermark = ? COLLATE NOCASE`, params: [value] };
            case 'border': return { sql: `border_color = ? COLLATE NOCASE`, params: [value] };
            case 'frame': return { sql: `frame = ? COLLATE NOCASE`, params: [value] };
            case 'year': return yearFieldClause(op, value);
            case 'game': return { sql: `games LIKE ? COLLATE NOCASE`, params: [`%${value}%`] };
            case 'lang': return { sql: `lang = ? COLLATE NOCASE`, params: [value] };
            case 'layout': return { sql: `layout = ? COLLATE NOCASE`, params: [value] };
            case 'name': return { sql: `name LIKE ? COLLATE NOCASE`, params: [`%${value}%`] };
            // BUGFIX: real Tagger data lives in oracle_tags/illustration_tags
            // (Section 12), joined via cards.oracle_id / cards.illustration_id
            // — NOT in card_tags, which only holds metadata-derived tags
            // (keywords, frame effects, etc). Previously `tag:`/`otag:`/
            // `art:` only ever checked card_tags, so real Tagger tags were
            // ingested successfully but never reachable from search or the
            // card detail API. Now checks both sources.
            case 'tag':
                return {
                    sql: `(EXISTS (SELECT 1 FROM card_tags WHERE scryfall_id = cards.scryfall_id AND tag LIKE ?)
                           OR EXISTS (SELECT 1 FROM oracle_tags WHERE oracle_id = cards.oracle_id AND slug LIKE ?)
                           OR EXISTS (SELECT 1 FROM illustration_tags WHERE illustration_id = cards.illustration_id AND slug LIKE ?))`,
                    params: [`%${value}%`, `%${value}%`, `%${value}%`],
                };
            case 'arttag':
                return {
                    sql: `EXISTS (SELECT 1 FROM illustration_tags WHERE illustration_id = cards.illustration_id AND slug LIKE ?)`,
                    params: [`%${value}%`],
                };
            case 'oracleid': return { sql: `oracle_id = ?`, params: [value] };
            case 'flavor': return { sql: `cards.rowid IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)`, params: [`flavor_text:"${value.replace(/"/g, '""')}"`] };
            case 'produces': return colorFieldClause('produced_mana_mask', op, value);
            case 'indicator': return colorFieldClause('color_indicator_mask', op, value);
            case 'devotion': return devotionFieldClause(value);
            default: return { sql: '1=1', params: [] };
        }
    } catch (e) {
        return { sql: '1=1', params: [] };
    }
}

function compileAstToSql(node) {
    if (!node) return { sql: '1=1', params: [] };
    switch (node.type) {
        case 'true': return { sql: '1=1', params: [] };
        case 'exactname': {
            const clause = { sql: `name = ? COLLATE NOCASE`, params: [node.value] };
            return node.negate ? { sql: `NOT (${clause.sql})`, params: clause.params } : clause;
        }
        case 'and': {
            const l = compileAstToSql(node.left), r = compileAstToSql(node.right);
            return { sql: `(${l.sql} AND ${r.sql})`, params: [...l.params, ...r.params] };
        }
        case 'or': {
            const l = compileAstToSql(node.left), r = compileAstToSql(node.right);
            return { sql: `(${l.sql} OR ${r.sql})`, params: [...l.params, ...r.params] };
        }
        case 'freetext': {
            let ftsQuery;
            if (node.quoted) {
                ftsQuery = `"${node.value.replace(/"/g, '""')}"`;
            } else {
                // BUGFIX (search relevance overhaul): bare (unquoted) terms
                // now use FTS5 PREFIX matching per word ("liliana" ->
                // "liliana*", matching "Liliana's Contract" etc.) instead of
                // an exact-token match, which is the intentionally narrow
                // "fuzzy" behavior requested — it extends the end of a
                // word, it does NOT do edit-distance/similarity matching
                // against the whole database, so "liliana" can never match
                // "frederick". Multi-word bare phrases ("sol ring") were
                // grouped into one node by the parser and become a single
                // space-separated prefix query ("sol* ring*"), which FTS5
                // treats as an implicit AND of both prefixes.
                const words = (node.words && node.words.length ? node.words : [node.value]);
                const sanitized = words.map((w) => w.replace(/[^A-Za-z0-9'\u00C0-\u024F]/g, '')).filter(Boolean);
                if (sanitized.length === 0) {
                    return node.negate ? { sql: '0=1', params: [] } : { sql: '1=1', params: [] };
                }
                // Short words (<=3 chars) use an EXACT token match instead
                // of a prefix — a prefix like "sol*" matches "Soldier" in
                // type lines (found via live testing: searching "sol ring"
                // surfaced every Human/Dwarf Soldier creature mentioning
                // "ring" anywhere in its rules text). Longer words still get
                // prefix matching so "liliana" -> "liliana*" still catches
                // "Liliana's Contract" etc.
                ftsQuery = sanitized.map((w) => (w.length <= 3 ? w : `${w}*`)).join(' ');
            }
            // BUGFIX (found via live testing — "sol ring" pulling in "Ensoul
            // Ring"/"Ring Out"): FTS5's default MATCH semantics let each
            // term in a multi-word query satisfy the match in a DIFFERENT
            // column of the same row (e.g. "sol" hitting oracle_text while
            // "ring" hits name on some unrelated card) — it does not require
            // the terms to co-occur in one field. Column-scoping the exact
            // same query string into two explicit alternatives (name-only,
            // or the combined rules-text columns) forces every term in a
            // phrase to land together in ONE field, eliminating that
            // cross-column false-positive class entirely while still
            // matching real oracle-text/type-line searches the same as
            // before.
            const scopedQuery = `{name}: ${ftsQuery} OR {type_line oracle_text flavor_text}: ${ftsQuery}`;
            const clause = { sql: `cards.rowid IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)`, params: [scopedQuery] };
            return node.negate ? { sql: `NOT (${clause.sql})`, params: clause.params } : clause;
        }
        case 'field': {
            const clause = compileFieldClause(node);
            return node.negate ? { sql: `NOT (${clause.sql})`, params: clause.params } : clause;
        }
        default: return { sql: '1=1', params: [] };
    }
}

const ORDER_COLUMN_MAP = {
    name: 'name COLLATE NOCASE',
    set: 'set_code',
    released: 'released_at',
    rarity: RARITY_CASE_EXPR,
    color: 'color_mask',
    usd: 'CASE WHEN price_usd IS NULL THEN 1 ELSE 0 END, price_usd',
    eur: 'CASE WHEN price_eur IS NULL THEN 1 ELSE 0 END, price_eur',
    cmc: 'cmc',
    power: 'power_num',
    toughness: 'toughness_num',
    edhrec: 'edhrec_rank',
    artist: 'artist COLLATE NOCASE',
};

function extractGlobalModifiers(rawQuery) {
    let q = rawQuery;
    // Default changed from Scryfall's own 'cards' default to 'prints': the
    // user wants every matching row returned as-is — no collapsing by
    // oracle_id (unique:cards) or illustration_id (unique:art), and
    // definitely no separate foil/nonfoil binning (which was never a real
    // grouping key here anyway — foil/nonfoil are just flags on a single
    // printing row, not a dedup axis). unique:cards / unique:art are still
    // available as explicit opt-ins via the query string.
    let order = null, direction = null, unique = 'prints';
    q = q.replace(/\border:(\S+)/gi, (m0, v) => { order = v.toLowerCase(); return ' '; });
    q = q.replace(/\bdirection:(\S+)/gi, (m0, v) => { direction = v.toLowerCase(); return ' '; });
    q = q.replace(/\bunique:(\S+)/gi, (m0, v) => { unique = v.toLowerCase(); return ' '; });
    return { cleanedQuery: q.trim(), order, direction, unique };
}

/** Parses a full Scryfall-style query string into a ready-to-run WHERE
 * fragment + params + ORDER BY clause. Never throws — a query this can't
 * make sense of degrades toward "match everything" for the unparseable
 * portion rather than 500ing the whole request.
 *
 * SEARCH RELEVANCE: when the person didn't explicitly ask for an order:
 * and the query contains free text (the common "just type a card name"
 * case), results are ranked by how the match relates to the CARD NAME
 * first — exact name match, then name-starts-with, then name-contains,
 * then everything else (oracle text / type line / etc. matches) — before
 * falling back to alphabetical. This directly targets "searching Avacyn
 * surfaces unrelated cards above Avacyn" / "Sol Ring should outrank a
 * card that merely contains the word Ring somewhere in its text".
 */
function compileScryfallSearchQuery(rawQuery) {
    try {
        const { cleanedQuery, order, direction, unique } = extractGlobalModifiers(rawQuery || '');
        const tokens = tokenizeScryfallQuery(cleanedQuery);
        const { ast, freeTextTerms } = parseTokensToAst(tokens);
        const { sql, params } = compileAstToSql(ast);

        const DESC_BY_DEFAULT = new Set(['usd', 'eur', 'edhrec', 'released']);
        const effectiveOrder = order || (freeTextTerms.length > 0 ? 'relevance' : 'name');
        const dir = direction ? (direction === 'desc' ? 'DESC' : 'ASC') : (DESC_BY_DEFAULT.has(effectiveOrder) ? 'DESC' : 'ASC');

        const freeText = freeTextTerms.join(' ').trim();
        let orderSql;
        if (effectiveOrder === 'relevance' && freeText) {
            // Three extra bound params (exact / prefix / substring) go
            // BEFORE the WHERE params in the final query — see the route
            // handler, which builds the full param list in this exact order.
            orderSql = `CASE
                WHEN name = ? COLLATE NOCASE THEN 0
                WHEN name LIKE ? COLLATE NOCASE THEN 1
                WHEN name LIKE ? COLLATE NOCASE THEN 2
                ELSE 3
            END ASC, name COLLATE NOCASE ASC`;
        } else {
            const orderCol = ORDER_COLUMN_MAP[effectiveOrder] || ORDER_COLUMN_MAP.name;
            orderSql = `${orderCol} ${dir}`;
        }

        return {
            whereSql: sql, params, orderSql, unique, ok: true,
            freeText, isRelevanceOrder: effectiveOrder === 'relevance' && !!freeText,
        };
    } catch (err) {
        vLog('QUERY_PARSE_ERR', `Failed to compile search query "${rawQuery}": ${err.message}`);
        return { whereSql: '1=1', params: [], orderSql: 'name COLLATE NOCASE ASC', unique: 'cards', ok: false, error: err.message, freeText: '', isRelevanceOrder: false };
    }
}

// ============================================================================
// SECTION 16: EXPRESS HTTP SERVER & ROUTING
// ============================================================================
const app = express();
app.use(express.json());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use((req, res, next) => {
    reqsThisSecond++;
    stats.totalRequests++;
    const startNano = process.hrtime.bigint();
    res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - startNano) / 1_000_000;
        if (res.statusCode >= 500) stats.status5xx++;
        else if (res.statusCode >= 400) stats.status4xx++;
        else stats.status2xx++;
        requestRing.push({ method: req.method, path: req.path, status: res.statusCode, ms: durationMs, ts: Date.now() });
        if (requestRing.length > REQUEST_RING_SIZE) requestRing.shift();
        tLog(req.method, req.path, res.statusCode, durationMs.toFixed(2));
    });
    next();
});

// Every route below reads/writes the database. If it's momentarily null
// (mid-restore, mid-restart-of-connection after a guarded rollback), fail
// fast and honestly with a 503 instead of throwing deep inside a handler.
app.use((req, res, next) => {
    if (!db && req.path !== '/api/health') {
        return res.status(503).json({ success: false, error: 'Database temporarily unavailable (self-healing in progress). Please retry shortly.' });
    }
    next();
});

setInterval(() => {
    stats.rps = reqsThisSecond;
    stats.peakRps = Math.max(stats.peakRps, reqsThisSecond);
    reqsThisSecond = 0;
    updateUI();
}, 1000);

app.use(express.static(PUBLIC_DIR));

app.get('/api/health', (req, res) => {
    res.json({ success: true, status: stats.dbStatus, uptimeSeconds: Math.floor(process.uptime()), generation: dbGeneration, supervised: typeof process.send === 'function' });
});

app.get('/api/stats', (req, res) => {
    res.json({ success: true, data: stats, recentRequests: requestRing.slice(-50) });
});
app.get('/api/cards/:scryfallId/dump', (req, res) => {
    const id = String(req.params.scryfallId || '').toLowerCase();
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'Invalid Scryfall ID format.' });

    try {
        const card = db.prepare('SELECT * FROM cards WHERE scryfall_id = ?').get(id);
        if (!card) return res.status(404).json({ success: false, error: 'Card not found in database.' });

        ['mtgjson_data', 'scryfall_data', 'legalities'].forEach(k => {
            try { card[k] = card[k] ? JSON.parse(card[k]) : null; } catch (e) { card[k] = null; }
        });

        res.json({
            success: true,
            data: {
                card,
                sales: db.prepare('SELECT * FROM manapool_sales WHERE scryfall_id = ? ORDER BY date DESC').all(id),
                images: db.prepare('SELECT * FROM image_cache WHERE scryfall_id = ?').all(id),
                metadata_tags: db.prepare('SELECT * FROM card_tags WHERE scryfall_id = ?').all(id),
                oracle_tags: card.oracle_id ? db.prepare('SELECT * FROM oracle_tags WHERE oracle_id = ?').all(card.oracle_id) : [],
                art_tags: card.illustration_id ? db.prepare('SELECT * FROM illustration_tags WHERE illustration_id = ?').all(card.illustration_id) : [],
                rulings: card.oracle_id ? db.prepare('SELECT * FROM rulings WHERE oracle_id = ? ORDER BY published_at ASC').all(card.oracle_id) : []
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/restore', async (req, res) => {
    try {
        vLog('SYSTEM', 'Manual restore requested via /api/admin/restore.');
        const restored = await restoreFromBestAvailableSnapshot('manual-api-request');
        if (restored) {
            initDatabase();
            res.json({ success: true, message: 'Restored from the most recent usable snapshot.' });
        } else {
            res.status(404).json({ success: false, error: 'No usable snapshot was available to restore from.' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/resync/:source', async (req, res) => {
    const source = String(req.params.source || '').toLowerCase();
    try {
        if (source === 'mtgjson') { checkMtgJsonSync(true).catch((e) => vLog('MTGJSON_ERR', e.message)); }
        else if (source === 'manapool') { manapoolForceFlag.force = true; }
        else if (source === 'scryfall') { runScryfallBulkSync(true).catch((e) => vLog('SCRYFALL_ERR', e.message)); }
        else if (source === 'heal') { runSelfAudit().catch((e) => vLog('AUDIT_ERR', e.message)); }
        else if (source === 'diskspace') { runDiskSpaceAudit().catch((e) => vLog('DISK_AUDIT_ERR', e.message)); }
        else return res.status(400).json({ success: false, error: 'Unknown source. Use one of: mtgjson, manapool, scryfall, heal, diskspace.' });
        res.json({ success: true, message: `${source} resync triggered.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/cache/:scryfallId/:type.jpg', async (req, res) => {
    const id = String(req.params.scryfallId || '').toLowerCase();
    const type = String(req.params.type || '').toLowerCase();
    const face = String(req.query.face || 'front').toLowerCase() === 'back' ? 'back' : 'front';

    if (!UUID_RE.test(id)) {
        vLog('CACHE_ERR', `Rejected malformed scryfall_id in image request: ${id}`);
        return res.status(400).json({ success: false, error: 'Invalid Scryfall ID format.' });
    }
    const ALLOWED_TYPES = new Set(['small', 'normal', 'large', 'png', 'art_crop', 'border_crop']);
    if (!ALLOWED_TYPES.has(type)) {
        return res.status(400).json({ success: false, error: `Invalid image type. Allowed: ${[...ALLOWED_TYPES].join(', ')}` });
    }

    // BUGFIX: now that the frontend's 3D flip card loads BOTH faces
    // unconditionally on every card view (not just on a flip click), a
    // back-face request happens for every single card shown — and the vast
    // majority of cards are single-faced. Without this check, every one of
    // those would hit Scryfall's CDN for a back image that will always
    // 404, forever (the earlier "try then fall back" version never cached
    // the negative result, so it re-attempted the doomed network call on
    // literally every view of every single-faced card). Checking the DB's
    // own `layout` column first — already local, already free — means a
    // non-double-faced card's "back" never touches the network at all and
    // always serves the one shared generic placeholder instantly.
    if (face === 'back') {
        let cardLayout = null;
        try { cardLayout = db.prepare('SELECT layout FROM cards WHERE scryfall_id = ?').get(id); } catch (e) { /* fall through to generic on lookup failure too */ }
        if (!cardLayout || !isDoubleFacedLayout(cardLayout.layout)) {
            ensureGenericCardBack();
            stats.cacheHits++;
            return res.sendFile(genericCardBackAssetPath());
        }
    }

    let cacheRow = null;
    try { cacheRow = db.prepare('SELECT rel_path, bytes FROM image_cache WHERE scryfall_id = ? AND type = ? AND face = ?').get(id, type, face); }
    catch (e) { vLog('CACHE_ERR', `Lookup failed: ${e.message}`); }

    if (cacheRow) {
        const fullPath = path.join(IMG_CACHE_DIR, cacheRow.rel_path);
        if (fsSync.existsSync(fullPath) && fsSync.statSync(fullPath).size > 0) {
            stats.cacheHits++;
            recordImageHit(id, type, face).catch(() => {}); // fire-and-forget: never delay a response for a counter update
            queueImagePreload(id); // opportunistic: even on a hit, fill in any other sizes/faces we're still missing
            return res.sendFile(fullPath);
        }
        vLog('CACHE', `Cache row present but file missing/empty for ${id} (${type}/${face}) — evicting and re-fetching.`);
        try { db.prepare('DELETE FROM image_cache WHERE scryfall_id = ? AND type = ? AND face = ?').run(id, type, face); } catch (e) { /* noop */ }
    }

    stats.cacheMisses++;
    queueForEnrichmentIfMissing(id); // opportunistic: an image miss is a good moment to also make sure full card data isn't missing
    vLog('CACHE', `Image cache MISS for ${id} (${type}/${face}). Fetching from Scryfall CDN (urgent priority)...`);
    const result = await fetchAndCacheImage(id, type, face, 'urgent');
    if (!result.ok) {
        // A requested 'back' face is never allowed to dead-end in a JSON
        // error: whether this card is genuinely single-faced (Scryfall has
        // no back art to give us — a normal, permanent 404) or the fetch
        // merely failed transiently, the frontend's flip button should
        // always have *something* to show. Serve the shared generic card
        // back placeholder in either case. This is intentionally NOT
        // written into image_cache — it's not a real cached asset for this
        // card, just a stand-in — so a genuinely double-faced card that hit
        // a transient failure will still be retried for real on next request.
        if (face === 'back') {
            ensureGenericCardBack();
            vLog('CACHE', `No real back face available for ${id} (${result.status === 404 ? '404 — likely single-faced' : `error: ${result.error || result.status}`}). Serving generic card back placeholder.`);
            return res.sendFile(genericCardBackAssetPath());
        }
        return res.status(result.status || 500).json({ success: false, error: result.error || 'Image not found on Scryfall.' });
    }
    recordImageHit(id, type, face).catch(() => {}); // this was a live, on-demand fetch — counts as a real hit
    queueImagePreload(id); // now that this card has been touched, top up the rest in the background
    return res.sendFile(result.path);
});

/**
 * Scryfall-syntax search, response shape modeled directly on Scryfall's own
 * `/cards/search` (object/total_cards/has_more/next_page/data), so existing
 * tooling built against Scryfall's response shape needs minimal changes.
 * Paste a query straight from scryfall.com/search into `q` and it should
 * behave the same way — see Section 15 for exactly what's covered.
 */
app.get('/api/search', (req, res) => {
    const q = String(req.query.q || req.query.query || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    if (!q) return res.status(400).json({ object: 'error', code: 'bad_request', details: 'Missing q (or query) parameter.' });

    const compiled = compileScryfallSearchQuery(q);
    vLog('QUERY', `Search: q="${q}" page=${page}${compiled.ok ? '' : ' (partial parse)'}`);
    try {
        const offset = (page - 1) * SEARCH_PAGE_SIZE;
        const orderParams = compiled.isRelevanceOrder
            ? [compiled.freeText, `${compiled.freeText}%`, `%${compiled.freeText}%`]
            : [];

        // unique: dedup (Scryfall semantics): "cards" (default) collapses
        // multiple prints down to one per oracle_id, keeping the most
        // recently released printing; "art" collapses down to one per
        // unique illustration; "prints" shows every matching row. Built as
        // an extra WHERE fragment restricting to the row picked by a
        // ROW_NUMBER() window over the SAME filter, rather than a GROUP BY,
        // so all the normally-selected columns stay available.
        let uniqueWhereSql = '1=1';
        let uniqueParams = [];
        if (compiled.unique === 'art' || compiled.unique === 'cards') {
            const groupExpr = compiled.unique === 'art' ? 'COALESCE(illustration_id, scryfall_id)' : 'COALESCE(oracle_id, scryfall_id)';
            uniqueWhereSql = `scryfall_id IN (
                SELECT scryfall_id FROM (
                    SELECT scryfall_id, ROW_NUMBER() OVER (PARTITION BY ${groupExpr} ORDER BY released_at DESC, scryfall_id DESC) AS rn
                    FROM cards WHERE ${compiled.whereSql}
                ) WHERE rn = 1
            )`;
            uniqueParams = [...compiled.params];
        }
        const fullWhereSql = `(${compiled.whereSql}) AND (${uniqueWhereSql})`;
        const fullWhereParams = [...compiled.params, ...uniqueParams];

        const totalCards = db.prepare(`SELECT COUNT(*) AS cnt FROM cards WHERE ${fullWhereSql}`).get(...fullWhereParams).cnt;
        const rows = db.prepare(`
            SELECT scryfall_id, oracle_id, illustration_id, name, set_code, set_name, collector_number, rarity, type_line,
                   mana_cost, cmc, colors, color_identity, power, toughness, loyalty, oracle_text,
                   price_usd, price_usd_foil, price_eur, released_at, artist, layout, keywords, foil
            FROM cards WHERE ${fullWhereSql} ORDER BY ${compiled.orderSql} LIMIT ? OFFSET ?
        `).all(...fullWhereParams, ...orderParams, SEARCH_PAGE_SIZE, offset);

        const hasMore = offset + rows.length < totalCards;
        vLog('QUERY_SUCCESS', `Search returned ${rows.length} of ${totalCards} total (page ${page}, unique:${compiled.unique}).`);
        const payload = {
            object: 'list',
            total_cards: totalCards,
            has_more: hasMore,
            data: rows,
        };
        if (hasMore) payload.next_page = `/api/search?q=${encodeURIComponent(q)}&page=${page + 1}`;
        if (!compiled.ok) payload.warnings = [`Query could not be fully parsed: ${compiled.error}`];
        res.json(payload);
    } catch (err) {
        vLog('QUERY_ERR', `Search query failed: ${err.message}`);
        res.status(500).json({ object: 'error', code: 'search_failed', details: err.message });
    }
});

app.get('/api/cards/:scryfallId', (req, res) => {
    const id = String(req.params.scryfallId || '').toLowerCase();
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'Invalid Scryfall ID format.' });

    vLog('QUERY', `Fetching card details for ${id}`);
    try {
        const card = db.prepare('SELECT * FROM cards WHERE scryfall_id = ?').get(id);
        if (!card) return res.status(404).json({ success: false, error: 'Card not found in database.' });

        try { card.mtgjson_data = card.mtgjson_data ? JSON.parse(card.mtgjson_data) : null; } catch (e) { card.mtgjson_data = null; }
        try { card.scryfall_data = card.scryfall_data ? JSON.parse(card.scryfall_data) : null; } catch (e) { card.scryfall_data = null; }
        try { card.legalities = card.legalities ? JSON.parse(card.legalities) : null; } catch (e) { card.legalities = null; }

        const sales = db.prepare('SELECT date, price, condition, foil, language, quantity, source_date FROM manapool_sales WHERE scryfall_id = ? ORDER BY date DESC LIMIT 500').all(id);
        const imageInfo = db.prepare('SELECT type, face, cached_at FROM image_cache WHERE scryfall_id = ?').all(id);
        const metadataTags = db.prepare('SELECT tag, source FROM card_tags WHERE scryfall_id = ?').all(id);
        // Real Scryfall Tagger data — joined here (not stored in card_tags,
        // see Section 12/15) via the card's own oracle_id / illustration_id.
        const oracleTags = card.oracle_id
            ? db.prepare('SELECT DISTINCT slug, label FROM oracle_tags WHERE oracle_id = ? ORDER BY slug').all(card.oracle_id)
            : [];
        const artTags = card.illustration_id
            ? db.prepare('SELECT DISTINCT slug, label FROM illustration_tags WHERE illustration_id = ? ORDER BY slug').all(card.illustration_id)
            : [];
        const tags = [
            ...metadataTags.map((t) => ({ tag: t.tag, label: t.tag, source: t.source || 'metadata' })),
            ...oracleTags.map((t) => ({ tag: `otag:${t.slug}`, label: t.label, source: 'oracle_tag' })),
            ...artTags.map((t) => ({ tag: `art:${t.slug}`, label: t.label, source: 'art_tag' })),
        ];
        const rulings = card.oracle_id
            ? db.prepare('SELECT published_at, source, comment FROM rulings WHERE oracle_id = ? ORDER BY published_at ASC').all(card.oracle_id)
            : [];

        if (card.scryfall_synced_at == null) queueForEnrichmentIfMissing(id);

        vLog('QUERY_SUCCESS', `Card record + ${sales.length} sales + ${tags.length} tags (${oracleTags.length} oracle, ${artTags.length} art) + ${rulings.length} rulings retrieved.`);
        res.json({ success: true, data: { card, historical_sales: sales, cached_images: imageInfo, tags, rulings } });
    } catch (err) {
        vLog('QUERY_ERR', `Failed to retrieve card record: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================================
// SECTION 17B: LIVE COLORISED LOG (web view of the TUI's log panel)
// ============================================================================
// JSON feed backing the /log page. `since` lets a poller ask for only what's
// new since its last successful poll (by entry id, not timestamp — ids are a
// strictly increasing sequence, so this is race-free even across restarts of
// the polling client). Without `since`, returns the most recent LOG_BUFFER_MAX
// entries (i.e. everything currently buffered).
app.get('/api/log', (req, res) => {
    const sinceRaw = req.query.since;
    const since = sinceRaw !== undefined ? parseInt(sinceRaw, 10) : null;
    const entries = (since !== null && !Number.isNaN(since))
        ? recentLogEntries.filter((e) => e.id > since)
        : recentLogEntries;
    res.json({ success: true, data: entries, latest: logSeq });
});

// A small self-contained (no build step, no external assets) HTML page that
// polls /api/log and renders it like a terminal — same color-per-tag scheme
// vLog already uses for the blessed TUI (grey timestamp, bold colored tag,
// plain message), dark background, monospace, auto-scrolls to the newest
// line unless the user has scrolled up to read back through history.
app.get('/log', (req, res) => {
    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>MTG Oracle Daemon — Live Log</title>
<style>
    :root {
        --grey-fg: #94a3b8; --red-fg: #f87171; --yellow-fg: #fbbf24;
        --green-fg: #34d399; --cyan-fg: #22d3ee; --magenta-fg: #e879f9;
    }
    * { box-sizing: border-box; }
    body {
        margin: 0; background: #020617; color: #e2e8f0;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12.5px; height: 100vh; display: flex; flex-direction: column;
    }
    header {
        padding: 8px 12px; border-bottom: 1px solid #1e293b; display: flex;
        align-items: center; justify-content: space-between; flex-shrink: 0;
        background: rgba(2,6,23,0.9);
    }
    header h1 { font-size: 13px; margin: 0; color: var(--cyan-fg); letter-spacing: 0.05em; }
    header .status { color: var(--grey-fg); font-size: 11px; }
    header .status.live::before { content: '●'; color: var(--green-fg); margin-right: 5px; }
    header .status.stalled::before { content: '●'; color: var(--red-fg); margin-right: 5px; }
    #log { flex: 1; overflow-y: auto; padding: 10px 12px; white-space: pre-wrap; word-break: break-word; }
    .line { line-height: 1.5; }
    .ts { color: var(--grey-fg); }
    .tag { font-weight: bold; }
    .fg-red-fg { color: var(--red-fg); } .fg-yellow-fg { color: var(--yellow-fg); }
    .fg-green-fg { color: var(--green-fg); } .fg-cyan-fg { color: var(--cyan-fg); }
    .fg-magenta-fg { color: var(--magenta-fg); } .fg-grey-fg { color: var(--grey-fg); }
    ::-webkit-scrollbar { width: 8px; } ::-webkit-scrollbar-track { background: #020617; }
    ::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
</style>
</head>
<body>
    <header>
        <h1>MTG ORACLE DAEMON — LIVE LOG</h1>
        <span id="status" class="status live">connecting…</span>
    </header>
    <div id="log"></div>
    <script>
        const logEl = document.getElementById('log');
        const statusEl = document.getElementById('status');
        let since = null;
        let stuckAtBottom = true;
        logEl.addEventListener('scroll', () => {
            stuckAtBottom = (logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight) < 40;
        });
        function esc(s) {
            return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        function fmtTime(ts) {
            return new Date(ts).toISOString().substring(11, 19);
        }
        function render(entries) {
            if (!entries.length) return;
            const html = entries.map(e =>
                '<div class="line"><span class="ts">[' + fmtTime(e.ts) + ']</span> ' +
                '<span class="tag fg-' + e.color + '">[' + esc(e.tag) + ']</span> ' +
                '<span class="msg">' + esc(e.msg) + '</span></div>'
            ).join('');
            logEl.insertAdjacentHTML('beforeend', html);
            const MAX_DOM_LINES = 4000;
            while (logEl.children.length > MAX_DOM_LINES) logEl.removeChild(logEl.firstChild);
            if (stuckAtBottom) logEl.scrollTop = logEl.scrollHeight;
        }
        async function poll() {
            try {
                const url = since === null ? '/api/log' : '/api/log?since=' + since;
                const res = await fetch(url);
                const body = await res.json();
                if (body.success) {
                    render(body.data);
                    since = body.latest;
                    statusEl.textContent = 'live';
                    statusEl.className = 'status live';
                }
            } catch (e) {
                statusEl.textContent = 'reconnecting…';
                statusEl.className = 'status stalled';
            }
        }
        poll();
        setInterval(poll, 1500);
    </script>
</body>
</html>`);
});

app.get(/.*/, (req, res) => {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (!fsSync.existsSync(indexPath)) {
        res.send('<h1>MTG Oracle Daemon v4.0 (Bedrock)</h1><p>API is active. Drop your frontend in ./public/index.html</p>');
    } else {
        res.sendFile(indexPath);
    }
});

// ============================================================================
// SECTION 17: BOOTSTRAP & LIFECYCLE
// ============================================================================
async function start() {
    vLog('SYSTEM', 'Starting MTG Oracle Daemon v4.0 (Bedrock) initialization sequence...');
    await ensureDirectories();
    ensureGenericCardBack(); // synchronous, no network — the always-available fallback exists before anything else can run
    initDatabase();
    loadStatsSnapshot(); // restore lifetime counters/timestamps before anything (TUI, API) can display them

    // REGRESSION FIX (this exact bug was fixed once already — a prior edit
    // to this file put `await rehydrateFromBackups()` and other slow work
    // back in front of app.listen(), which is precisely what caused a
    // previously-reported ~15 minute delay before the web UI/API became
    // reachable at all. Restoring the fix: the webserver boots FIRST, full
    // stop, and every genuinely slow step (rehydration, the generic-back
    // photo fetch, self-audit, all sync pipelines) runs afterward in a
    // fire-and-forget background chain that can never block or interfere
    // with it. Every route already has a `!db` guard for the brief window
    // before the DB connection exists, so this is always safe.
    app.listen(PORT, () => {
        vLog('SYSTEM', `Express HTTP Server listening on port ${PORT} — boot-critical path complete, UI is live.`);
    });
    sendToSupervisor({ type: 'ready' });

    (async () => {
        ensureGenericCardBackPhoto().catch((e) => vLog('CACHE_ERR', `Generic card back photo bootstrap failed unexpectedly: ${e.message}`));

        if (stats.cardCount === 0) {
            vLog('BOOT', 'Card table looks empty. Rehydrating from local backup archives in the background (bounded by a timeout so this can never hang anything)...');
            try {
                await withTimeout(rehydrateFromBackups(), BOOT_REHYDRATE_TIMEOUT_MS, 'boot-rehydrate');
            } catch (e) {
                vLog('BOOT_WARN', `Background rehydration did not complete cleanly (${e.message}) — normal sync pipelines will populate the database instead.`);
            }
            updateCounts();
        }

        await runSelfAudit();
        setInterval(() => { runSelfAudit().catch((e) => vLog('AUDIT_ERR', e.message)); }, SELF_HEAL_INTERVAL_MS);

        // Persist cumulative stats periodically so a crash/restart loses at
        // most this interval's worth of counting, not the whole history.
        setInterval(persistStatsSnapshot, STATS_PERSIST_INTERVAL_MS);

        checkMtgJsonSync()
            .then(() => { vLog('SYSTEM', 'Initial MTGJSON check complete.'); startMtgJsonWorker(); })
            .catch((e) => { vLog('MTGJSON_ERR', `Initial sync failed: ${e.message}`); startMtgJsonWorker(); });

        runScryfallBulkSync()
            .then(() => { vLog('SYSTEM', 'Initial Scryfall bulk check complete.'); startScryfallWorker(); })
            .catch((e) => { vLog('SCRYFALL_ERR', `Initial sync failed: ${e.message}`); startScryfallWorker(); });

        startManapoolWorker().catch((e) => vLog('MANAPOOL_ERR', `Worker crashed: ${e.message}`));
        runEnrichmentTrickleWorker().catch((e) => vLog('ENRICH_ERR', `Trickle worker crashed: ${e.message}`));
        startDiskAuditWorker().catch((e) => vLog('DISK_AUDIT_ERR', `Worker crashed: ${e.message}`));

        vLog('SYSTEM', 'All background subsystems (rehydration, audit, MTGJSON/ManaPool/Scryfall sync, enrichment, disk audit) now running.');
    })().catch((err) => {
        auditLog('ERROR', 'BOOT_BACKGROUND_ERR', `Background bootstrap chain hit an unexpected error: ${err.message}`);
    });
}

function gracefulShutdown(reason, intentional) {
    if (shuttingDown) return;
    shuttingDown = true;
    vLog('SYSTEM', `Graceful shutdown initiated (${reason}). Checkpointing database...`);
    if (intentional) sendToSupervisor({ type: 'shutdown-intentional' });

    const hardExitTimer = setTimeout(() => { try { process.exit(0); } catch (e) { /* noop */ } }, 5000);
    if (hardExitTimer.unref) hardExitTimer.unref();

    try {
        if (db) { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); }
    } catch (e) { /* best effort — we're exiting regardless */ }
    clearTimeout(hardExitTimer);
    process.exit(0);
}

/**
 * Behavior change from earlier versions, made possible BY the supervisor
 * (Section 0): rather than logging an uncaught exception/rejection and
 * trying to "carry on" — which is exactly how a previous version hung
 * completely silently after boot (a stream callback threw, killed its own
 * read loop without firing 'error'/'end', and the surrounding Promise hung
 * forever while the process technically stayed "alive") — we now log as
 * loudly as possible, make a best-effort attempt to checkpoint the
 * database, and exit. The supervisor detects the exit within milliseconds
 * and restarts a clean worker automatically. Node's own documentation
 * explicitly recommends NOT resuming normal operation after
 * 'uncaughtException' for exactly this reason: the process is in an
 * undefined state, and pretending otherwise is how invisible hangs happen.
 */
let crashing = false;
function emergencyExit(reason, err) {
    if (crashing) return;
    crashing = true;
    stats.restartNotice = `Recovering from: ${reason} — supervisor will restart automatically.`;
    try { updateUI(); } catch (e) { /* noop */ }
    try { auditLog('CRITICAL', 'SYSTEM_CRITICAL', `${reason}: ${err && err.stack ? err.stack : String(err)}`); } catch (e) { /* noop */ }
    console.error(`[CRITICAL] ${reason}:`, err);
    try { if (db) { db.pragma('wal_checkpoint(PASSIVE)'); db.close(); } } catch (e) { /* best effort */ }
    setTimeout(() => process.exit(1), 300);
}
process.on('uncaughtException', (err) => emergencyExit('Uncaught Exception', err));
process.on('unhandledRejection', (reason) => emergencyExit('Unhandled Rejection', reason));
process.on('SIGINT', () => gracefulShutdown('SIGINT', true));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM', true));

start();