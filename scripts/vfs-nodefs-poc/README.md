# node:fs VFS proof of concept

E1 of the NexusVfsNodeFs initiative. It answers one question: can a VFS backed by
`node:fs`, mounted through the public `sqlite3.vfs.installVfs` API, replace the
whole-database `sqlite3_js_db_export()` that the cache persists on every autosave?

The harness is throwaway. It is kept here for reproducibility, not as a build step.

## Run it

```
node scripts/vfs-nodefs-poc/poc.mjs     # acceptance run: builds a 99 MB database, measures, verifies
node scripts/vfs-nodefs-poc/curva.mjs   # amplification curve from 1 to 24,000 rows in one transaction
node scripts/vfs-nodefs-poc/probe.mjs   # environment probe: which VFS the build ships, what OPFS needs
```

Requires the repo's `node_modules` to be reachable from this directory —
`@dao-xyz/sqlite3-vec` is resolved with `createRequire`, so a plain `npm install`
at the repo root is enough. In a git worktree, symlink `node_modules` to the main
clone's.

## Why env-shim.mjs exists

The shipped `sqlite3.wasm` is built with `-sENVIRONMENT=web,worker` and **aborts**
when it detects Node: `node environment detected but not enabled at build time`.
The detection is literally

```
ENVIRONMENT_IS_WEB  = typeof window == 'object'
ENVIRONMENT_IS_NODE = typeof process == 'object' && process.versions?.node
                      && process.type != 'renderer'
```

An Electron renderer satisfies both conditions we need — `window` exists and
`process.type === 'renderer'` — which is why the plugin loads the module there
without a patch. `env-shim.mjs` reproduces exactly that pair and nothing else; it
does not emulate a DOM. Any Node-side test of this WASM build needs it.

## What the run shows

On a 99,328,000-byte database (24,000 rows, `page_size` 4096), a single-row
transaction — the equivalent of one reindexed note — writes 20,508 bytes across
10 `xWrite` calls and 2 fsyncs, against 99,328,000 bytes for the integral export.
`integrity_check` is `ok` with the database open and `ok` again after closing and
reopening from disk; the system `sqlite3` reads the same file. The byte counts come
from counters inside `xWrite` itself, not from an estimate.

The crossover is between 5,000 and 24,000 rows in a single transaction, because the
rollback journal writes every page twice. Only a full rebuild favours the integral
export, and that path already exists as `recreateCorruptedDatabase`.

## What it does NOT prove

- It has not run inside Obsidian. Validating `installVfs` in the real Electron
  renderer is E3's job.
- Locking is a declared no-op. This serves a single process only.
- No WAL: there is no `xShm*` method here.
- No failure testing: full disk, partial write, crash mid-commit are all untested.
- The schema is synthetic — one table, one index — though at the same order of
  magnitude and the same `page_size` as the real cache.
