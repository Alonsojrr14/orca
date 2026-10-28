import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { createCodexDispatchEchoes } from '../../codex/codex-structured-dispatch-echo'
import { beginStructuredAgentSessionHandover } from './structured-agent-session-handing-over'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { StructuredAgentSessionJournalProjections } from './structured-agent-session-status-journal-projection'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { createDeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { testEventSinkLogging } from './structured-agent-session-logger-test-support'
import type {
  openJournal as openStatusJournal,
  feedFor as statusFeedFor,
  TURN_IDENTITY as TURN,
  USER_IDENTITY as USER
} from './structured-agent-session-status-feed.test'
import type { indexedStatusFeedSession } from './structured-agent-session-status-feed-test-session'

type Indexed = Parameters<typeof indexedStatusFeedSession>[0]

export function registerStatusFeedRestorationContracts({
  openJournal,
  feedFor,
  directory,
  SESSION,
  TURN_IDENTITY,
  USER_IDENTITY
}: {
  openJournal: typeof openStatusJournal
  feedFor: typeof statusFeedFor
  directory: () => string
  SESSION: string
  TURN_IDENTITY: typeof TURN
  USER_IDENTITY: typeof USER
}): void {
  it('normalizes only restarted requests for quit, crash and legacy handoff, preserving live-provider faults', async () => {
    for (const cause of ['quit', 'crash', 'legacy', 'live'] as const) {
      let journal = await openJournal(`provenance-${cause}`)
      await journal.appendItem(
        TURN_IDENTITY,
        { kind: 'turn', turnId: 'turn-1', state: 'interrupted', startedAt: 100 },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE, fence: 1 }
      )
      const record = { ...agentSessionRecordFixture(), sessionId: `provenance-${cause}` }
      const projection = new StructuredAgentSessionJournalProjections()
      if (cause === 'legacy') {
        record.lease.claimStatus = 'released'
        await journal.close()
        journal = await openJournal(`provenance-${cause}`)
        projection.noteRestart(record.sessionId, {
          interrupted: true,
          openTurn: null,
          lastSequence: 1,
          lastSavedAt: 100
        })
      }
      if (cause === 'quit' || cause === 'crash') {
        record.lease.deathEvidence = {
          kind: 'pid-absent',
          detail: 'gone',
          observedAt: 100,
          runtimeEnd: cause
        }
      }
      expect(
        projection.read(journal, agentSessionConversationView(record)).state.summary.turnOutcome
      ).toBe(cause === 'live' ? 'interruption' : 'cancellation')
      expect(readAgentJournalTurn(journal.snapshot().items[0]?.body)?.outcome).toBeUndefined()
      await journal.appendItem(
        { ...TURN_IDENTITY, turnId: 'new-turn' },
        { kind: 'turn', turnId: 'new-turn', state: 'completed', outcome: 'success' },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE, fence: 2 }
      )
      expect(
        projection.read(journal, agentSessionConversationView(record)).state.summary.turnOutcome
      ).toBe('success')
      record.lease.deathEvidence = null
      record.lease.claimStatus = 'live'
      await journal.appendItem(
        { ...TURN_IDENTITY, turnId: 'live-fault' },
        { kind: 'turn', turnId: 'live-fault', state: 'interrupted' },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE, fence: 2 }
      )
      expect(
        projection.read(journal, agentSessionConversationView(record)).state.summary.turnOutcome
      ).toBe('interruption')
    }
  })

  it.each([false, true])(
    'keeps saved public cut=%s through open, repair and eviction on both consumers',
    async (cut) => {
      let journal = await openJournal(SESSION, () => 100)
      await journal.appendItem(
        TURN_IDENTITY,
        { kind: 'turn', turnId: 'turn-1', state: cut ? 'completed' : 'running', startedAt: 100 },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE, fence: 1 }
      )
      await journal.close()
      const database = openTestJournalHostDatabase(join(directory(), SESSION))
      database.db
        .prepare(
          'UPDATE journal_sessions SET open_turn_id = ?, open_turn_since = ? WHERE session_id = ?'
        )
        .run(cut ? 'retained-cut' : null, cut ? 100 : 0, SESSION)
      const record = agentSessionRecordFixture()
      record.sessionId = SESSION
      record.lease.claimStatus = 'released'
      const sessions = new Map<string, Indexed>()
      const published: AgentSessionStatusSummary[] = []
      const { feed, events } = feedFor(sessions, record, undefined, undefined, {
        publish: (summary) => published.push(summary),
        forget: vi.fn()
      })
      feed.publishAtRest(SESSION, {
        interrupted: cut,
        known: true,
        openTurn: cut ? { itemId: 'retained-cut', since: 100 } : null,
        lastSequence: 2,
        lastSavedAt: 100
      })
      const expected = {
        status: 'idle',
        statusStartedAt: 100,
        ...(cut ? { turnOutcome: 'cancellation', restoredInterruption: true } : {})
      }
      const check = () => {
        expect(published.at(-1)).toMatchObject(expected)
        expect(events.at(-1)).toMatchObject({ type: 'status', session: expected })
        expect(published.at(-1)?.restoredInterruption).toBe(cut ? true : undefined)
      }
      check()
      journal = await openJournal(SESSION, () => 999)
      sessions.set(SESSION, { journal })
      feed.publish(SESSION, journal)
      check()
      await journal.appendItem(
        { ...USER_IDENTITY, ordinal: 2 },
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'hygiene' }] },
        { turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(TURN_IDENTITY) }, fence: 2 }
      )
      feed.publish(SESSION, journal)
      check()
      await journal.close()
      sessions.delete(SESSION)
      journal = await openJournal(SESSION, () => 2000)
      sessions.set(SESSION, { journal })
      feed.publish(SESSION, journal)
      check()
      record.lease.claimStatus = 'live'
      record.lease.runtimeFence = 3
      sessions.set(SESSION, { journal, child: { phase: 'ready', generation: 'new', fence: 3 } })
      await journal.appendItem(
        { ...TURN_IDENTITY, turnId: 'genuine-new' },
        { kind: 'turn', turnId: 'genuine-new', state: 'running', startedAt: 2000 },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE, fence: 3 }
      )
      feed.publish(SESSION, journal)
      expect(published.at(-1)).toMatchObject({ status: 'working' })
      expect(published.at(-1)?.restoredInterruption).toBeUndefined()
    }
  )

  it('persists exact raw held IDs through reversible Codex activity and overlapping host handovers', async () => {
    const journal = await openJournal(SESSION, () => 100)
    const ids = ['a\nb', 'a', 'b']
    for (const clientMessageId of ids) {
      await journal.appendSubmission({
        clientMessageId,
        body: { kind: 'message', role: 'user', blocks: [] },
        payloadFingerprint: clientMessageId,
        fence: 1
      })
    }
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    deferred.bind({ journal, fence: 1, publish: vi.fn() })
    const echoes = createCodexDispatchEchoes((changes) => {
      expect(feed.publishHeldSends(SESSION, changes, deferred.sink).accepted).toBe(true)
    })
    const session = {
      journal,
      child: {
        phase: 'ready' as const,
        generation: 'held-owner',
        fence: 1,
        heldSends: echoes.heldSends
      }
    }
    const { feed } = feedFor(new Map([[SESSION, session]]))
    for (const id of ids) {
      expect(echoes.arm(id, 100)).toBe(true)
    }
    const released = () => feed.handoverChanged(SESSION, ids[0])
    const first = beginStructuredAgentSessionHandover(journal, ids[0], released)
    const second = beginStructuredAgentSessionHandover(journal, ids[0], released)
    for (const id of ids) {
      echoes.answered(id, echoes.tick())
    }
    await deferred.drained()
    const work = () =>
      journal.snapshot().items.flatMap(({ body }) => (body.kind === 'semantic-work' ? [body] : []))
    expect(work()).toHaveLength(3)
    expect(
      work().find(({ source }) => source.kind === 'submission' && source.clientMessageId === ids[0])
    ).toMatchObject({ startedAt: 100, phase: 'open' })
    first()
    first()
    await deferred.drained()
    expect(journal.restFact()).not.toBeNull()
    second()
    await deferred.drained()
    expect(journal.restFact()).toBeNull()
    echoes.observeStatus(true)
    const rehold = [false, true].map((held) => ({ clientMessageId: ids[0], held }))
    expect(feed.publishHeldSends(SESSION, rehold, deferred.sink)).toEqual({ accepted: true })
    await deferred.drained()
    await expect(deferred.sink.written?.()).resolves.toEqual({ ok: true })
    expect(work().map(({ phase }) => phase)).toEqual(['open', 'open', 'open'])
    expect(
      work().map(({ source }) => source.kind === 'submission' && source.clientMessageId)
    ).toEqual(ids)
    echoes.observeStatus(false)
    await deferred.drained()
    expect(journal.restFact()).toBeNull()
    expect(work().every(({ phase, startedAt }) => phase === 'settled' && startedAt === 100)).toBe(
      true
    )
    deferred.close()
  })
}
