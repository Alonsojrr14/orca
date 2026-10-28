/** Adapt host reads/sends for the pure structured-pointer policy; do not decide delivery here. */

import { AGENT_SESSION_NOT_ATTACHED } from '../../native-chat/agent-session-wire/structured-agent-session-mutation-admission'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type {
  StructuredMailboxPointerHost,
  StructuredPointerSessionFacts
} from './structured-mailbox-pointer-delivery'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import {
  structuredSessionGateFacts,
  type StructuredSessionGateFacts
} from './structured-session-pointer-delivery'
import { sendAgentTurn, type StructuredSessionTurnOutcome } from './send-agent-turn'

/** Names the dispatch a nudge belongs to on the operation row it writes. */
export function structuredPointerCallerKey(dispatchId: string): string {
  return `trusted-local:orchestration:${dispatchId}`
}

/** Scope direct mail by session; preserve existing Dispatch key shape so in-flight nudges still replay. */
export function structuredSessionPointerCallerKey(sessionId: string): string {
  return `trusted-local:orchestration:session:${sessionId}`
}

/** Use the full reduced timeline: a busy turn's revised lifecycle item can lie outside any tail page. */
export async function readStructuredSessionGateFacts(
  sessionId: string
): Promise<StructuredSessionGateFacts | null> {
  return readSessionJournal(sessionId, false, (snapshot, host) => {
    const work = host.currentWork(sessionId)
    return structuredSessionGateFacts(snapshot.items, work?.scope)
  })
}

/** What each recorded send settled as. */
async function readPointerSessionFacts(
  sessionId: string
): Promise<StructuredPointerSessionFacts | null> {
  return readSessionJournal(sessionId, true, (snapshot, host) => {
    const boundary = host.deps.store.getConversation(sessionId)?.providerContextBoundary
    return {
      submissions: boundary
        ? snapshot.submissions.filter((submission) => submission.fence > boundary.afterFence)
        : snapshot.submissions
    }
  })
}

async function readSessionJournal<T>(
  sessionId: string,
  automatic: boolean,
  read: (snapshot: AgentJournalSnapshot, host: StructuredAgentSessionHost) => T
): Promise<T | null> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  try {
    // Keep snapshot and execution provenance under the same operation borrow.
    return await (automatic ? host.withAutomaticConversation : host.withConversationUse)(
      sessionId,
      async () => read(await host.journalSnapshot(sessionId), host)
    )
  } catch (error) {
    if (!(error instanceof Error) || error.message !== AGENT_SESSION_NOT_ATTACHED.code) {
      console.warn('[orchestration] structured journal unreadable', sessionId, error)
    }
    return null
  }
}

export function createStructuredMailboxPointerHost(): StructuredMailboxPointerHost {
  return {
    readSessionFacts(sessionId) {
      return readPointerSessionFacts(sessionId)
    },

    hasActionablePromptNow(sessionId) {
      return getStructuredAgentSessionHost()?.currentWork(sessionId)?.hasActionablePrompt() ?? null
    },

    isWorkingNow(sessionId) {
      return getStructuredAgentSessionHost()?.currentWork(sessionId)?.working() ?? false
    },

    currentFence(sessionId) {
      return (
        getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)?.currentFence ?? null
      )
    },

    currentContextClearOperationId(sessionId) {
      return getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)
        ?.providerContextBoundary?.operationId
    },

    async send(input) {
      const host = getStructuredAgentSessionHost()
      if (!host) {
        return { kind: 'unattached' }
      }
      let outcome: StructuredSessionTurnOutcome
      try {
        outcome = await host.withAutomaticConversation(input.sessionId, () =>
          sendAgentTurn({
            kind: 'structured-session',
            host,
            sessionId: input.sessionId,
            callerKey: input.dispatchId
              ? structuredPointerCallerKey(input.dispatchId)
              : structuredSessionPointerCallerKey(input.sessionId),
            turn: {
              body: input.body,
              // A person's plain send: every agent takes it the way it takes their own mid-turn message.
              delivery: 'now',
              operationId: input.operationId,
              expectedRuntimeFence: input.expectedRuntimeFence,
              beforeRun: () => {
                const work = host.currentWork(input.sessionId)
                if (
                  input.body.from?.orchestration?.message === 'mail-notice' &&
                  (work?.hasActionablePrompt() || (input.holdWhileWorking && work?.working()))
                ) {
                  throw new StructuredMailHeldError()
                }
              }
            }
          })
        )
      } catch (error) {
        if (error instanceof StructuredMailHeldError) {
          return { kind: 'held' }
        }
        throw error
      }
      switch (outcome.kind) {
        case 'refused':
          return outcome.refusal.code === AGENT_SESSION_NOT_ATTACHED.code
            ? { kind: 'unattached' }
            : { kind: 'sent', state: 'rejected' }
        case 'queued':
          return { kind: 'queued' }
        case 'sent': {
          // Only accepted acknowledges mail; pending submissions park until the next journal edge.
          const state = outcome.submission?.dispatchState
          return {
            kind: 'sent',
            state: state === 'accepted' ? 'accepted' : state === 'rejected' ? 'rejected' : 'unknown'
          }
        }
      }
    }
  }
}

class StructuredMailHeldError extends Error {}
