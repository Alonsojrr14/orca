import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { expect, vi, type Mock } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { nativeChatTurnMembership } from '../../../shared/native-chat-turn-membership'
import { loadTestJournal } from '../agent-session-journal/journal-host-database-test-support'
import { renderJournalState } from '../agent-session-journal/journal-reducer'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  HOST_TEST_NOW,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

type RewindReplayFixture = {
  host: StructuredAgentSessionHost
  store: AgentSessionRecordStore
  rewind: Mock<NonNullable<StructuredAgentSessionAdapter['rewind']>>
  recoverRewind: Mock<NonNullable<StructuredAgentSessionAdapter['recoverRewind']>>
  seed: () => Promise<string>
  params: (itemId: string) => Promise<Parameters<StructuredAgentSessionHost['rewind']>[1]>
}
const caller = { callerKey: 'desktop' }

export async function expectSupersededRewindReplay({
  host,
  store,
  rewind,
  recoverRewind,
  seed,
  params
}: RewindReplayFixture) {
  const target = await seed()
  const firstRequest = await params(target)
  const first = await host.rewind(caller, firstRequest)
  expect(first).toMatchObject({ ok: true })
  const secondRequest = await params(
    agentJournalItemKey({
      provider: 'codex',
      threadId: HOST_TEST_THREAD,
      turnId: 'kept',
      ordinal: 0
    })
  )
  recoverRewind.mockResolvedValueOnce({ ok: true })
  expect(await host.rewind(caller, secondRequest)).toMatchObject({ ok: true })
  expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.operationId).toBe(
    secondRequest.envelope.clientOperationId
  )
  const effects = rewind.mock.calls.length
  const replay = await host.rewind(caller, firstRequest)
  expect(replay).toMatchObject({ ok: true, replayed: true })
  if (first.ok && replay.ok) {
    expect(replay.value).toEqual(first.value)
  }
  expect(rewind).toHaveBeenCalledTimes(effects)
}

export async function expectRetainedPrefixRewindReplay({
  host,
  rewind,
  seed,
  params
}: Pick<RewindReplayFixture, 'host' | 'rewind' | 'seed' | 'params'>) {
  const target = await seed()
  const request = await params(target)
  const result = await host.rewind(caller, request)
  expect(result).toMatchObject({ ok: true })
  expect((await host.journalSnapshot(HOST_TEST_SESSION)).items).toHaveLength(1)
  expect((await host.journalSnapshot(HOST_TEST_SESSION)).cursor.epoch).not.toBe(
    request.expectedEpoch
  )
  expect(await host.rewind(caller, request)).toMatchObject({ ok: true, replayed: true })
  expect(rewind).toHaveBeenCalledTimes(1)
}

export async function expectLargeRetainedPrefixRewind({
  host,
  store,
  rewind,
  sink,
  params
}: Pick<RewindReplayFixture, 'host' | 'store' | 'rewind' | 'params'> & {
  sink: () => StructuredAgentSessionEventSink
}) {
  expect(await host.attach(caller, hostTestAttachParams(null))).toMatchObject({ ok: true })
  const events = sink()
  const message = (turnId: string) => ({
    provider: 'codex' as const,
    threadId: HOST_TEST_THREAD,
    turnId,
    ordinal: 0
  })
  for (let turn = 0; turn < 300; turn++) {
    events.appendItem(message(`kept-${turn}`), hostTestMessage('x'.repeat(12_000)), {
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  }
  for (const turnId of ['drop', 'tip']) {
    events.appendItem(message(turnId), hostTestMessage(turnId), {
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  }
  await host.flushStreamedEvents(HOST_TEST_SESSION)

  expect(
    await host.rewind(caller, await params(agentJournalItemKey(message('drop'))))
  ).toMatchObject({ ok: true })
  expect(rewind).toHaveBeenCalledWith(expect.objectContaining({ beforeTurnId: 'drop' }))
  const { items } = await host.journalSnapshot(HOST_TEST_SESSION)
  expect(items.map(({ itemId }) => itemId)).toEqual(
    Array.from({ length: 300 }, (_, turn) => agentJournalItemKey(message(`kept-${turn}`)))
  )
  expect(store.getRecord(HOST_TEST_SESSION)?.rewind).toMatchObject({ phase: 'completed' })
}

export async function expectRetainedTurnOpenerRewind({
  host,
  store,
  rewind,
  adapter,
  sink,
  params,
  directory
}: Pick<RewindReplayFixture, 'host' | 'store' | 'rewind' | 'params'> & {
  adapter: StructuredAgentSessionAdapter
  sink: () => StructuredAgentSessionEventSink
  directory: string
}) {
  expect(await host.attach(caller, hostTestAttachParams(null))).toMatchObject({ ok: true })
  const events = sink()
  const message = (turnId: string, ordinal = 0) => ({
    provider: 'codex' as const,
    threadId: HOST_TEST_THREAD,
    turnId,
    ordinal
  })
  const turnRow = (turnId: string) => ({
    provider: 'legacy' as const,
    agent: 'codex',
    sessionId: HOST_TEST_SESSION,
    recordId: `turn-lifecycle:${turnId}`
  })
  for (const turnId of ['kept', 'drop']) {
    const body = hostTestMessage(turnId)
    const clientOperationId = hostTestOperationId()
    vi.mocked(adapter.dispatch).mockResolvedValueOnce({
      state: 'accepted',
      providerIdentity: message(turnId)
    })
    expect(
      await host.send(caller, {
        body,
        envelope: {
          sessionId: HOST_TEST_SESSION,
          clientOperationId,
          expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: HOST_TEST_SESSION,
            fields: { body }
          })
        }
      })
    ).toMatchObject({ ok: true })
    await vi.waitFor(async () =>
      expect(
        (await host.journalSnapshot(HOST_TEST_SESSION)).submissions.find(
          (entry) => entry.clientMessageId === clientOperationId
        )?.dispatchState
      ).toBe('accepted')
    )
    events.appendItem(
      turnRow(turnId),
      {
        kind: 'turn',
        turnId,
        state: 'completed',
        outcome: 'success',
        userItemId: agentJournalSubmissionKey(clientOperationId),
        startedAt: HOST_TEST_NOW - 2_000,
        completedAt: HOST_TEST_NOW - 1_000
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    events.appendItem(
      message(turnId, 1),
      { ...hostTestMessage(`answer ${turnId}`), role: 'assistant' },
      { turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(turnRow(turnId)) } }
    )
    await host.flushStreamedEvents(HOST_TEST_SESSION)
  }
  const before = await host.journalSnapshot(HOST_TEST_SESSION)
  const kept = before.submissions[0]!
  const target = before.submissions.at(-1)!
  expect(
    await host.rewind(caller, await params(agentJournalSubmissionKey(target.clientMessageId)))
  ).toMatchObject({ ok: true })

  const rebuilt = await host.journalSnapshot(HOST_TEST_SESSION)
  const opener = agentJournalSubmissionKey(kept.clientMessageId)
  const providerOpener = agentJournalItemKey(message('kept'))
  expect(rebuilt.cursor.epoch).not.toBe(before.cursor.epoch)
  expect(rebuilt.submissions).toEqual([
    expect.objectContaining({
      clientMessageId: kept.clientMessageId,
      payloadFingerprint: kept.payloadFingerprint,
      submittedAt: kept.submittedAt,
      dispatchState: 'accepted',
      providerItemId: providerOpener
    })
  ])
  expect(rebuilt.items.map(({ itemId, body }) => ({ itemId, body }))).toEqual([
    { itemId: opener, body: hostTestMessage('kept') },
    {
      itemId: agentJournalItemKey(turnRow('kept')),
      body: expect.objectContaining({ kind: 'turn', userItemId: providerOpener })
    },
    {
      itemId: agentJournalItemKey(message('kept', 1)),
      body: { ...hostTestMessage('answer kept'), role: 'assistant' }
    }
  ])
  const membership = nativeChatTurnMembership(
    rebuilt.items.flatMap(({ itemId, body }) =>
      body.kind === 'message' ? [{ id: itemId, role: body.role }] : []
    ),
    rebuilt
  )
  expect(membership.turnKeys).toEqual([opener, opener])
  const reloaded = loadTestJournal(directory, HOST_TEST_SESSION)!
  expect(reloaded).toMatchObject({ damage: null, newer: null })
  expect(renderJournalState(reloaded.state)).toEqual(rebuilt)
  expect(await host.rewind(caller, await params(opener))).toMatchObject({ ok: true })
  expect(rewind).toHaveBeenLastCalledWith(expect.objectContaining({ beforeTurnId: 'kept' }))
  expect((await host.journalSnapshot(HOST_TEST_SESSION)).items).toEqual([])
  expect((await host.journalSnapshot(HOST_TEST_SESSION)).submissions).toEqual([])
}
