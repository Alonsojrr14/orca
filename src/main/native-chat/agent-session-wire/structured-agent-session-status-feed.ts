import { StructuredAgentSessionStatusWork } from './structured-agent-session-status-work'
import { structuredAgentSessionOwnerEnded } from './structured-agent-session-current-work'
// The host's answer to "what is every structured session doing", fanned out to session lists.
//
// A client used to learn whether a turn was running by replaying the journal through its own
// reducer, which tied the answer to whichever surface happened to hold a reader open: hide the
// chat and the sidebar froze on the last thing it had heard. The host always has the journal, so
// it projects the status once per journal publication and sends only the changes.
//
// The last projection is kept after the session's provider child is evicted: an idle session is
// still idle without a process, and a renderer that reloads must not lose every settled row until
// each chat is reopened. Restart is the one boundary that forgets: the restore publishes each
// restored chat's row from its record and its journal's saved open turn (`publishAtRest`), and the
// chat's first open replaces that with the journal's own projection.

import type { ChildWorkAdmission } from './structured-agent-session-accepted-child-work'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import type { AgentChildWorkRecord } from '../../../shared/agent-status-child-work'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  structuredAgentSessionNamingSnapshot,
  notifyStructuredStatusObservers,
  type StatusFeedSession,
  type StatusPublication,
  type StructuredAgentSessionStatusSubscriber,
  type StructuredAgentSessionStatusFeedDeps
} from './structured-agent-session-status-feed-deps'
import {
  atRestStructuredStatusSummary,
  renamedStructuredStatusSummary,
  retainedStructuredStatusSummaries,
  structuredAgentSessionStatusSummary,
  withoutLiveExecution,
  type StructuredAgentSessionAtRest
} from './structured-agent-session-status-summary'
import { structuredStatusChildWorkFields } from './structured-agent-session-status-child-work'
import {
  StructuredAgentSessionJournalProjections,
  type StructuredAgentSessionJournalProjection
} from './structured-agent-session-status-journal-projection'
import {
  permissionReportOnly,
  structuredStatusSummariesEqual
} from './structured-agent-session-status-summary-equality'
import type { StructuredAgentSessionChildWorkProducer } from './structured-agent-session-subagent-rows'
import type { CapturedChildWorkStops } from './structured-agent-session-status-ownership'

export type { StructuredAgentSessionStatusSink } from './structured-agent-session-status-ownership'
export type { StructuredAgentSessionStatusFeedDeps } from './structured-agent-session-status-feed-deps'

export type { StructuredAgentSessionStatusState } from './structured-agent-session-status-journal-projection'

export type { StructuredAgentSessionStatusSubscriber } from './structured-agent-session-status-feed-deps'

export class StructuredAgentSessionStatusFeed {
  private readonly ownership = new StructuredAgentSessionStatusWork(
    () => this.deps,
    (sessionId) => this.publish(sessionId)
  )
  private readonly subscribers = new Map<string, StructuredAgentSessionStatusSubscriber>()
  // Never evicted: chats are named only while in here, and AI Vault reads closed ones' names here.
  private readonly published = new Map<string, StatusPublication>()
  /** The user's newest accepted send each session was last projected with; a new one retires
   *  settled children. */
  // Read per call: field initializers run before the constructor assigns `deps`.
  private readonly projections = new StructuredAgentSessionJournalProjections((sessionId) =>
    this.deps.replacedRuntime?.(sessionId)
  )

  constructor(private readonly deps: StructuredAgentSessionStatusFeedDeps) {}

  private logFailure(scope: string, message: string, sessionId: string, error: unknown): void {
    this.deps.logger.warn(message, { scope, sessionId, error })
  }

  /** Opens with every session this host has projected, live ones re-read, then only changes. */
  subscribe(subscriber: StructuredAgentSessionStatusSubscriber): () => void {
    // Naming completion must be observable even if a held journal cannot be read.
    if (this.deps.namingActiveSessionIds || this.deps.listConversations) {
      this.emit(subscriber, structuredAgentSessionNamingSnapshot(this.deps))
    }
    // Reproject before registering: existing readers get changes; the new reader gets one snapshot.
    for (const [sessionId] of this.deps.sessions) {
      this.publish(sessionId, undefined, { replay: true })
    }
    this.subscribers.set(subscriber.id, subscriber)
    this.emit(subscriber, {
      type: 'snapshot',
      sessions: retainedStructuredStatusSummaries(this.published.values(), this.deps)
    })
    return () => this.unsubscribe(subscriber.id)
  }

  /** Revoke live ownership/remove sink children while retaining reload history. */
  close(sessionId: string): void {
    this.revokeLive(sessionId)
    this.forget(sessionId)
  }

  /** Drop sink roster membership and refresh retained child projections. */
  forget(sessionId: string): void {
    this.ownership.forgetWork(sessionId)
    try {
      this.ownership.forget(sessionId)
    } catch (error) {
      this.logFailure('status-sink-forget', 'status sink forget failed', sessionId, error)
    }
    const publication = this.published.get(sessionId)
    const previous = publication?.summary
    if (!previous || (!previous.children && !previous.backgroundTasks)) {
      return
    }
    const { children: _children, backgroundTasks: _backgroundTasks, ...rest } = previous
    const retained = { ...rest, ...this.childWorkFields(sessionId, previous.agent) }
    this.published.set(sessionId, {
      summary: retained,
      firstInputSubmissionKey: publication?.firstInputSubmissionKey ?? null
    })
    this.broadcast({ type: 'status', session: retained })
  }

  unsubscribe(id: string): void {
    const subscriber = this.subscribers.get(id)
    if (!subscriber) {
      return
    }
    this.subscribers.delete(id)
    try {
      subscriber.emit({ type: 'end' })
    } catch {}
  }

  /** Retain history but clear live authority/Stopping; this host no longer ends that work. */
  revokeLive(sessionId: string): void {
    const publication = this.published.get(sessionId)
    const previous = publication?.summary
    if (!previous) {
      return
    }
    const retained = withoutLiveExecution(previous)
    this.published.set(sessionId, {
      summary: retained,
      firstInputSubmissionKey: publication?.firstInputSubmissionKey ?? null
    })
    this.sink(retained)
    this.broadcast({ type: 'status', session: retained })
  }

  /** Naming activity is published even when the chat has no retained status row. */
  publishConversationName(sessionId: string): void {
    this.broadcast(structuredAgentSessionNamingSnapshot(this.deps, sessionId))
    this.publishRecordNotes(sessionId)
  }

  publishRecordNotes(sessionId: string): void {
    if (this.deps.sessions.has(sessionId)) {
      this.publish(sessionId)
      return
    }
    const publication = this.published.get(sessionId)
    const summary =
      publication && renamedStructuredStatusSummary(publication.summary, this.deps, sessionId)
    if (publication && summary) {
      this.published.set(sessionId, { ...publication, summary })
      this.broadcast({ type: 'status', session: summary })
    }
  }

  hasUnknownRestart = (sessionId: string): boolean => this.projections.hasUnknownRestart(sessionId)

  readPublished = (sessionId: string): AgentSessionStatusSummary | undefined =>
    this.published.get(sessionId)?.summary

  /** Share per-commit projection with completion and steer-hold readers to avoid repeated snapshots. */
  journalProjection(
    sessionId: string,
    journal?: AgentSessionJournal
  ): StructuredAgentSessionJournalProjection | null {
    const session = this.deps.sessions.get(sessionId)
    const source = journal ?? session?.journal
    return source
      ? this.projections.read(source, this.deps.getConversation(sessionId), session)
      : null
  }

  /** A restored chat this host lists but has not opened, published like any row: to subscribers,
   *  the sink and the status observer, as a re-projection of what the host already knew. */
  publishAtRest(sessionId: string, rest: StructuredAgentSessionAtRest): void {
    const record = this.deps.getConversation(sessionId)
    if (record) {
      if (
        rest.known !== false ||
        rest.interrupted ||
        structuredAgentSessionOwnerEnded(
          { ...record.ownerObservation, runtimeFence: record.currentFence },
          this.deps.replacedRuntime?.(sessionId)
        ) ||
        (rest.known !== false &&
          !rest.openTurn &&
          record.ownerObservation.claimStatus === 'released')
      ) {
        this.projections.noteRestart(sessionId, rest)
      }
      if (this.deps.sessions.has(sessionId)) {
        this.publish(sessionId)
        return
      }
      const summary = atRestStructuredStatusSummary(record, rest, this.deps)
      this.published.set(sessionId, { summary, firstInputSubmissionKey: null })
      this.sink(summary, record.location)
      this.broadcast({ type: 'status', session: summary })
      try {
        this.deps.onStatusChanged?.(summary, { replay: true, firstInputSubmissionKey: null })
      } catch (error) {
        this.logFailure('status-observer', 'status observer failed', sessionId, error)
      }
    }
  }

  /** Re-projects one session after its journal changed; equal projections are not re-sent. */
  publish(sessionId: string, journal?: AgentSessionJournal, options?: { replay?: boolean }): void {
    const session = this.deps.sessions.get(sessionId)
    if (!session) {
      return
    }
    const source = journal ?? session.journal
    const record = this.deps.getConversation(sessionId)
    const projection = this.projections.read(source, record, session)
    this.ownership.retireSettledChildrenOnNewTurn(sessionId, session, projection.acceptedSendKey)
    const summary = structuredAgentSessionStatusSummary({
      sessionId,
      session,
      starting: this.deps.starting?.(sessionId),
      journal: source,
      record,
      state: projection.state,
      stopping: projection.stopping,
      childWork: this.childWorkFields(sessionId, session.params.provider),
      namingFailure: this.deps.namingFailure?.(sessionId),
      now: this.deps.now
    })
    const publication = this.published.get(sessionId)
    const previous = publication?.summary
    const summaryChanged = !previous || !structuredStatusSummariesEqual(previous, summary)
    const inputChanged = publication?.firstInputSubmissionKey !== projection.firstInputSubmissionKey
    const reportOnly = !inputChanged && permissionReportOnly(previous, summary)
    if (!summaryChanged && !inputChanged) {
      if (!this.ownership.matchesLocation(sessionId, session.params.location)) {
        this.sink(summary, session.params.location)
      }
      return
    }
    this.published.set(sessionId, {
      summary,
      firstInputSubmissionKey: projection.firstInputSubmissionKey
    })
    if (summaryChanged) {
      if (!reportOnly || !this.ownership.matchesLocation(sessionId, session.params.location)) {
        this.sink(summary, session.params.location)
      }
      this.broadcast({ type: 'status', session: summary })
    }
    notifyStructuredStatusObservers(this.deps, summary, previous, {
      reportOnly,
      replay: options?.replay === true,
      firstInputSubmissionKey: projection.firstInputSubmissionKey
    })
  }

  /** A finished child's record stays, with its outcome, until the user's next turn: the next send
   *  the provider accepts (see `newestAcceptedSendKey`), unless it still owns live work. No surface
   *  lists it (they list running children only); it stays so a late frame of its run cannot bring
   *  it back as live, so an acknowledged Stop's provisional ending can be replaced by the task's
   *  own, and so its live work keeps its owner. The provider ending the session removes nothing:
   *  children still live settle `unknown`. The one earlier death is the host letting go of the
   *  session, whose row takes every child record with it (see `forget`). A command never settles:
   *  its record goes when it stops. */
  /** The summary's child fields, from the records the store holds for the session. */
  private childWorkFields = (
    sessionId: string,
    provider: StatusFeedSession['params']['provider']
  ) => structuredStatusChildWorkFields(this.readChildWork(sessionId), provider)

  publishHeldSends(...args: Parameters<StructuredAgentSessionStatusWork['publishHeldSends']>) {
    return this.ownership.publishHeldSends(...args)
  }

  handoverChanged(sessionId: string, clientMessageId: string): void {
    this.ownership.handoverChanged(sessionId, clientMessageId)
  }

  /** Publish evidence then refold parent/summary; sink failure must not block other publications. */
  publishChildWork(
    sessionId: string,
    evidence: AgentChildWorkEvidence[],
    producer?: StructuredAgentSessionChildWorkProducer
  ): ChildWorkAdmission {
    const session = this.deps.sessions.get(sessionId)
    if (!session) {
      return { accepted: false, reason: 'closed' }
    }
    return this.ownership.admitChildWork(sessionId, session, evidence, producer)
  }

  readChildWork(sessionId: string): AgentChildWorkView[] | undefined {
    try {
      return this.ownership.readChildWork(sessionId)
    } catch (error) {
      this.logFailure('child-work-read', 'child work read failed', sessionId, error)
      return undefined
    }
  }

  childWorkOpen = (sessionId: string): boolean => this.ownership.childWorkOpen(sessionId)

  captureChildWorkStops = (
    sessionId: string,
    handleIds: readonly string[]
  ): CapturedChildWorkStops => this.ownership.captureChildWorkStops(sessionId, handleIds)

  childWorkIncomplete = (sessionId: string): boolean => {
    try {
      return this.ownership.childWorkIncomplete(sessionId)
    } catch (error) {
      this.logFailure('child-work-read', 'child work read failed', sessionId, error)
      return false
    }
  }

  /** Observer already reports failures; retain host-only facts outside display views. */
  readChildWorkRecords = (sessionId: string): AgentChildWorkRecord[] | undefined =>
    this.ownership.readChildWorkRecords(sessionId)

  /** A failing sink must never cost the subscribers their status event. */
  private sink(
    summary: AgentSessionStatusSummary,
    location?: StatusFeedSession['params']['location']
  ): void {
    try {
      this.ownership.publish(summary, location)
    } catch (error) {
      this.logFailure('status-sink-publish', 'status sink publish failed', summary.sessionId, error)
    }
  }

  private broadcast(event: AgentSessionStatusEvent): void {
    // Map iteration permits failed subscribers to remove themselves.
    for (const subscriber of this.subscribers.values()) {
      this.emit(subscriber, event)
    }
  }

  private emit(subscriber: StructuredAgentSessionStatusSubscriber, event: AgentSessionStatusEvent) {
    try {
      subscriber.emit(event)
    } catch {
      this.subscribers.delete(subscriber.id)
    }
  }
}
