// Restore addressability from persisted identity without starting a child; failed journal opens retain a Retry tab.

import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import { materializeJournalLegacyCut } from '../agent-session-journal/journal-row-table'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { journalOpenRefusal } from '../agent-session-journal/journal-open-failure'
import {
  listStructuredAgentSessionsOnRestart,
  type StructuredAgentSessionRestartListingDeps
} from './structured-agent-session-restart-restore'
import { StructuredAgentSessionRestartRestoreGate } from './structured-agent-session-restart-restore-gate'
import {
  createReaderReconcile,
  reportEachFailureOnce
} from './structured-agent-session-restart-reconcile'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionReveal
} from './structured-agent-session-host-types'

export async function revealStructuredAgentSession(
  deps: { store: Pick<StructuredAgentSessionHostDeps['store'], 'getConversation'> },
  sessionId: string,
  openConversation: (sessionId: string) => Promise<unknown>
): Promise<StructuredAgentSessionReveal> {
  const record = deps.store.getConversation(sessionId)
  if (!record) {
    throw agentSessionRefusalError('agent_session_identity_required', { reason: 'recordMissing' })
  }
  // Reveal grants no ownership, so contested/reconciling leases must remain inspectable.
  const openRefusal = await openConversation(sessionId).then(
    () => null,
    (error: unknown) => journalOpenRefusal(error)
  )
  return {
    sessionId,
    // Record-authoritative workspace prevents caller-directed tab publication.
    workspaceId: record.location.workspaceId,
    agent: record.provider,
    readable: openRefusal === null,
    ...(openRefusal ? { openRefusal } : {})
  }
}

/** The host's startup listing: reconcile, resolve, then list each chat from its record and its
 *  journal's saved open turn, opening none. Its lease bookkeeping is a reader's, which never fails
 *  a read or startup; startup shares it. */
export function createStructuredAgentSessionHostRestore(
  deps: StructuredAgentSessionHostDeps,
  wiring: Pick<StructuredAgentSessionRestartListingDeps, 'hasSession' | 'onListed'> & {
    reconcileLeases: (sessionId: string) => Promise<AgentSessionWireRefusal | null>
    reconcileRestartLeases: () => Promise<AgentSessionWireRefusal | null>
    resolveRecovery: (sessionId: string) => Promise<unknown>
  }
): {
  reconcileRestartLeases: () => Promise<void>
  restoreReadableSessions: (sessionIds?: readonly string[]) => Promise<void>
} {
  const failures = reportEachFailureOnce(deps.logger)
  const reconcile = createReaderReconcile(wiring.reconcileLeases, failures)
  const reconcileStartup = createReaderReconcile(wiring.reconcileRestartLeases, failures)
  const listing: StructuredAgentSessionRestartListingDeps = {
    store: deps.store,
    journalDatabase: deps.journalDatabase,
    logger: deps.logger,
    reconcileAll: reconcileStartup,
    reconcile,
    // Attach/send must retry recovery strictly before acting.
    resolveRecovery: (sessionId) =>
      wiring.resolveRecovery(sessionId).then(
        () => true,
        (error: unknown) => {
          failures.report(error)
          return false
        }
      ),
    readWorkingAtTeardown: async () => {
      try {
        const markers = (await deps.recoveryCapsule?.list(deps.now?.() ?? Date.now())) ?? []
        for (const marker of markers) {
          try {
            materializeJournalLegacyCut(
              deps.journalDatabase.db,
              marker.sessionId,
              marker.recordedAt
            )
          } catch (error) {
            deps.logger.warn('saving legacy restart fact failed', {
              scope: 'legacy-restart-fact',
              sessionId: marker.sessionId,
              error
            })
          }
        }
        return new Set(markers.map((marker) => marker.sessionId))
      } catch {
        // Advisory: a capsule that cannot be read leaves only the journals' own open turns.
        deps.logger.warn('reading restart offers at startup failed', {
          scope: 'restart-restore-markers'
        })
        return new Set()
      }
    },
    hasSession: wiring.hasSession,
    onListed: wiring.onListed
  }
  const gate = new StructuredAgentSessionRestartRestoreGate()
  return {
    reconcileRestartLeases: async () => {
      await reconcileStartup()
    },
    restoreReadableSessions: (sessionIds) =>
      gate.run(() => listStructuredAgentSessionsOnRestart(listing, sessionIds))
  }
}
