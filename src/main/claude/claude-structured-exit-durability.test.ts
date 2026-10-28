import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionSemanticWork } from '../../shared/agent-session-semantic-work'
import {
  agentSessionRecordFixture,
  agentSessionLeaseFixture
} from '../../shared/agent-session-record.test-fixture'
import {
  seedTestAgentSessionRecordStore,
  openTestAgentSessionRecordStore
} from '../runtime/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../runtime/structured-claude-runtime-adapter'
import { settleStructuredAgentSessionChildExit } from '../native-chat/agent-session-wire/structured-agent-session-child-exit'
import {
  recordingStructuredAgentSessionLogger,
  testEventSinkLogging
} from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabases
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { StructuredAgentSessionStatusOwnership } from '../native-chat/agent-session-wire/structured-agent-session-status-ownership'
import type { StructuredAgentSessionChildWorkProducer } from '../native-chat/agent-session-wire/structured-agent-session-subagent-rows'
import type { ChildWorkAdmission } from '../native-chat/agent-session-wire/structured-agent-session-accepted-child-work'
import { MOVED_TO_BACKGROUND } from './claude-captured-task-frames.test-fixture'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'
import type { ClaudeStructuredSessionEvent } from './structured/claude-structured-session-state'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-exit-durable-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

it.each([
  'open',
  'closed',
  'failed',
  'failure-after-admission',
  'notify-closed',
  'notify-failed',
  'notify-pressure',
  'semantic-pressure',
  'pressure-closed'
] as const)(
  'delivers the original generation exit once with an honest %s producer outcome',
  async (mode) => {
    const database = openTestJournalHostDatabase(root)
    const journal = await openAgentSessionJournal({
      identity: identityFor(),
      database,
      now: () => 100
    })
    await seedTestAgentSessionRecordStore(root, {
      records: [
        agentSessionRecordFixture(
          agentSessionLeaseFixture({
            sessionId: 'session-1',
            runtimeFence: 6,
            claimStatus: 'released',
            unreconciled: false,
            ownerProcess: null,
            reservedSpawnToken: null
          })
        )
      ]
    })
    const store = await openTestAgentSessionRecordStore(root)
    await store.reconcileOnRestart({
      now: 1_700_000_000_500,
      probe: async () => ({ outcome: 'reservation-unused' })
    })
    await store.reserveOwner({
      sessionId: 'session-1',
      location: identityLocation(),
      provider: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/user/.claude' },
      expectedFence: 6,
      spawnToken: 'spawn',
      claimKeyId: 'key-1',
      handoffOperationId: null,
      probe: { outcome: 'reservation-unused' },
      operation: {
        callerKey: 'test',
        operationId: '1700000000500-00000000000000000000000000000001',
        fingerprint: 'create'
      },
      now: 1_700_000_000_500
    })
    const failures = vi.fn()
    const producer = createDeferredStructuredAgentSessionEventSink({
      ...testEventSinkLogging('session-1'),
      onFailed: failures,
      watermarks: { maxQueuedOperations: 16, maxLifecycleQueuedOperations: 16 }
    })
    producer.bind({ journal, fence: 7, publish: vi.fn() })
    const owner = new StructuredAgentSessionStatusOwnership(() => undefined)
    const events: ClaudeStructuredSessionEvent[] = []
    const exitWork: AgentSessionSemanticWork[][] = []
    const publicationOrder: string[] = []
    vi.spyOn(events, 'push').mockImplementation((event) => {
      if (event.type === 'ended') {
        publicationOrder.push('ended')
        const saved: AgentSessionSemanticWork[] = []
        journal.visitItems((_id, _sequence, body) => {
          if (body.kind === 'semantic-work') {
            saved.push(body)
          }
        })
        exitWork.push(saved)
      }
      return Array.prototype.push.call(events, event)
    })
    const admissions: ChildWorkAdmission[] = []
    let original: StructuredAgentSessionChildWorkProducer | undefined
    let failAfterAdmission = false
    let exiting = false
    let pressured = false
    const append = producer.sink.tryAppendTransition!
    const fill = (lifecycle: boolean) => {
      for (let i = 0; i < 16; i++) {
        append({ steps: [], lifecycle, publish: false })
      }
    }
    vi.spyOn(producer.sink, 'tryAppendTransition').mockImplementation((transition) => {
      if (exiting && transition.steps.length === 0 && !transition.publish) {
        if (mode === 'notify-closed') {
          producer.close()
        } else if (mode === 'notify-failed') {
          void journal.close()
        } else if (mode === 'notify-pressure' && !pressured) {
          pressured = true
          fill(false)
        }
      }
      const result = append(transition)
      if (exiting && mode === 'open' && transition.steps.length === 0 && !transition.publish) {
        void journal.readInOrder(() => publicationOrder.push('following-read'))
      }
      return result
    })
    const claude = fakeClaude()
    const failSql = () =>
      database.db.exec(
        "CREATE TEMP TRIGGER refuse_exit BEFORE INSERT ON journal_rows BEGIN SELECT RAISE(ABORT, 'exit SQL refusal'); END"
      )
    const adapter = adapterFor(
      claude,
      {},
      events,
      [],
      undefined,
      undefined,
      (_id, evidence, writer) => {
        original = writer
        if (failAfterAdmission) {
          failAfterAdmission = false
          failSql()
        }
        if (exiting && (mode === 'semantic-pressure' || mode === 'pressure-closed') && !pressured) {
          pressured = true
          fill(true)
          if (mode === 'pressure-closed') {
            queueMicrotask(() => producer.close())
          }
        }
        const admission = owner.publishChildWork('session-1', evidence, 'claude', writer, {
          journal,
          scope: () => AGENT_JOURNAL_THREAD_SCOPE
        })
        admissions.push(admission)
        return admission
      }
    )
    const acquisition = await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn',
      events: producer.sink
    })
    await producer.drained()
    const firstTask = MOVED_TO_BACKGROUND.findIndex(({ frame }) => frame.subtype === 'task_updated')
    expect(firstTask).toBeGreaterThanOrEqual(0)
    for (const { frame } of MOVED_TO_BACKGROUND.slice(0, firstTask + 1)) {
      claude.connections[0].handlers.onMessage?.({ ...frame, session_id: PROVIDER_SESSION_ID })
      await producer.drained()
    }
    await producer.drained()
    expect(owner.childWorkOpen('session-1')).toBe(true)
    await expect(original?.written?.()).resolves.toEqual({ ok: true })
    await store.commitProcessIdentity({
      sessionId: 'session-1',
      fence: 7,
      process: acquisition.process,
      now: 1_700_000_000_500
    })
    await store.proveOwner({
      sessionId: 'session-1',
      fence: 7,
      link: acquisition.link,
      now: 1_700_000_000_500
    })
    const child = {
      generation: acquisition.acquisitionGeneration,
      fence: 7,
      phase: 'ready' as const
    }
    const session: { journal: typeof journal; child: typeof child | null } = { journal, child }
    const generationEnded = vi.fn()
    const hostLog = recordingStructuredAgentSessionLogger()
    const context = {
      store,
      sessions: new Map([['session-1', session]]),
      flushLifecycle: () => producer.sink.written!(),
      generationEnded,
      serialize: async <T>(_id: string, task: () => Promise<T>) => task(),
      now: () => 1_700_000_000_500,
      logger: hostLog.logger
    }
    if (mode === 'closed') {
      producer.close()
    }
    if (mode === 'failed') {
      failSql()
      producer.sink.appendItem(
        { provider: 'orca', clientMessageId: 'failed-row' },
        { kind: 'message', role: 'system', blocks: [] },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await producer.drained()
    }
    exiting = true
    failAfterAdmission = mode === 'failure-after-admission'
    claude.connections[0].closed = true
    claude.connections[0].exitVerdict = { root: 'exited', tree: 'exited' }
    claude.connections[0].handlers.onExit?.(new Error('claude stream-json exited (code 1)'))
    await adapter.drainObservedExits()
    await producer.drained()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const ended = events.filter((event) => event.type === 'ended')
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({
      sessionId: 'session-1',
      fence: 7,
      acquisitionGeneration: acquisition.acquisitionGeneration,
      cause: 'unexpected-exit',
      observedAt: 1_700_000_000_500
    })
    if (mode === 'open') {
      expect(publicationOrder).toEqual(['ended', 'following-read'])
    }
    if (mode === 'open' || mode === 'semantic-pressure' || mode === 'notify-pressure') {
      if (mode !== 'semantic-pressure') {
        expect(admissions.at(-1)).toMatchObject({ accepted: true })
      }
      await expect(original?.written?.()).resolves.toEqual({ ok: true })
      expect(owner.childWorkOpen('session-1')).toBe(false)
      expect(exitWork[0]).toEqual(
        expect.arrayContaining([expect.objectContaining({ phase: 'interrupted' })])
      )
      expect(failures).not.toHaveBeenCalled()
    } else if (mode === 'notify-closed') {
      await expect(original?.written?.()).resolves.toMatchObject({ ok: true })
    } else if (mode === 'notify-failed') {
      await expect(producer.sink.written?.()).resolves.toMatchObject({ ok: false })
    } else {
      if (mode === 'failure-after-admission') {
        expect(admissions.at(-1)).toMatchObject({ accepted: true })
      } else {
        expect(admissions.at(-1)).toMatchObject({
          accepted: false,
          reason: mode === 'pressure-closed' ? 'backpressure' : mode
        })
      }
      await expect(original?.written?.()).resolves.toMatchObject({ ok: false })
    }
    const mapped = structuredClaudeLifecycleEvent(ended[0])
    expect(mapped).toMatchObject({
      type: 'ended',
      fence: 7,
      acquisitionGeneration: child.generation
    })
    if (!mapped || mapped.type !== 'ended') {
      throw new Error('original exit must reach host lifecycle mapping')
    }
    await settleStructuredAgentSessionChildExit(context, mapped)
    expect(session.child).toBeNull()
    expect(hostLog.scopes()).not.toContain('exit-owner-release')
    expect(store.getRecord('session-1')?.lease.claimStatus).toBe('released')
    const published = generationEnded.mock.calls.length
    session.child = { ...child, generation: 'replacement-generation' }
    await settleStructuredAgentSessionChildExit(context, mapped)
    expect(session.child.generation).toBe('replacement-generation')
    expect(generationEnded).toHaveBeenCalledTimes(published)
    await adapter.drainObservedExits()
    expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
    producer.close()
    await journal.close()
  }
)

it.each(['bind', 'close'] as const)(
  'finishes prebind acquisition and exit before its existing attempt owner chooses %s',
  async (completion) => {
    const journal = await openAgentSessionJournal({
      identity: identityFor(),
      database: openTestJournalHostDatabase(root),
      now: () => 100
    })
    const producer = createDeferredStructuredAgentSessionEventSink(
      testEventSinkLogging('session-1')
    )
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterFor(claude, {}, events)
    const acquisition = await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'prebind',
      events: producer.sink
    })
    claude.connections[0].closed = true
    claude.connections[0].exitVerdict = { root: 'exited', tree: 'exited' }
    claude.connections[0].handlers.onExit?.(new Error('provider exited before binding'))
    await adapter.drainObservedExits()
    expect(events.filter((event) => event.type === 'ended')).toEqual([])
    if (completion === 'bind') {
      producer.bind({ journal, fence: 7, publish: vi.fn() })
    } else {
      producer.close()
    }
    await producer.drained()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(events.filter((event) => event.type === 'ended')).toEqual([
      expect.objectContaining({
        acquisitionGeneration: acquisition.acquisitionGeneration,
        fence: 7,
        cause: 'unexpected-exit'
      })
    ])
    await adapter.closeSession('session-1')
    await adapter.drainObservedExits()
    expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
    producer.close()
    await journal.close()
  }
)

function identityLocation(): AgentSessionExecutionLocation {
  return {
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    workspaceId: 'workspace-1',
    workspaceKind: 'git-worktree' as const,
    wslDistro: null
  }
}
