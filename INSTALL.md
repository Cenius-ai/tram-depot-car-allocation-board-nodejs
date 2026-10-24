# Installing Tram Depot — Car Allocation Board

This document is the source of truth for getting the app running from a fresh
checkout. The only package manager used is **npm** (the project ships no runtime
dependencies; npm is run for the manifest and its lockfile). There is one project,
at the repository root — nothing to install in a sub-directory.

## Prerequisites (installed by you, not by the scripts)

| Requirement | Why | Check |
| --- | --- | --- |
| Node.js **20 or newer** | the server uses `node:http`, `node:crypto` and the built-in test runner | `node --version` |
| npm | `install.sh` runs `npm install` | `npm --version` |
| A POSIX shell | `install.sh` is a bash script | `bash --version` |

No database server, no compiler toolchain, no Python, no external service and no
network access is needed at runtime.

## 1. Install dependencies

```bash
sh install.sh
```

`install.sh` (run it as an unprivileged user, from any directory — it `cd`s to the
project root):

1. refuses to continue unless Node.js 20+ is present,
2. runs `npm install --no-audit --no-fund`,
3. creates and seeds `data/db.json` if it does not exist (idempotent — re-running
   never duplicates rows),
4. prints the demo credential and **exits**. It never starts the web server.

If you prefer to do it by hand:

```bash
npm install
node -e 'require("./main.js").loadStore()'   # creates + seeds data/db.json
```

## 2. Seed the demo data

Seeding happens automatically in step 1 and, on any boot, whenever the store file is
missing or has no allocations for the current day. The seed writes:

- 4 staff (including the demo account `cenius@cenius.ai` / `cenius`),
- 6 routes and 3 shifts (Early, Late, Night),
- 10 tram cars and 12 siding slots across tracks A, B and C,
- today's Early and Late allocations,
- 3 pantograph notices whose readings match the cars' `pantographMm` values.

Reset by deleting `data/db.json` and starting the app again.

## 3. Run

```bash
node main.js
```

The server prints the bound address, the store path and the demo credential:

```
[tram-depot] listening on http://0.0.0.0:3000
[tram-depot] store: /path/to/data/db.json
[tram-depot] demo account — email: cenius@cenius.ai  password: cenius
```

Open `http://localhost:3000`, sign in with `cenius@cenius.ai` / `cenius`.

Environment (all optional, `.env` in the project root is read if present):

| Variable | Default |
| --- | --- |
| `PORT` | `3000` |
| `HOST` | `0.0.0.0` |
| `DB_PATH` | `./data/db.json` |

## 4. Test

```bash
npm test
```

Runs `node --test test/smoke.mjs`. The suite starts the real server on a free port
with a temporary store and exercises: first-boot seeding, the demo login and its
`HttpOnly` cookie, the session probe, reference data, the dashboard aggregation,
allocation create/patch/delete with duplicate validation, notice validation (severity
enum and the 0–60 mm range) plus the wear write-through, siding occupancy conflicts,
the signed-out 401 gate, static asset delivery and a restart on a later day.

## Deploying

- Run `node main.js` under any process supervisor; the app needs one process and one
  port. Set `PORT`/`HOST` from the environment and put it behind TLS at the edge.
- Sessions are in memory, so a restart signs every user out and a multi-instance
  deployment would need sticky sessions. This is documented in the README.
- Remove or replace the demo account (`cenius@cenius.ai`) before a production
  deployment: delete `data/db.json` and start with a store of your own.
