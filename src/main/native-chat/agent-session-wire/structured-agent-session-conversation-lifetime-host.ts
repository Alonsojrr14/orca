import { retryableStructuredAgentSessionStart } from './structured-agent-session-start-retry'
import {
  providerStartupFailureFact,
  structuredAgentSessionStartFailure
} from './structured-agent-session-failure-text'
import {
  oldestQueuedSubmission,
  recordStructuredAgentSessionStartFailure
} from './structured-agent-session-start-failure-row'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import type { StructuredAgentSessionRestartResume } from './structured-agent-session-restart-resume-contract'
import type { StructuredAgentSessionConversationOpenOptions } from './structured-agent-session-conversation-open'
import { stopStructuredAgentSessionAgentUnderSerialize } from './structured-agent-session-host-lifetime'
import { sameProviderChild } from './structured-agent-session-provider-child'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'

export type StructuredAgentSessionConversationLifetimeHost = {
  /** Resolve lazily because host collaborators are assigned after construction. */
  context: () => StructuredAgentSessionLifetimeContext
  sessions: StructuredAgentSessionConversations
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** Caller already holds session serialization. */
  open: (
    sessionId: string,
    options?: StructuredAgentSessionConversationOpenOptions
  ) => Promise<StructuredAgentSessionHostSession | null>
  busy: (sessionId: string) => boolean
  restartResume: Pick<
    StructuredAgentSessionRestartResume,
    'beforeConversationClose' | 'noteReadResult'
  >
  deliveryActive: (sessionId: string) => boolean
  /** Retain status rows while a tab still lists the chat. */
  closeStatus: (sessionId: string, options: { listed: boolean }) => void
  childWorkOpen: (sessionId: string) => boolean
}

export function createStructuredAgentSessionStopStartingChild(
  host: StructuredAgentSessionConversationLifetimeHost
) {
  return (sessionId: string, expired: StructuredAgentSessionProviderChildIdentity | null): void => {
    void host
      .serialize(sessionId, async () => {
        const child = host.sessions.get(sessionId)?.child
        if (
          !expired ||
          !child ||
          child.phase !== 'starting' ||
          !sameProviderChild(child, expired)
        ) {
          return
        }
        await stopStructuredAgentSessionAgentUnderSerialize(host.context(), sessionId, {
          cause: 'host-stop'
        })
      })
      .catch((error: unknown) =>
        host.context().deps.logger.warn('stopping an agent that could not finish starting failed', {
          scope: 'startup-limit',
          sessionId,
          error
        })
      )
  }
}

export function createStructuredAgentSessionFailedStartingChild(
  host: StructuredAgentSessionConversationLifetimeHost
) {
  const { sessions, serialize } = host
  const deps = () => host.context().deps
  const stopAgent = (
    sessionId: string,
    ending: Parameters<typeof stopStructuredAgentSessionAgentUnderSerialize>[2]
  ) => stopStructuredAgentSessionAgentUnderSerialize(host.context(), sessionId, ending)
  return (
    sessionId: string,
    failed: StructuredAgentSessionProviderChildIdentity,
    error: unknown,
    openMs: number
  ): Promise<void> =>
    serialize(sessionId, async () => {
      const session = sessions.get(sessionId)
      const child = session?.child
      if (!session || !child || child.close || !sameProviderChild(child, failed)) {
        return
      }
      const failure = providerStartupFailureFact(error)
      // Persisted facts cannot retain the original error; log it here.
      deps().logger.warn('a provider could not finish starting', {
        scope: 'provider-open-failed',
        sessionId,
        failure: failure.kind,
        ...failure.requestTimeout,
        openMs,
        error
      })
      const { runtimeState: runtime } = host.context()
      const owned = runtime.startFlights.ownsChild(sessionId, child)
      if (owned) {
        const retry = retryableStructuredAgentSessionStart(error)
        runtime.startupAttempts.childFailed(sessionId, child, failure, retry)
      }
      try {
        if (!owned) {
          const record = deps().store.getRecord(sessionId)
          const wording = structuredAgentSessionFailureWordsContext(record)
          await recordStructuredAgentSessionStartFailure(
            { journal: session.journal, fence: child.fence },
            {
              startKey: child.generation,
              ...structuredAgentSessionStartFailure({ failure }, wording)
            },
            oldestQueuedSubmission(session)?.clientMessageId ?? null
          ).catch((writeError: unknown) =>
            deps().logger.warn('recording a failed provider open failed', {
              scope: 'provider-open-failure',
              sessionId,
              error: writeError
            })
          )
        }
        const reason = error instanceof Error ? error.message : String(error)
        await stopAgent(sessionId, { cause: 'host-stop', reason, failure })
      } finally {
        runtime.startupAttempts.childEnded(sessionId, child)
      }
    })
}
