import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  liveTestJournalRows,
  loadTestJournal,
  openTestJournalHostDatabase,
  updateTestJournalRowJson
} from './journal-host-database-test-support'
import {
  journalMaintenanceDelay,
  reclaimJournalPages,
  runJournalRetirementPass,
  type JournalMaintenanceRun
} from './journal-maintenance'
import { boundPayload, JOURNAL_RUNNING_PREVIEW_LIMITS } from './journal-payload-bounds'
import { renderJournalState } from './journal-reducer'
import { retireSupersededJournalRevisions } from './journal-revision-retirement'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
const OPTIONS = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function reply(text: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
}

describe('journal maintenance', () => {
  let root: string
  let clock = 1_000
  let stopped = false
  const journals = createTrackedJournalOpener()

  const open = () =>
    journals.open({
      identity: IDENTITY,
      stateDirectory: root,
      now: () => ++clock,
      mintEpoch: () => `epoch-${clock}`
    })
  const run = (): JournalMaintenanceRun => ({
    database: () => openTestJournalHostDatabase(root),
    clock: { now: () => clock, sleep: async () => undefined },
    stopped: () => stopped
  })
  const replayed = () => {
    const loaded = loadTestJournal(root, IDENTITY.sessionId)
    if (!loaded) {
      throw new Error('no journal')
    }
    const { state } = loaded
    return {
      damage: loaded.damage,
      snapshot: renderJournalState(state),
      providerActivityAt: [...state.providerActivityAt],
      executionOwners: [...state.itemExecutionOwners],
      lastActivityAt: state.lastActivityAt
    }
  }
  const storedBytes = () =>
    liveTestJournalRows(openTestJournalHostDatabase(root).db, IDENTITY.sessionId).reduce(
      (total, row) => total + Buffer.byteLength(row.rowJson),
      0
    )

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-maintenance-'))
    clock = 1_000
    stopped = false
  })

  afterEach(async () => {
    await journals.closeAll()
    closeTestJournalHostDatabases()
    await rm(root, { recursive: true, force: true })
  })

  it('keeps replay identical while dropping superseded copies and returning their pages', async () => {
    const journal = await open()
    const words = 'streamed reply text '.repeat(1_000)
    await journal.appendItem(
      item(0),
      {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'question' }]
      },
      OPTIONS
    )
    for (let step = 1; step <= 100; step += 1) {
      await journal.appendItem(item(1), reply(words.slice(0, step * 200)), OPTIONS)
      await journal.appendItem(
        item(2),
        {
          kind: 'tool-call',
          name: 'Bash',
          state: 'running',
          input: { command: 'build' },
          output: boundPayload('log line\n'.repeat(step * 40), JOURNAL_RUNNING_PREVIEW_LIMITS)
        },
        OPTIONS
      )
    }
    await journal.appendItem(
      item(2),
      { kind: 'tool-call', name: 'Bash', state: 'completed', endedAs: 'completed' },
      OPTIONS
    )
    const before = replayed()
    const finalBytes = Buffer.byteLength(words.slice(0, 100 * 200))
    expect(storedBytes()).toBeGreaterThan(20 * finalBytes)

    expect((await runJournalRetirementPass(run(), retireSupersededJournalRevisions))?.retired).toBe(
      197
    )

    expect(replayed()).toEqual(before)
    // One whole reply plus the first and latest running previews, and small envelopes.
    expect(storedBytes()).toBeLessThan(2 * finalBytes)
    const { db } = openTestJournalHostDatabase(root)
    const pagesBefore = Number(db.pragma('page_count', { simple: true }))
    expect(await reclaimJournalPages(run())).toBeGreaterThan(0)
    expect(Number(db.pragma('freelist_count', { simple: true }))).toBe(0)
    expect(Number(db.pragma('page_count', { simple: true }))).toBeLessThan(pagesBefore)
    expect(replayed()).toEqual(before)
  })

  it('never blanks the authoritative revision when revisions arrive out of order', async () => {
    const journal = await open()
    for (const text of ['one', 'two', 'three', 'four']) {
      await journal.appendItem(item(1), reply(text), OPTIONS)
    }
    const { db } = openTestJournalHostDatabase(root)
    const rows = liveTestJournalRows(db, IDENTITY.sessionId).filter((row) =>
      row.rowJson.includes('"kind":"item"')
    )
    // Swap the last two revisions: the row saved third becomes the one replay shows.
    const third = JSON.parse(rows[2].rowJson)
    const fourth = JSON.parse(rows[3].rowJson)
    ;[third.revision, fourth.revision] = [fourth.revision, third.revision]
    updateTestJournalRowJson(db, IDENTITY.sessionId, third.seq, JSON.stringify(third))
    updateTestJournalRowJson(db, IDENTITY.sessionId, fourth.seq, JSON.stringify(fourth))
    const before = replayed()
    expect(before.snapshot.items.at(-1)?.body).toEqual(reply('three'))

    await runJournalRetirementPass(run(), retireSupersededJournalRevisions)

    expect(replayed()).toEqual(before)
  })

  it('leaves damaged rows and everything after them untouched', async () => {
    const journal = await open()
    for (const text of ['one', 'two', 'three', 'four', 'five']) {
      await journal.appendItem(item(1), reply(text), OPTIONS)
    }
    const { db } = openTestJournalHostDatabase(root)
    const rows = liveTestJournalRows(db, IDENTITY.sessionId)
    const damaged = rows.at(-2)
    if (!damaged) {
      throw new Error('missing rows')
    }
    updateTestJournalRowJson(db, IDENTITY.sessionId, damaged.seq, '{"v":1,')
    const untouched = liveTestJournalRows(db, IDENTITY.sessionId).slice(-3)

    await runJournalRetirementPass(run(), retireSupersededJournalRevisions)

    expect(liveTestJournalRows(db, IDENTITY.sessionId).slice(-3)).toEqual(untouched)
  })

  it('records completion only for a finished pass and schedules from it', async () => {
    const journal = await open()
    for (const text of ['one', 'two', 'three']) {
      await journal.appendItem(item(1), reply(text), OPTIONS)
    }
    const { db } = openTestJournalHostDatabase(root)
    const timing = { minDelayMs: 60_000, intervalMs: 6 * 60 * 60_000 }
    stopped = true
    expect(await runJournalRetirementPass(run(), retireSupersededJournalRevisions)).toBeNull()
    expect(journalMaintenanceDelay(db, clock, timing)).toBe(60_000)

    stopped = false
    await runJournalRetirementPass(run(), retireSupersededJournalRevisions)
    expect(journalMaintenanceDelay(db, clock + 60 * 60_000, timing)).toBe(5 * 60 * 60_000)
  })
})
