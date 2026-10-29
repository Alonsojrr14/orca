import type { AgentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import {
  AGENT_SESSION_TURN_PREVIEW_CHARS,
  type AgentSessionLastTurn
} from '../../../shared/agent-session-last-turn'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StatusPublication } from './structured-agent-session-status-feed-deps'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import { structuredSummaryConversationNaming } from './structured-agent-session-status-summary'
import { agentSessionPinnedLaunchDirectory } from '../../runtime/agent-session-record-launch-directory'
import { normalizeOptionalField } from '../../../shared/agent-status-field-normalization'
import { AGENT_MODEL_MAX_LENGTH } from '../../../shared/agent-status-types'
import { isAgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'

export function savedStructuredAgentSessionStatus(
  record: AgentSessionConversationView,
  markerAt?: number
): AgentSessionStatusSummary {
  const turn = record.lastTurn
  const at = turn?.at ?? markerAt
  const outcome =
    turn?.state === 'open' || (!turn && markerAt !== undefined) ? 'cancellation' : turn?.outcome
  const model = normalizeOptionalField(record.options?.model, AGENT_MODEL_MAX_LENGTH)
  const launchDirectory = agentSessionPinnedLaunchDirectory(record)
  return {
    sessionId: record.sessionId,
    workspaceId: record.location.workspaceId,
    agent: record.provider,
    status: turn || markerAt !== undefined ? 'idle' : null,
    latestPrompt: turn?.prompt ?? '',
    runtimePermission: null,
    ...(turn?.reply ? { lastAssistantMessage: turn.reply } : {}),
    ...(outcome ? { turnOutcome: outcome } : {}),
    ...(at !== undefined ? { statusStartedAt: at } : {}),
    ...(model ? { model } : {}),
    ...(isAgentChatPermissionMode(record.permissionMode)
      ? { permissionMode: record.permissionMode }
      : {}),
    ...(launchDirectory ? { launchDirectory } : {}),
    ...structuredSummaryConversationNaming(record, undefined),
    ...(typeof record.sleptAt === 'number' ? { sleptAt: record.sleptAt } : {}),
    updatedAt: at ?? record.createdAt
  }
}

/** Only turn edges write; streamed prose and synthetic startup rows never reach this observer. */
export class StructuredAgentSessionSavedStatus {
  private readonly edges = new Map<string, string>()
  private readonly pending = new Set<Promise<void>>()

  constructor(
    private readonly deps: () => Pick<StructuredAgentSessionHostDeps, 'store' | 'logger'>
  ) {}

  observe = (summary: AgentSessionStatusSummary): void => {
    const state =
      summary.status === 'working' || summary.status === 'attention' ? 'open' : 'settled'
    const outcome = state === 'settled' ? summary.turnOutcome : undefined
    const at = summary.statusStartedAt
    // Clearing or rewinding to an empty conversation removes the previous turn.
    if (at === undefined && state === 'open') {
      return
    }
    const key = JSON.stringify([state, outcome, at])
    if (this.edges.get(summary.sessionId) === key) {
      return
    }
    this.edges.set(summary.sessionId, key)
    const lastTurn: AgentSessionLastTurn | undefined =
      at === undefined
        ? undefined
        : {
            state,
            at,
            ...(outcome ? { outcome } : {}),
            prompt: summary.latestPrompt.slice(0, AGENT_SESSION_TURN_PREVIEW_CHARS),
            ...(summary.lastAssistantMessage
              ? { reply: summary.lastAssistantMessage.slice(0, AGENT_SESSION_TURN_PREVIEW_CHARS) }
              : {})
          }
    const write = this.deps()
      .store.transitionHandoff(summary.sessionId, (record) => {
        const { lastTurn: _previous, ...rest } = record
        return lastTurn ? { ...rest, lastTurn } : _previous ? rest : record
      })
      .then(
        () => {},
        (error: unknown) => {
          if (this.edges.get(summary.sessionId) === key) {
            this.edges.delete(summary.sessionId)
          }
          this.deps().logger.warn('saving chat status failed', {
            scope: 'saved-status',
            sessionId: summary.sessionId,
            error
          })
        }
      )
    this.pending.add(write)
    void write.finally(() => this.pending.delete(write))
  }

  async drain(): Promise<void> {
    while (this.pending.size) {
      await Promise.all(this.pending)
    }
  }
}

export function createSavedStructuredStatusPublisher(
  isOpen: (id: string) => boolean,
  published: Map<string, StatusPublication>,
  sink: (summary: AgentSessionStatusSummary, location: AgentSessionExecutionLocation) => void,
  broadcast: (event: AgentSessionStatusEvent) => void
): (record: AgentSessionConversationView, markerAt?: number) => void {
  return (record, markerAt) => {
    if (isOpen(record.sessionId) || published.has(record.sessionId)) {
      return
    }
    const summary = savedStructuredAgentSessionStatus(record, markerAt)
    published.set(record.sessionId, { summary, firstInputSubmissionKey: null })
    sink(summary, record.location)
    broadcast({ type: 'status', session: summary })
  }
}

export async function seedSavedStructuredSessionTabs(
  deps: Pick<StructuredAgentSessionHostDeps, 'logger' | 'recoveryCapsule' | 'now'> & {
    store: Pick<
      AgentSessionRecordStore,
      'getVisibleSessionTabIndex' | 'listConversations' | 'getConversation'
    >
  },
  ids: readonly string[] | undefined,
  visit: (record: AgentSessionConversationView, markerAt?: number) => void,
  recover: (ids: readonly string[]) => Promise<void>
): Promise<void> {
  const index = deps.store.getVisibleSessionTabIndex()
  const targets =
    ids ??
    (index.present
      ? index.sessionIds
      : deps.store.listConversations().map((record) => record.sessionId))
  await recover(targets)
  const markers = new Map<string, number>()
  try {
    const capsule = deps.recoveryCapsule
    const now = deps.now?.() ?? Date.now()
    const [pending, failed] = await Promise.all([capsule?.list(now), capsule?.listFailed(now)])
    for (const marker of [...(pending ?? []), ...(failed ?? []).map((entry) => entry.marker)]) {
      markers.set(marker.sessionId, marker.recordedAt)
    }
  } catch (error) {
    deps.logger.warn('reading saved chat recovery status failed', { scope: 'saved-status', error })
  }
  for (const id of targets) {
    const record = deps.store.getConversation(id)
    if (record) {
      visit(record, markers.get(id))
    }
  }
}
