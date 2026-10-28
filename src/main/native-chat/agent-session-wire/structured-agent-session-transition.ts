// Admit each event’s writes whole so producer state cannot advance after partial admission.
// Execute against the latest fold in one queue turn; failure retains the written prefix and skips later steps.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalStep } from '../agent-session-journal/journal-step-writer'
import {
  estimateStructuredAgentSessionItemBytes,
  estimateStructuredAgentSessionSettlementBytes
} from './structured-agent-session-event-sink-estimate'
import type {
  StructuredAgentSessionItemAppendOptions,
  StructuredAgentSessionSinkAdmission
} from './structured-agent-session-event-sink'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'
import { structuredAgentSessionJournalAppendOptions } from './structured-agent-session-journal-append-options'

export type StructuredAgentSessionTransitionJournal = Pick<
  AgentSessionJournal,
  | 'epoch'
  | 'visitItems'
  | 'itemBody'
  | 'item'
  | 'visitItemsWithLinkage'
  | 'canonicalItemId'
  | 'agent'
  | 'sessionId'
  | 'submission'
  | 'requestFrontier'
  | 'runningTurn'
  | 'readInOrder'
>

export type StructuredAgentSessionTransitionStep =
  | {
      kind: 'item'
      /** Exceeding the reservation fails the sink. */
      reservedBytes: number
      resolve: (journal: StructuredAgentSessionTransitionJournal) => {
        identity: AgentJournalItemIdentity
        body: AgentJournalItemBody
      } | null
      options: StructuredAgentSessionItemAppendOptions
    }
  | {
      kind: 'settlement'
      /** Journal deduplicates settlements by this ID. */
      settlementId: string
      recovered?: true
      /** Admission charge; bounds mutations together with any journal-derived reservation. */
      reservedBytes: number
      /** Reserve journal-derived bodies on the write lane, after preceding writes land. */
      reserveFromJournal?: (journal: StructuredAgentSessionTransitionJournal) => number
      /** Resolve at execution; an empty result writes nothing. */
      resolve: (
        journal: StructuredAgentSessionTransitionJournal
      ) => readonly JournalLifecycleMutationInput[]
    }

export type StructuredAgentSessionTransition = {
  steps: readonly StructuredAgentSessionTransitionStep[]
  /** Charge the lifecycle budget for ending/settling work. */
  lifecycle: boolean
  /** Internal admission for bounded provider tails after finalization. */
  finalTail?: true
  publish: boolean
  /** Run after writes and parent publication, in queue order. */
  onPublished?: () => void
}

const STEP_OVERFLOW = 'structured agent-session transition step exceeded its reserved size'

export type StructuredAgentSessionTransitionSink = {
  tryAppendTransition?(
    transition: StructuredAgentSessionTransition
  ): StructuredAgentSessionSinkAdmission
  /** null until the sink binds to a journal. */
  journalItems?(): StructuredAgentSessionTransitionJournal | null
}

export function createStructuredAgentSessionTransitionMembers(
  queue: StructuredAgentSessionSinkQueue
): Required<StructuredAgentSessionTransitionSink> {
  return { tryAppendTransition: transitionAppend(queue), journalItems: queue.journalItems }
}

function transitionAppend(
  queue: StructuredAgentSessionSinkQueue
): (transition: StructuredAgentSessionTransition) => StructuredAgentSessionSinkAdmission {
  return (transition) =>
    queue.submit({
      bytes:
        transition.steps.reduce((total, step) => total + step.reservedBytes, 0) +
        (transition.publish ? 1 : 0),
      lifecycle: transition.lifecycle,
      finalTail: transition.finalTail,
      run: async (bound, reserveBytes) => {
        const { journal, fence } = bound
        await journal.appendSteps(
          transition.steps.map((step): JournalStep =>
            step.kind === 'item'
              ? {
                  kind: 'item',
                  resolve: () => {
                    const resolved = step.resolve(journal)
                    if (
                      resolved &&
                      estimateStructuredAgentSessionItemBytes(resolved.identity, resolved.body) >
                        step.reservedBytes
                    ) {
                      throw new Error(STEP_OVERFLOW)
                    }
                    return resolved
                  },
                  options: structuredAgentSessionJournalAppendOptions(fence, step.options)
                }
              : {
                  kind: 'settlement',
                  batch: {
                    settlementId: step.settlementId,
                    fence,
                    ownerFence: fence,
                    recovered: step.recovered,
                    resolve: () => {
                      const journalBytes = step.reserveFromJournal?.(journal) ?? 0
                      if (step.reserveFromJournal) {
                        reserveBytes(journalBytes)
                      }
                      const mutations = step.resolve(journal)
                      if (
                        estimateStructuredAgentSessionSettlementBytes(mutations) >
                        step.reservedBytes + journalBytes
                      ) {
                        throw new Error(STEP_OVERFLOW)
                      }
                      return mutations
                    }
                  }
                }
          ),
          (wrote) => {
            if (transition.publish && wrote.includes(true)) {
              bound.publish()
            }
            publishCommitted(transition.onPublished)
          }
        )
      }
    })
}

export function publishCommitted(publish: (() => void) | undefined): void {
  try {
    publish?.()
  } catch (error) {
    console.warn('[agent-session] committed publication failed', error)
  }
}
