import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { semanticWorkRecordId } from '../../../shared/agent-session-semantic-work'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { structuredRewindCut } from './structured-rewind-cut'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { StructuredAgentSessionJournalProjections } from './structured-agent-session-status-journal-projection'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
const DEAD = 1
const LIVE = 3

function codexItem(turnId: string, ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId, ordinal }
}
const TURN = codexItem('turn-dead', 0)
const PROMPT = codexItem('turn-dead', 1)
const REPLY = codexItem('turn-dead', 2)
const UNDONE = codexItem('turn-undone', 0)
const PENDING = {
  state: 'pending' as const,
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
}
const REPLY_BODY: AgentJournalItemBody = {
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'partial' }]
}

const UNDONE_BODY: AgentJournalItemBody = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'undo me' }]
}

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-rewind-provenance-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function leftByDeadGeneration(): Promise<AgentSessionJournal> {
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
  const scope = { fence: DEAD, ownerFence: DEAD, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  await journal.appendItem(TURN, { kind: 'turn', turnId: 'turn-dead', state: 'running' }, scope)
  const inTurn = {
    ...scope,
    turnScope: { kind: 'turn' as const, turnItemId: agentJournalItemKey(TURN) }
  }
  await journal.appendItem(
    PROMPT,
    {
      kind: 'approval',
      title: 'Run command?',
      detail: null,
      options: [{ id: 'yes', label: 'Allow' }],
      resolution: PENDING
    },
    inTurn
  )
  await journal.appendItem(REPLY, REPLY_BODY, inTurn)
  await journal.appendItem(UNDONE, UNDONE_BODY, { ...scope, fence: LIVE, ownerFence: LIVE })
  return journal
}

async function rewindAtLiveFence(journal: AgentSessionJournal): Promise<void> {
  const cut = structuredRewindCut(journal, {
    itemId: agentJournalItemKey(UNDONE),
    provider: 'codex',
    nativeId: 'thread-1'
  })
  await journal.replaceEpochItems('handle_forked', LIVE, cut!.kept)
}

describe('a rewind after a failed cleanup', () => {
  it("does not promote the dead generation's turn, prompt or reply to the live one", async () => {
    const journal = await leftByDeadGeneration()
    const before = journal.epoch

    await rewindAtLiveFence(journal)

    expect(journal.epoch).not.toBe(before)
    const work = new StructuredAgentSessionCurrentWork(journal, LIVE)
    // New row fence must not promote old execution provenance.
    expect(journal.itemFence(agentJournalItemKey(TURN))).toBe(DEAD)
    expect(journal.itemFence(agentJournalItemKey(PROMPT))).toBe(DEAD)
    expect(journal.itemFence(agentJournalItemKey(REPLY))).toBe(DEAD)
    expect(work.activeTurnId()).toBeNull()
    expect(work.actionablePromptIds()).toEqual([])
    expect(work.working()).toBe(false)
    expect(journal.itemBody(agentJournalItemKey(UNDONE))).toBeNull()
  })
})

it.each(['epoch', 'context'])(
  'retains recovered helper and nonqueued source through the actual %s cut',
  async (mode) => {
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    if (mode === 'context') {
      await journal.context.clear(
        { operationId: 'clear', afterFence: DEAD, clearedAt: 1 },
        { write: () => {}, committed: () => {} }
      )
    }
    const floor = journal.context.floor()
    await journal.appendItem(
      TURN,
      { kind: 'turn', turnId: 'turn-dead', state: 'completed', outcome: 'success' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE, fence: DEAD }
    )
    const accepted = await journal.appendSubmission({
      clientMessageId: 'unanswered',
      payloadFingerprint: 'kept',
      handoverRecorded: true,
      fence: DEAD,
      options: { model: 'original-model' },
      body: { kind: 'message', role: 'user', blocks: [] }
    })
    await journal.resolveDispatch({
      clientMessageId: 'unanswered',
      fence: DEAD,
      state: 'pending',
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.resolveDispatch({
      clientMessageId: 'unanswered',
      fence: DEAD,
      state: 'unknown',
      recovered: true,
      reason: 'delivery uncertain'
    })
    const releaseSource = { kind: 'submission', clientMessageId: 'unanswered' } as const
    await journal.appendItem(
      {
        provider: 'legacy',
        agent: 'codex',
        sessionId: IDENTITY.sessionId,
        recordId: semanticWorkRecordId(releaseSource)
      },
      {
        kind: 'semantic-work',
        version: 1,
        source: releaseSource,
        startedAt: journal.submission('unanswered')!.submittedAt,
        phase: 'settled'
      },
      { turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(TURN) }, fence: DEAD }
    )
    const saved = journal.submission('unanswered')!
    const source = {
      kind: 'child',
      idKind: 'task_id',
      handleId: 'helper',
      invocationId: 'a86c3fc1-47a1-4bad-9151-aaeffcc7bc30'
    } as const
    const identity = {
      provider: 'legacy',
      agent: 'codex',
      sessionId: IDENTITY.sessionId,
      recordId: semanticWorkRecordId(source)
    } as const
    const body = {
      kind: 'semantic-work',
      version: 1,
      source,
      startedAt: 10,
      phase: 'open'
    } as const
    const scope = { kind: 'turn', turnItemId: agentJournalItemKey(TURN) } as const
    await journal.appendItem(identity, body, { fence: DEAD, observedAt: 10, turnScope: scope })
    await journal.appendItem(UNDONE, UNDONE_BODY, { turnScope: scope, fence: DEAD })
    await journal.appendItem(
      identity,
      { ...body, phase: 'interrupted', afterRequest: journal.requestFrontier() },
      { fence: DEAD, observedAt: 20, recovered: true, turnScope: scope }
    )
    const cut = structuredRewindCut(journal, {
      itemId: agentJournalItemKey(UNDONE),
      provider: 'codex',
      nativeId: 'thread-1'
    })!
    expect(
      cut.kept.find((item) => agentJournalItemKey(item.identity) === agentJournalItemKey(identity))
    ).toMatchObject({
      observedAt: 10,
      recoveredAt: 20,
      body: {
        phase: 'interrupted',
        afterRequest: agentJournalItemKey({ provider: 'orca', clientMessageId: 'unanswered' })
      }
    })
    await (floor
      ? journal.context.rewind(floor, LIVE, cut.kept, () => ({
          write: () => {},
          committed: () => {}
        }))
      : journal.replaceEpochItems('handle_forked', LIVE, cut.kept))
    expect(journal.submission('unanswered')).toMatchObject({
      clientMessageId: saved.clientMessageId,
      options: saved.options,
      submittedAt: saved.submittedAt,
      dispatchState: saved.dispatchState,
      reason: saved.reason,
      recovered: true,
      fence: DEAD
    })
    expect(journal.restFact()).toEqual({ itemId: agentJournalItemKey(identity), since: 10 })
    expect(journal.item(agentJournalItemKey(identity))).toMatchObject({
      observedAt: 10,
      recoveredAt: 20
    })
    await journal.close()
    const reopened = await journals.open({ identity: IDENTITY, stateDirectory: root })
    expect(reopened.restFact()).toEqual({ itemId: agentJournalItemKey(identity), since: 10 })
    expect(reopened.submission('unanswered')?.options).toEqual(saved.options)
    expect(accepted.sequence).toBeGreaterThan(0)
  }
)

it('restores the original quit cut after actual rewind under a newer live owner', async () => {
  const since = 1792842260044
  const completedAt = 1792842344697
  const quitAt = 1792842344700
  const replacementFence = 6
  const rewindAt = 1792920422530
  const journal = await journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: () => rewindAt
  })
  const turnItemId = agentJournalItemKey(TURN)
  const stop = codexItem('turn-dead', 3)
  await journal.appendItem(
    TURN,
    {
      kind: 'turn',
      turnId: 'turn-dead',
      state: 'interrupted',
      requestedAt: 1792842260018,
      startedAt: since,
      completedAt
    },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE, fence: 2, ownerFence: 2, observedAt: since }
  )
  await journal.appendItem(
    stop,
    { kind: 'status', text: '', presentation: 'orca-stop', orcaStop: { cause: 'quit' } },
    {
      turnScope: { kind: 'turn', turnItemId },
      fence: 3,
      ownerFence: 3,
      observedAt: quitAt
    }
  )
  const fact = { itemId: turnItemId, since }
  expect(journal.restFact()).toEqual(fact)
  const projection = new StructuredAgentSessionJournalProjections()
  projection.noteRestart(IDENTITY.sessionId, {
    known: true,
    interrupted: true,
    openTurn: fact,
    lastSequence: journal.cursor().sequence,
    lastSavedAt: quitAt
  })
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({ sessionId: IDENTITY.sessionId, runtimeFence: replacementFence })
  )
  record.provider = 'codex'
  record.providerHandleChain = record.providerHandleChain.map((link) => ({
    ...link,
    handle: codexProviderHandle('thread-1')
  }))
  const seen = { child: { fence: replacementFence } }
  await journal.appendItem(UNDONE, UNDONE_BODY, {
    turnScope: AGENT_JOURNAL_THREAD_SCOPE,
    fence: replacementFence
  })
  await journal.appendItem(
    codexItem('turn-undone', 1),
    { kind: 'turn', turnId: 'turn-undone', state: 'completed', outcome: 'success' },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE, fence: replacementFence }
  )
  expect(
    projection.read(journal, agentSessionConversationView(record), seen).state.summary.turnOutcome
  ).toBe('success')
  const epoch = journal.epoch
  const cut = structuredRewindCut(journal, {
    itemId: agentJournalItemKey(UNDONE),
    provider: 'codex',
    nativeId: 'thread-1'
  })!
  expect(cut).toMatchObject({ beforeTurnId: 'turn-undone', keptTurnId: 'turn-dead' })
  await journal.replaceEpochItems('handle_forked', replacementFence, cut.kept)
  expect(journal.epoch).not.toBe(epoch)
  expect(journal.itemBody(agentJournalItemKey(UNDONE))).toBeNull()
  expect(journal.restFact()).toEqual(fact)
  expect(journal.item(turnItemId)).toMatchObject({
    observedAt: since,
    body: { state: 'interrupted', startedAt: since, completedAt }
  })
  expect(journal.item(agentJournalItemKey(stop))).toMatchObject({
    observedAt: quitAt,
    body: { orcaStop: { cause: 'quit' } }
  })
  expect(journal.itemFence(turnItemId)).toBe(2)
  expect(journal.itemFence(agentJournalItemKey(stop))).toBe(3)
  expect(record.lease.deathEvidence).toBeNull()
  const restored = projection.read(journal, agentSessionConversationView(record), seen)
  expect(restored.liveFence).toBe(replacementFence)
  expect(restored.state.summary).toMatchObject({
    status: 'idle',
    turnOutcome: 'cancellation',
    restoredInterruption: true,
    statusStartedAt: since
  })
  expect(projection.read(journal, agentSessionConversationView(record), seen)).toBe(restored)
  expect(journal.restFact()).toEqual(fact)
  const next = codexItem('later-live', 0)
  await journal.appendItem(
    next,
    { kind: 'turn', turnId: 'later-live', state: 'running', startedAt: rewindAt + 1 },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE, fence: replacementFence }
  )
  expect(
    projection.read(journal, agentSessionConversationView(record), seen).state.summary.status
  ).toBe('working')
  await journal.appendItem(
    next,
    { kind: 'turn', turnId: 'later-live', state: 'interrupted', startedAt: rewindAt + 1 },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE, fence: replacementFence }
  )
  const fault = projection.read(journal, agentSessionConversationView(record), seen).state.summary
  expect(fault.turnOutcome).toBe('interruption')
  expect(fault.restoredInterruption).toBeUndefined()
})
