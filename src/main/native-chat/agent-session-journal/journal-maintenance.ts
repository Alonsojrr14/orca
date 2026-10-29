// Retire superseded item revisions and return freed pages in paced background steps.
// User writes never wait on this: each step is one short transaction, and no transaction spans a yield.

import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import type { JournalHostDatabase } from './journal-host-database'

export type JournalMaintenanceDatabase = Pick<
  JournalHostDatabase,
  'readOnly' | 'isClosed' | 'db' | 'transaction'
>

/** An item row whose content can never be current again: a later row carries a higher revision. */
export type JournalSupersededRow = { seq: number; itemId: string }

export type JournalSessionRetirement = (
  db: Database.Database,
  session: { sessionId: string; epoch: string },
  superseded: readonly JournalSupersededRow[]
) => number

export type JournalMaintenanceClock = {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

// Work for one slice, then rest nine times as long: about 10% of one core at most.
const SLICE_MS = 25
const REST_FACTOR = 9
// Rows can be megabytes each; small pages and steps keep every statement and transaction short.
const SHAPE_PAGE_ROWS = 32
const RETIRE_ROWS_PER_STEP = 8
const RECLAIM_PAGES_PER_STEP = 256
const INCREMENTAL_AUTO_VACUUM = 2
const RETIRED_AT_KEY = 'journal_revisions_retired_at'

const LIST_LIVE_EPOCHS = 'SELECT session_id, epoch FROM journal_sessions ORDER BY session_id'
// Bodies are read only for rows being retired. Malformed JSON yields a null version.
const SELECT_ROW_SHAPES = `SELECT seq,
  CASE WHEN json_valid(row_json) THEN row_json ->> '$.v' END AS v,
  CASE WHEN json_valid(row_json) THEN row_json ->> '$.kind' END AS kind,
  CASE WHEN json_valid(row_json) THEN row_json ->> '$.itemId' END AS itemId,
  CASE WHEN json_valid(row_json) THEN row_json ->> '$.revision' END AS revision
FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq > ? ORDER BY seq ASC LIMIT ?`

type RowShape = { seq: number; v: unknown; kind: unknown; itemId: unknown; revision: unknown }

/** Resolve the database again after every rest: the host can close or replace it meanwhile. */
export type JournalMaintenanceRun = {
  database: () => JournalMaintenanceDatabase | null
  clock: JournalMaintenanceClock
  stopped: () => boolean
}

class StopMaintenance extends Error {}

function createPacer(run: JournalMaintenanceRun): () => Promise<JournalMaintenanceDatabase> {
  let sliceStartedAt = run.clock.now()
  const current = (): JournalMaintenanceDatabase => {
    const database = run.database()
    if (run.stopped() || !database || database.readOnly || database.isClosed) {
      throw new StopMaintenance()
    }
    return database
  }
  return async () => {
    const elapsed = run.clock.now() - sliceStartedAt
    if (elapsed >= SLICE_MS) {
      await run.clock.sleep(elapsed * REST_FACTOR)
      sliceStartedAt = run.clock.now()
    }
    return current()
  }
}

/** Scan every live epoch; the completion time only schedules the next pass. */
export async function runJournalRetirementPass(
  run: JournalMaintenanceRun,
  retire: JournalSessionRetirement
): Promise<{ retired: number } | null> {
  const pace = createPacer(run)
  try {
    const sessions = (await pace()).db.prepare(LIST_LIVE_EPOCHS).all() as {
      session_id: string
      epoch: string
    }[]
    let retired = 0
    for (const { session_id: sessionId, epoch } of sessions) {
      retired += await retireSession(pace, { sessionId, epoch }, retire)
    }
    ;(await pace()).db
      .prepare('INSERT OR REPLACE INTO agent_session_store_meta (key, value) VALUES (?, ?)')
      .run(RETIRED_AT_KEY, String(run.clock.now()))
    return { retired }
  } catch (error) {
    if (error instanceof StopMaintenance) {
      return null
    }
    throw error
  }
}

async function retireSession(
  pace: () => Promise<JournalMaintenanceDatabase>,
  session: { sessionId: string; epoch: string },
  retire: JournalSessionRetirement
): Promise<number> {
  // The first row pins the item's position and time, so it stays whole.
  const items = new Map<string, { first: number; current: { seq: number; revision: number } }>()
  let afterSeq = 0
  let retired = 0
  for (;;) {
    const shapes = (await pace()).db
      .prepare(SELECT_ROW_SHAPES)
      .all(session.sessionId, session.epoch, afterSeq, SHAPE_PAGE_ROWS) as RowShape[]
    const superseded: JournalSupersededRow[] = []
    let readable = true
    for (const shape of shapes) {
      // Replay stops applying rows at damage or newer content; never judge rows through it.
      const version = Number(shape.v)
      if (
        !Number.isInteger(version) ||
        version < 1 ||
        version > AGENT_SESSION_JOURNAL_SCHEMA_VERSION
      ) {
        readable = false
        break
      }
      afterSeq = shape.seq
      const revision = Number(shape.revision)
      if (
        shape.kind !== 'item' ||
        typeof shape.itemId !== 'string' ||
        !Number.isInteger(revision)
      ) {
        continue
      }
      const seen = items.get(shape.itemId)
      if (!seen) {
        items.set(shape.itemId, { first: shape.seq, current: { seq: shape.seq, revision } })
      } else if (revision > seen.current.revision) {
        if (seen.current.seq !== seen.first) {
          superseded.push({ seq: seen.current.seq, itemId: shape.itemId })
        }
        seen.current = { seq: shape.seq, revision }
      } else {
        // A revision at or below the current one is stale on replay; its content never shows.
        superseded.push({ seq: shape.seq, itemId: shape.itemId })
      }
    }
    for (let start = 0; start < superseded.length; start += RETIRE_ROWS_PER_STEP) {
      const step = superseded.slice(start, start + RETIRE_ROWS_PER_STEP)
      // Maintenance commits skip FULL fsync: losing one to power loss only leaves rows unretired.
      retired += (await pace()).transaction((db) => retire(db, session, step), true)
    }
    if (!readable || shapes.length < SHAPE_PAGE_ROWS) {
      return retired
    }
  }
}

/** Return free pages to the filesystem in bounded steps until none remain. */
export async function reclaimJournalPages(run: JournalMaintenanceRun): Promise<number> {
  const pace = createPacer(run)
  let reclaimed = 0
  try {
    // Files created before incremental auto_vacuum cannot shrink this way; leave them as they are.
    const mode = Number((await pace()).db.pragma('auto_vacuum', { simple: true }))
    if (mode !== INCREMENTAL_AUTO_VACUUM) {
      return 0
    }
    for (;;) {
      const database = await pace()
      const free = Number(database.db.pragma('freelist_count', { simple: true }) ?? 0)
      if (free === 0) {
        return reclaimed
      }
      const step = Math.min(free, RECLAIM_PAGES_PER_STEP)
      database.transaction((db) => db.pragma(`incremental_vacuum(${step})`), true)
      reclaimed += step
    }
  } catch (error) {
    if (error instanceof StopMaintenance) {
      return reclaimed
    }
    throw error
  }
}

/** Delay until the next pass is due: at least `minDelayMs`, at most one interval. */
export function journalMaintenanceDelay(
  db: Database.Database,
  now: number,
  options: { minDelayMs: number; intervalMs: number }
): number {
  const row = db
    .prepare('SELECT value FROM agent_session_store_meta WHERE key = ?')
    .get(RETIRED_AT_KEY) as { value: string } | undefined
  const retiredAt = Number(row?.value)
  const due = Number.isFinite(retiredAt) ? retiredAt + options.intervalMs - now : 0
  return Math.min(options.intervalMs, Math.max(options.minDelayMs, due))
}

export type JournalMaintenance = { stop: () => void }

/** Each pass retires superseded revisions, then returns freed pages; passes never overlap. */
export function startJournalMaintenance(
  database: () => JournalMaintenanceDatabase | null,
  retire: JournalSessionRetirement,
  options: {
    minDelayMs: number
    intervalMs: number
    onError: (error: unknown) => void
    clock?: JournalMaintenanceClock
  }
): JournalMaintenance {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const clock = options.clock ?? {
    now: () => Date.now(),
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref?.()
      })
  }
  const run: JournalMaintenanceRun = { database, clock, stopped: () => stopped }
  const schedule = (delayMs: number): void => {
    if (stopped) {
      return
    }
    timer = setTimeout(() => {
      void runJournalRetirementPass(run, retire)
        .then(() => reclaimJournalPages(run))
        .catch(options.onError)
        .finally(() => schedule(options.intervalMs))
    }, delayMs)
    timer.unref?.()
  }
  let firstDelayMs = options.minDelayMs
  try {
    const opened = database()
    if (opened && !opened.readOnly && !opened.isClosed) {
      firstDelayMs = journalMaintenanceDelay(opened.db, clock.now(), options)
    }
  } catch (error) {
    options.onError(error)
  }
  schedule(firstDelayMs)
  return {
    stop: () => {
      stopped = true
      if (timer) {
        clearTimeout(timer)
      }
    }
  }
}
