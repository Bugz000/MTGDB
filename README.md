# MTGDB

> **A single-file, self-healing, self-sustaining Magic: The Gathering card database, price-history cache, and image cache + proxy.** Designed to be run once and forgotten: `node server.js` populates itself, keeps itself in sync, and repairs itself indefinitely across crashes, power outages, corrupt downloads, partial writes and updates.

---

## Real Talk
Yes this is AI slop, i am putting very little actual effort into it (yet)- though it is formed by merging 3 seperate projects i was making by hand - as they all solved basically the same thing
I do not collaborate well, so collaborating with an AI is a solution for me, because i'm just one guy - i can't make the whole world, and databases are one of my weakest fields in computing
HOWEVER this does not mean you cannot contribute, i welcome all contributions, just know i am well aware this is AI, there is many things wrong with it, use at your own risk, don't expect miracles, blahblah honestly if i have to explain this much to you, this project isn't for you :)
i WILL however be slowly migrating this to a hand maintained copy in good time - once all my desired core features are in place, i only put it on github once i have been running it myself for a few days and it's been working quite well 

lots of things to fix, lots of things to implement, but at least things can be tracked here

the core principle is one file, (any attempts at splitting this to multiple files will be rejected) (frontend is OPTIONAL); and one command to boot, and you have yourself a home hosted MTG api - can't get easier than this 
Ease of use is my number one policy.
just node server.js, 15 minutes later you have a fully populated MTG database/api you can use and abuse all you like, no rate limits here!

As of uploading the repository - it IS WORKING, though specific api endpoints and usage may change over time 
it is NOT intended for public facing, this is special, just for you <3 

though WORKING, i am also still WORKING ON IT - it has many issues, it is in a USABLE state, but it is by no means set-and-forget quite yet
i'd check for updates at least once a week, ideally once every day or two

feel free to fork this project, do what you want with it, i dont care
though centralisation and collaboration into a single effort would be beneficial, in my opinion

There is a TUI that shows some stats, a functional webUI akin to scryfalls own to serve primary as a data inspector and a quick lookup tool, and ofcourse, an API accessible over http get/post requests, 

> UPCOMING features
- full scryfall style searching (Extended beyond scryfall's own search)
- per-field indexing, so you can either dump all card info, or target a VERY specific field for faster lookups, though it should be instant in all cases
- user tables, so you can import manabox lists, scryfall lists, the rest, you can have a WANTED list, a HAVEs list, whatever you need, infinite decks, whole collection, whatever; the database will store it all 
- further afield? TBD ~ ~ 

i will let AI continue from here;

## 🌟 Overview & Philosophy

Managing local Magic: The Gathering data historically requires brittle scripts, multi-service docker-compose stacks, or manual database management. **MTGDB** condenses an entire MTG data infrastructure into a single, zero-dependency Node.js file backed by SQLite, featuring:
- **Zero-Touch Resilience:** A bulletproof supervisor/worker split that automatically detects hangs or crashes and restarts with exponential backoff.
- **Atomic Pipelines:** Every download uses `.part` temporary files, content-length checks, and SHA256 verification before atomic renaming.
- **Hot Snapshots & Cascading Rollbacks:** All bulk mutations are guarded by an async mutex and snapshot ring. If anything fails, it automatically rolls back or cascades through historical backups.
- **Advanced Search API:** Full Scryfall query syntax support with custom SQLite scalar functions (`MANA_MATCH`), FTS5 prefix search, and smart relevance ranking.
- **Interactive TUI Dashboard:** A real-time Blessed TUI tracking system stats, CPU load, active stream progress, and live HTTP request rates.
- **Double-Faced Card & Image Caching:** Disk caching keyed by `(scryfall_id, type, face)` with background preloading for all sizes and faces.

---

## 📺 Demo

[![MTGDB Demo Preview](https://i.postimg.cc/wjtmT7Yb/demo.png)](https://youtu.be/Hc5C4GahXds)

> 🎥 **[Watch it in Action](https://youtu.be/Hc5C4GahXds)**


---

## 📦 Data Sources

The daemon aggregates and cross-references data from four primary canonical sources:
1. **MTGJSON (`AllPrintings.json`)**: Canonical multi-source card sets, basic metadata, and paper pricing history (TCGPlayer / Card Kingdom).
2. **ManaPool (`singles.json.gz`)**: Rolling recent-sales transaction history and live vendor listing data. Archived uncompressed daily before parsing.
3. **Scryfall Bulk Data (`default-cards.jsonl.gz`)**: Comprehensive oracle text, rulings, legalities, color identities, mana costs, and artwork identifiers.
4. **Scryfall Tagger (`oracle_tags` & `art_tags`)**: Official tagger datasets joined at query time by `oracle_id` and `illustration_id`.

---

## 🛡️ Resilience Architecture

```
 ┌─────────────────────────────────────────────────────────┐
 │               SUPERVISOR PROCESS (PID 1)                │
 │    - Heartbeat Watchdog (60s timeout / Boot Grace)      │
 │    - Exponential Backoff Auto-Restart & IPC Monitor     │
 └────────────────────────────┬────────────────────────────┘
                              │ forks
 ┌────────────────────────────▼────────────────────────────┐
 │                WORKER DAEMON (server.js)                │
 │  ┌──────────────────┐  ┌─────────────────────────────┐  │
 │  │ Express REST API │  │ Blessed TUI Live Dashboard  │  │
 │  └────────┬─────────┘  └──────────────┬──────────────┘  │
 │           │                           │                 │
 │           └─────────────┬─────────────┘                 │
 │                         ▼                               │
 │             AsyncMutex & Snapshot Guard                 │
 │           (WAL Mode SQLite + FTS5 Engine)               │
 └─────────────────────────────────────────────────────────┘
```

1. **Supervisor / Worker Split:** The supervisor process monitors worker heartbeats every 10 seconds. If the worker freezes or crashes, it force-kills and restarts with backoff.
2. **Stream Exception Shielding:** Every stream chunk/line callback is wrapped in try/catch to prevent malformed remote records from killing internal stream read loops.
3. **Database Guardrails:** A global `AsyncMutex` serializes heavy write pipelines while allowing concurrent HTTP reads. Every bulk mutation takes a hot database snapshot; failures trigger automatic rollbacks.
4. **Import Completeness Audits:** Post-ingest row counts are validated against raw archive files to detect partial drops or silent parser aborts, triggering automatic archive re-parsing when necessary.

---

## 🚀 Quick Start

### Prerequisites
- **Node.js** v18+ (v20+ recommended)
- **npm**

### Installation & Execution
```bash
# Clone the repository
git clone https://github.com/Bugz000/MTGDB.git
cd MTGDB

# Install dependencies
npm install

# Run the daemon (launches supervisor, TUI, and Express server on port 3000)
node server.js
# wait aprx 15 minutes for data population, but it should come up pretty quickly after that
# Enjoy
```

> **Headless Mode:** To run without the interactive TUI (e.g., inside Docker or systemd), set `MTG_HEADLESS=1`:
> ```bash
> MTG_HEADLESS=1 node server.js
> ```

---

## ⌨️ TUI Keyboard Shortcuts

When running in interactive mode, use the following keys in your terminal:
- `q` or `Ctrl+C`: Gracefully shut down the daemon
- `s`: Trigger manual Scryfall bulk resync
- `r`: Trigger manual MTGJSON resync
- `m`: Trigger manual ManaPool resync
- `h`: Trigger manual database self-heal audit
- `e`: Trigger manual Scryfall enrichment trickle
- `b`: Restore database from the best available snapshot

---

## 🔌 REST API Endpoints

| Endpoint | Method | Description |
| :--- | :---: | :--- |
| `/api/search?q=...` | `GET` | Search cards using Scryfall-compatible syntax with relevance ranking & pagination |
| `/api/cards/:id` | `GET` | Retrieve complete unified card record (MTGJSON + Scryfall + ManaPool sales) |
| `/cache/:id/:type.jpg` | `GET` | Serve cached card image (supports `?face=back` for double-faced cards) |
| `/api/stats` | `GET` | Live daemon metrics, cache hit/miss ratios, and queue depths |

---

## 📁 Project Structure

```
├── server.js               # Unified daemon (Supervisor, TUI, Express API, Ingest, DB)
├── cache/                  # Runtime database and disk caches
│   ├── cards.db            # SQLite database (WAL mode)
│   └── images/             # Cached card art JPEGs
├── backup/                 # Raw source archives and hot snapshots
│   ├── MTGJSON/
│   ├── ManaPool/
│   ├── Scryfall/
│   └── snapshots/          # Bounded rolling backup snapshots (.db.bak)
└── public/                 # Static frontend assets
```

---

## 📝 License

Distributed under the MIT License. See `LICENSE` for more information.
