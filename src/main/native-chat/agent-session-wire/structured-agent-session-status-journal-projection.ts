import {
  atRestStructuredStatusSummary,
  type StructuredAgentSessionAtRest
} from './structured-agent-session-status-summary'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { isStructuredAgentSessionCommandEntry } from '../../../shared/structured-agent-session-command-entry'

import type { AgentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  structuredAgentSessionCurrentWork,
  structuredAgentSessionReplacedRuntimeEnded,
  type StructuredAgentSessionWorkEvidence
} from './structured-agent-session-current-work'
import { newestAcceptedSendKey } from './structured-agent-session-status-child-work'
import { structuredAgentSessionStopping } from './structured-agent-session-stopping'
import { latestNativeChatOrcaStopCut } from '../../../shared/native-chat/native-chat-orca-stop-cut'

export type StructuredAgentSessionStatusState = ReturnType<
  typeof projectStructuredAgentSessionStatusState
>

export type StructuredAgentSessionJournalProjection = {
  epoch: string
  contextId: string | null
  sequence: number
  fence: number | undefined
  /** Live authority may change without a journal row. */
  liveFence: number | null
  /** `StructuredAgentSessionCurrentWork.revision`: what this host saw end with no row or lease
   *  write still changes the row. */
  restored: unknown
  workRevision: number
  /** Stop settlement edges write no row and need an independent cache key. */
  stopRevision: number
  state: StructuredAgentSessionStatusState
  acceptedSendKey: string
  firstInputSubmissionKey: string | null
  submissionCount: number
  stopping: boolean
}

export class StructuredAgentSessionJournalProjections {
  private readonly restored = new Map<
    string,
    {
      rest: StructuredAgentSessionAtRest
      baseline?: { epoch: string; revision: number }
    }
  >()

  hasUnknownRestart = (sessionId: string): boolean =>
    this.restored.get(sessionId)?.rest.known === false

  noteRestart(sessionId: string, rest: StructuredAgentSessionAtRest): void {
    const previous = this.restored.get(sessionId)
    if (!previous || (previous.rest.known === false && rest.known !== false)) {
      this.restored.set(sessionId, { rest, baseline: previous?.baseline })
    }
  }

  // Task progress must not sort and scan an unchanged conversation. Journal identity owns cleanup.
  private readonly byJournal = new WeakMap<
    AgentSessionJournal,
    StructuredAgentSessionJournalProjection
  >()

  constructor(
    private readonly replacedRuntime?: (
      sessionId: string
    ) => StructuredAgentSessionWorkEvidence['replaced']
  ) {}

  read(
    journal: AgentSessionJournal,
    record: AgentSessionConversationView | null,
    seen?: {
      lastEndedChild?: StructuredAgentSessionWorkEvidence['ended']
      operationalRevision?: number
      child?: StructuredAgentSessionWorkEvidence['child']
    }
  ): StructuredAgentSessionJournalProjection {
    const cursor = journal.cursor()
    const contextId = record?.providerContextBoundary?.operationId ?? null
    const fence = record?.currentFence
    const ended = seen?.lastEndedChild
    const work = structuredAgentSessionCurrentWork(journal, {
      record,
      replaced: record ? this.replacedRuntime?.(record.sessionId) : undefined,
      child: seen?.child ?? null,
      ...(ended ? { ended } : {}),
      revision: seen?.operationalRevision ?? 0
    })
    const stopRevision = journal.stopMarks.revision()
    let projection = this.byJournal.get(journal)
    if (
      !projection ||
      projection.epoch !== cursor.epoch ||
      projection.contextId !== contextId ||
      projection.sequence !== cursor.sequence ||
      projection.fence !== fence ||
      projection.liveFence !== work.liveFence ||
      projection.workRevision !== work.revision ||
      projection.stopRevision !== stopRevision ||
      projection.restored !== this.restored.get(journal.sessionId)
    ) {
      // Journal sequence captures sends; lease/live-work/Stop keys capture row-free changes.
      const snapshot = journal.snapshot()
      const sameContext =
        projection?.epoch === cursor.epoch && projection.contextId === contextId
          ? projection
          : undefined
      let firstInputSubmissionKey = sameContext?.firstInputSubmissionKey ?? null
      const start = sameContext?.submissionCount ?? 0
      const floor = sameContext ? 0 : (journal.context.floor()?.sequence ?? 0)
      const submissions =
        !firstInputSubmissionKey && snapshot.submissions.length !== start
          ? journal.submissions()
          : snapshot.submissions
      for (let index = start; !firstInputSubmissionKey && index < submissions.length; index++) {
        const submission = submissions[index]
        const item =
          journal.item(agentJournalSubmissionKey(submission.clientMessageId)) ??
          (submission.providerItemId ? journal.item(submission.providerItemId) : null)
        if (
          item &&
          item.sequence > floor &&
          item.body.kind === 'message' &&
          item.body.role === 'user' &&
          isRootAgentJournalItem(item) &&
          !isStructuredAgentSessionCommandEntry(item.body)
        ) {
          firstInputSubmissionKey = JSON.stringify([cursor.epoch, submission.clientMessageId])
        }
      }
      projection = {
        ...cursor,
        restored: this.restored.get(journal.sessionId),
        contextId,
        firstInputSubmissionKey,
        submissionCount: snapshot.submissions.length,
        fence,
        liveFence: work.liveFence,
        workRevision: work.revision,
        stopRevision,
        state: withDiedTurnVerdict(
          projectStructuredAgentSessionStatusState(
            snapshot.items,
            snapshot.submissions.map(work.publishedSubmission),
            fence,
            work.scope
          ),
          work.diedTurn()
        ),
        acceptedSendKey: newestAcceptedSendKey(cursor.epoch, snapshot.submissions),
        stopping: structuredAgentSessionStopping(
          journal,
          snapshot.items,
          snapshot.submissions,
          work.scope
        )
      }
      projection.state = this.restartVerdict(
        projection.state,
        journal,
        record,
        seen?.child !== undefined && seen.child !== null,
        snapshot
      )
      this.byJournal.set(journal, projection)
    }
    return projection
  }
  private restartVerdict(
    state: StructuredAgentSessionStatusState,
    journal: AgentSessionJournal,
    record: AgentSessionConversationView | null,
    liveChild: boolean,
    snapshot: ReturnType<AgentSessionJournal['snapshot']>
  ): StructuredAgentSessionStatusState {
    if (!record) {
      return state
    }
    const id = record.sessionId
    if (liveChild) {
      this.restored.delete(id)
    }
    const presentation = this.restored.get(id)
    const version = { epoch: journal.epoch, revision: journal.restRevision() }
    if (presentation) {
      const before = presentation.baseline ?? {
        epoch: journal.epoch,
        revision: journal.openedRestRevision
      }
      if (before && (before.epoch !== version.epoch || before.revision !== version.revision)) {
        this.restored.delete(id)
      } else {
        presentation.baseline = version
        const rest = presentation.rest
        const saved = atRestStructuredStatusSummary(record, rest, { now: () => rest.lastSavedAt })
        return {
          ...state,
          summary: {
            ...state.summary,
            status: saved.status,
            turnOutcome: saved.turnOutcome,
            restoredInterruption: saved.restoredInterruption,
            statusStartedAt: saved.statusStartedAt
          }
        }
      }
    }
    const cut = journal.restFact()
    const replaced = this.replacedRuntime?.(id)
    const fence = cut && journal.itemFence(cut.itemId)
    const ended =
      !liveChild &&
      (!!record.ownerObservation.deathEvidence?.runtimeEnd ||
        (replaced &&
          structuredAgentSessionReplacedRuntimeEnded(
            { ...record.ownerObservation, runtimeFence: record.currentFence },
            replaced
          ) &&
          fence !== undefined &&
          fence !== null &&
          fence <= replaced.fence))
    return cut &&
      (state.summary.status === 'idle' || state.summary.status === null) &&
      (ended ||
        latestNativeChatOrcaStopCut(snapshot.items, snapshot.submissions)?.turnItemId ===
          cut.itemId)
      ? {
          ...state,
          summary: {
            ...state.summary,
            status: 'idle',
            turnOutcome: 'cancellation',
            restoredInterruption: true,
            statusStartedAt: cut.since
          }
        }
      : state
  }
}

/** Project proven child death immediately, before durable settlement can land. */
function withDiedTurnVerdict(
  state: StructuredAgentSessionStatusState,
  died: { turnId: string } | null
): StructuredAgentSessionStatusState {
  const request = state.latestRequest
  return died &&
    state.summary.status === 'idle' &&
    request?.kind === 'turn' &&
    request.id === died.turnId &&
    request.turnState === 'running'
    ? { ...state, summary: { ...state.summary, turnOutcome: 'interruption' } }
    : state
}
