// Listing reserves nothing; actions reserve offers and settle them as completed or failed.

import { randomUUID } from 'node:crypto'
import {
  materializeRestartMarkers,
  createRestartListing
} from './structured-agent-session-restart-materialize'
import { createRestartResumeProgress } from './structured-agent-session-restart-resume-progress'
import {
  AgentSessionRefusalError,
  agentSessionRefusalFromReference
} from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import {
  createNewerOrcaChats,
  createStructuredAgentSessionRestartCandidateReaders
} from './structured-agent-session-restart-candidates'
import {
  continuationFailureOutcome,
  createStructuredAgentSessionRestartFailureLedger
} from './structured-agent-session-restart-failure-ledger'
import { createStructuredAgentSessionRestartOperationQueue } from './structured-agent-session-restart-operation-queue'
import { createStructuredAgentSessionRestartOfferRecords } from './structured-agent-session-restart-offer-records'
import {
  restartRowsFor,
  type StructuredAgentSessionRestartAudience
} from './structured-agent-session-restart-resume-set'
import {
  resumeStructuredAgentSessionsFromRestart,
  StructuredAgentSessionResumeAdmission
} from './structured-agent-session-restart-resume-runner'
import type { StructuredAgentSessionRestartResume } from './structured-agent-session-restart-resume-contract'
import {
  continuationDeps,
  startStructuredAgentSessionContinuation,
  type StructuredAgentSessionContinuationOutcome
} from './structured-agent-session-restart-continuation'
import { restartContinuationId } from './structured-agent-session-restart-continuation-envelope'
import { createInterruptedContinuation } from './structured-agent-session-interrupted-continuation'
import {
  createStructuredAgentSessionRestartOfferWithdrawal,
  type StructuredAgentSessionRestartOfferSession
} from './structured-agent-session-restart-offer-withdrawal'
import {
  createRestartContinuationHost,
  type StructuredAgentSessionRestartResumeSurfaces
} from './structured-agent-session-restart-resume-wiring'
import { createStructuredAgentSessionRestartWitnesses } from './structured-agent-session-restart-witnesses'
import {
  remainingRestartRows,
  unstartedRestartRefusals
} from './structured-agent-session-restart-action-result'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

type LiveSession = StructuredAgentSessionRestartOfferSession

export type { StructuredAgentSessionRestartResume }

export function createStructuredAgentSessionRestartResume(
  deps: Pick<
    StructuredAgentSessionHostDeps,
    'store' | 'adapter' | 'recoveryCapsule' | 'logger' | 'agents' | 'journalDatabase'
  >,
  sessions: ReadonlyMap<string, LiveSession>,
  surfaces: StructuredAgentSessionRestartResumeSurfaces
): StructuredAgentSessionRestartResume {
  const admission = new StructuredAgentSessionResumeAdmission()
  const enqueueRecoveryOperation = createStructuredAgentSessionRestartOperationQueue()

  const witnesses = createStructuredAgentSessionRestartWitnesses({
    sessions,
    getRecord: deps.store.getConversation,
    childWork: surfaces.readChildWork,
    childWorkOpen: surfaces.childWorkOpen,
    ...(deps.recoveryCapsule ? { capsule: deps.recoveryCapsule } : {}),
    teardownId: randomUUID(),
    now: surfaces.now,
    enqueue: enqueueRecoveryOperation
  })
  const withdrawal = createStructuredAgentSessionRestartOfferWithdrawal({
    sessions,
    ...(deps.recoveryCapsule ? { capsule: deps.recoveryCapsule } : {}),
    logger: deps.logger,
    now: surfaces.now,
    enqueue: enqueueRecoveryOperation
  })
  const newerOrca = createNewerOrcaChats(() => deps.journalDatabase.readOnly)
  const { derive, deriveAtSend } = createStructuredAgentSessionRestartCandidateReaders({
    sessions,
    getRecord: deps.store.getRecord,
    adapter: deps.adapter,
    agents: deps.agents,
    movedOn: withdrawal.movedOn,
    savedByNewerOrca: newerOrca.has
  })
  const failures = createStructuredAgentSessionRestartFailureLedger({
    ...(deps.recoveryCapsule ? { capsule: deps.recoveryCapsule } : {}),
    getRecord: deps.store.getConversation,
    retryable: (marker) => derive([marker], 'may-be-held').candidates.length === 1,
    savedByNewerOrca: newerOrca.has,
    logger: deps.logger,
    now: surfaces.now,
    enqueue: enqueueRecoveryOperation
  })

  const { readMarkers, readActionMarkers, retireSuperseded } =
    createStructuredAgentSessionRestartOfferRecords({
      ...(deps.recoveryCapsule ? { capsule: deps.recoveryCapsule } : {}),
      readFailedMarkers: async () => (await failures.read()).map((failure) => failure.marker),
      logger: deps.logger,
      now: surfaces.now,
      enqueue: enqueueRecoveryOperation
    })

  const list = createRestartListing(deps, readMarkers, derive, retireSuperseded)
  const listFailures = async (audience?: StructuredAgentSessionRestartAudience) =>
    restartRowsFor(await failures.list(), audience)

  const continuationHost = createRestartContinuationHost(
    deps,
    sessions,
    surfaces,
    (marker) => deriveAtSend([marker], 'may-be-held').candidates.length === 1
  )

  /** Reserve then continue under the shared host-wide startup limit. */
  const run = async (
    sessionIds: readonly string[] | undefined,
    owner: string,
    audience: StructuredAgentSessionRestartAudience | undefined,
    continueOne: (marker: AgentSessionResumeMarker, continuationId: string) => Promise<void>,
    progress: ReturnType<typeof createRestartResumeProgress>
  ) => {
    // Supersede captured witnesses; the mutation lane drains any publication already in flight.
    witnesses.clear(audience)
    const markers = await readActionMarkers(sessionIds)
    const requested = new Set(sessionIds ?? markers.map((marker) => marker.sessionId))
    const derived = derive(markers, 'may-be-held')
    retireSuperseded(derived.superseded)
    const eligible = restartRowsFor(derived.candidates, audience).filter((candidate) =>
      requested.has(candidate.sessionId)
    )
    progress.skipExcluded(sessionIds ?? [], eligible)
    if (eligible.length === 0) {
      return null
    }
    const operationId = randomUUID()
    const actionAt = surfaces.now()
    // Keep offer identity beyond ledger expiry to distinguish rejected continuations.
    const continuationFor = (marker: AgentSessionResumeMarker) =>
      restartContinuationId(marker, operationId, actionAt)
    const reserved =
      (await enqueueRecoveryOperation(
        () =>
          deps.recoveryCapsule?.beginResume(
            eligible.map((candidate) => candidate.sessionId),
            operationId,
            actionAt
          ) ?? Promise.resolve([])
      )) ?? []
    const markersBySession = new Map(reserved.map((marker) => [marker.sessionId, marker]))
    const candidates = derive(reserved, 'may-be-held').candidates
    progress.skipExcluded(
      eligible.map((candidate) => candidate.sessionId),
      candidates
    )
    try {
      const outcomes = await resumeStructuredAgentSessionsFromRestart(
        {
          admission,
          onPhase: progress.set,
          onRefused: (sessionId) => progress.set(sessionId, 'refused'),
          consumeMarker: async (sessionId) => {
            const marker = markersBySession.get(sessionId)
            return (
              marker !== undefined && deriveAtSend([marker], 'may-be-held').candidates.length === 1
            )
          },
          resume: async (sessionId) => {
            const marker = markersBySession.get(sessionId)
            if (marker) {
              const start = async () => {
                newerOrca.note(sessionId, await surfaces.revealSession(sessionId).catch(() => null))
                const refreshed = deriveAtSend([marker], 'may-be-held').candidates[0]
                const candidate = candidates.find((row) => row.sessionId === sessionId)
                if (refreshed && candidate) {
                  Object.assign(candidate, refreshed)
                }
                await continueOne(marker, continuationFor(marker))
              }
              await (surfaces.automatic ? surfaces.automatic(sessionId, start) : start())
            }
          }
        },
        candidates,
        owner
      )
      return { operationId, outcomes, candidates, markers: markersBySession }
    } catch (error) {
      if (deps.recoveryCapsule) {
        await enqueueRecoveryOperation(() =>
          deps.recoveryCapsule!.rollbackResume(operationId, surfaces.now())
        ).catch(() => {
          deps.logger.warn('rolling back a restart offer reservation failed', {
            scope: 'restart-offer-rollback',
            operationId
          })
        })
      }
      throw error
    }
  }

  const continueAfterRestart: StructuredAgentSessionRestartResume['continueAfterRestart'] = async (
    sessionIds,
    owner,
    audience
  ) => {
    const progress = createRestartResumeProgress(sessions, surfaces.publishStatus)
    try {
      const continued: StructuredAgentSessionContinuationOutcome[] = []
      const verdicts: Promise<void>[] = []
      // Hold startup slots through handover/start failure, awaiting provider answers separately.
      const action = await run(
        sessionIds,
        owner,
        audience,
        async (marker, continuationId) => {
          const started = await startStructuredAgentSessionContinuation(
            continuationDeps(continuationHost, () => continuationHost.stillResumable(marker)),
            marker.sessionId,
            marker,
            continuationId
          )
          if ('done' in started) {
            continued.push(started.done)
            progress.verdict(started.done)
            const { outcome, reason, refusal } = started.done
            if (outcome === 'refused') {
              // Preserve refusal details beside the filed code.
              throw refusal
                ? new AgentSessionRefusalError(
                    agentSessionRefusalFromReference(refusal, refusal.code)
                  )
                : new Error(reason ?? 'agent_session_continuation_refused')
            }
            return
          }
          verdicts.push(
            started.verdict().then((outcome) => {
              continued.push(outcome)
              progress.verdict(outcome)
            })
          )
        },
        progress
      )
      await Promise.all(verdicts)
      const resumed = action?.outcomes ?? []
      if (action) {
        await failures.settle(action.operationId, resumed, {
          candidates: action.candidates,
          markers: action.markers,
          failureAfterResume: (sessionId) => {
            const outcome = continued.find((entry) => entry.sessionId === sessionId)
            return outcome ? continuationFailureOutcome(outcome.outcome) : null
          },
          failureReason: (sessionId) => {
            const outcome = continued.find((entry) => entry.sessionId === sessionId)
            return outcome?.reason ?? outcome?.outcome ?? 'agent_session_continuation_unknown'
          }
        })
      }
      continued.push(...unstartedRestartRefusals(resumed, continued))
      return {
        resumed,
        continued,
        ...(progress.skipped.length > 0 ? { skipped: progress.skipped } : {}),
        ...(await remainingRestartRows(
          () => list(audience),
          () => listFailures(audience),
          deps.logger
        ))
      }
    } finally {
      progress.clear()
    }
  }

  return {
    beginTeardown: witnesses.begin,
    captureBeforeStop: witnesses.beforeStop,
    confirmStopped: witnesses.stopped,
    recordMarkers: witnesses.record,
    list,
    listFailures,
    // Do not let a teardown witness already captured in this host republish after explicit
    // dismissal. A later capture is a new interruption and may create a fresh offer normally.
    dismiss: async (sessionIds, audience) => {
      materializeRestartMarkers(
        deps,
        (await readActionMarkers(sessionIds)).filter(
          (marker) => !sessionIds || sessionIds.includes(marker.sessionId)
        )
      )
      return failures.dismiss(
        sessionIds,
        (clearAudience) => witnesses.clear(clearAudience),
        audience
      )
    },
    continueAfterRestart,
    onAgentStarted: withdrawal.onAgentStarted,
    noteReadResult: newerOrca.note,
    beforeConversationClose: withdrawal.beforeClose,
    continueInterrupted: createInterruptedContinuation(continuationHost, readMarkers)
  }
}
