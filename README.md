# MTG Oracle Daemon v4.0 — "Bedrock" Edition

> **A single-file, self-healing, self-sustaining Magic: The Gathering card database, price-history cache, and image proxy.** Designed to be run once and forgotten: `node server.js` populates itself, keeps itself in sync, and repairs itself indefinitely across crashes, power outages, corrupt downloads, or partial writes.

---

## 🌟 Overview & Philosophy

Managing local Magic: The Gathering data historically requires brittle scripts, multi-service docker-compose stacks, or manual database management. **MTG Oracle Daemon** condenses an entire MTG data infrastructure into a single, zero-dependency Node.js file backed by SQLite, featuring:
- **Zero-Touch Resilience:** A bulletproof supervisor/worker split that automatically detects hangs or crashes and restarts with exponential backoff.
- **Atomic Pipelines:** Every download uses `.part` temporary files, content-length checks, and SHA256 verification before atomic renaming.
- **Hot Snapshots & Cascading Rollbacks:** All bulk mutations are guarded by an async mutex and snapshot ring. If anything fails, it automatically rolls back or cascades through historical backups.
- **Advanced Search API:** Full Scryfall query syntax support with custom SQLite scalar functions (`MANA_MATCH`), FTS5 prefix search, and smart relevance ranking.
- **Interactive TUI Dashboard:** A real-time Blessed TUI tracking system stats, CPU load, active stream progress, and live HTTP request rates.
- **Double-Faced Card & Image Caching:** Disk caching keyed by `(scryfall_id, type, face)` with background preloading for all sizes and faces.

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
git clone https://github.com/your-username/mtg-oracle-daemon.git
cd mtg-oracle-daemon

# Install dependencies
npm install

# Run the daemon (launches supervisor, TUI, and Express server on port 3000)
node server.js
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
