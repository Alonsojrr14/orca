import {
  seedSavedStructuredSessionTabs,
  type SavedStructuredStatusGroup
} from './structured-agent-session-saved-status'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

/** Retire durable tabs/restart offers together; advisory recovery bookkeeping must never block chat close. */
export function setStructuredAgentSessionTabVisibility(
  host: {
    deps: {
      logger: StructuredAgentSessionLogger
      store: {
        setSessionTabVisibility: (
          sessionId: string,
          visible: boolean,
          tabId?: string
        ) => Promise<void>
      }
      onSessionTabHidden?: (sessionId: string) => void
    }
    restartResume: { dismiss: (sessionIds: readonly string[]) => Promise<number> }
  },
  sessionId: string,
  visible: boolean,
  tabId?: string
): Promise<void> {
  if (!visible) {
    void host.restartResume.dismiss([sessionId]).catch(() => {
      host.deps.logger.warn('forgetting recovery records on chat close failed', {
        scope: 'tab-close-recovery-dismiss',
        sessionId
      })
    })
  }
  return host.deps.store.setSessionTabVisibility(sessionId, visible, tabId)
}

export type StructuredAgentSessionTab = {
  sessionId: string
  workspaceId: string
  agent: AgentSessionRecord['provider']
}

export function listStructuredAgentSessionTabs(
  sessions: ReadonlyMap<
    string,
    { params: { location: { workspaceId: string }; provider: AgentSessionRecord['provider'] } }
  >
): StructuredAgentSessionTab[] {
  return [...sessions.entries()].map(([sessionId, session]) => ({
    sessionId,
    workspaceId: session.params.location.workspaceId,
    agent: session.params.provider
  }))
}

type TabSessions = ReadonlyMap<
  string,
  {
    child?: unknown
    params: { location: { workspaceId: string }; provider: AgentSessionRecord['provider'] }
  }
>

export function createStructuredAgentSessionTabSurface(
  host: Parameters<typeof setStructuredAgentSessionTabVisibility>[0] & {
    deps: Pick<StructuredAgentSessionHostDeps, 'recoveryCapsule' | 'now'> & {
      store: Pick<
        AgentSessionRecordStore,
        | 'getVisibleSessionTabIndex'
        | 'getSessionTabId'
        | 'showSessionTabs'
        | 'getConversation'
        | 'listConversations'
      >
    }
  },
  sessions: TabSessions,
  forgetStatus: (sessionId: string) => void,
  publishSavedStatusGroup: SavedStructuredStatusGroup,
  recover: (ids: readonly string[]) => Promise<void>
) {
  // Legacy profile tabs remain addressable before their index is seeded.
  const unopened = new Set<string>()
  return {
    listSessionTabs: (): StructuredAgentSessionTab[] => {
      const index = host.deps.store.getVisibleSessionTabIndex()
      const listed = index.present ? index.sessionIds : [...unopened]
      return [
        ...listStructuredAgentSessionTabs(sessions),
        ...listed.flatMap((sessionId) => {
          const record = sessions.has(sessionId) ? null : host.deps.store.getConversation(sessionId)
          return record
            ? [{ sessionId, workspaceId: record.location.workspaceId, agent: record.provider }]
            : []
        })
      ]
    },
    seedSessionTabs: (ids?: readonly string[]): Promise<void> =>
      seedSavedStructuredSessionTabs(
        host.deps,
        ids,
        (visit) =>
          publishSavedStatusGroup((publish) =>
            visit((record, markerAt) => {
              unopened.add(record.sessionId)
              publish(record, markerAt)
            })
          ),
        recover
      ),
    getPersistedVisibleSessionTabIndex: () => host.deps.store.getVisibleSessionTabIndex(),
    getSessionTabId: (sessionId: string): string | null =>
      host.deps.store.getSessionTabId(sessionId),
    showSessionTabs: (sessionIds: readonly string[]) => host.deps.store.showSessionTabs(sessionIds),
    notifySessionTabHidden: (sessionId: string): void => notifyTabHidden(host, sessionId),
    setSessionTabVisibility: async (
      sessionId: string,
      visible: boolean,
      tabId?: string,
      /** Defer hidden notices while a failed close could restore visibility. */
      options?: { deferHiddenNotice?: boolean }
    ): Promise<void> => {
      await setStructuredAgentSessionTabVisibility(host, sessionId, visible, tabId)
      if (!visible) {
        unopened.delete(sessionId)
        if (!options?.deferHiddenNotice) {
          notifyTabHidden(host, sessionId)
        }
      }
      // Tab visibility and handle closure jointly determine status-row lifetime.
      if (!visible && !sessions.get(sessionId)?.child) {
        forgetStatus(sessionId)
      }
    }
  }
}

function notifyTabHidden(
  host: Parameters<typeof setStructuredAgentSessionTabVisibility>[0],
  sessionId: string
): void {
  try {
    host.deps.onSessionTabHidden?.(sessionId)
  } catch (error) {
    host.deps.logger.warn('a chat tab close listener failed', {
      scope: 'tab-hidden-listener',
      sessionId,
      error
    })
  }
}
