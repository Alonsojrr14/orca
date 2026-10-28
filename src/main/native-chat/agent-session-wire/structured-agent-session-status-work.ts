import { structuredAgentSessionHandingOver } from './structured-agent-session-handing-over'
import {
  finishChildWorkAdmission,
  acceptedSubmissionWork,
  type ChildWorkAdmission
} from './structured-agent-session-accepted-child-work'
import { structuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import type {
  StatusFeedSession,
  StructuredAgentSessionStatusFeedDeps
} from './structured-agent-session-status-feed-deps'
import type { StructuredAgentSessionChildWorkProducer } from './structured-agent-session-subagent-rows'
import { StructuredAgentSessionStatusOwnership } from './structured-agent-session-status-ownership'

export class StructuredAgentSessionStatusWork extends StructuredAgentSessionStatusOwnership {
  private readonly heldProducers = new Map<string, StructuredAgentSessionChildWorkProducer>()
  private readonly acceptedSends = new Map<string, string>()

  constructor(
    private readonly deps: () => StructuredAgentSessionStatusFeedDeps,
    private readonly publishSession: (sessionId: string) => void
  ) {
    super(() => deps().statusSink?.())
  }

  forgetWork(sessionId: string): void {
    this.heldProducers.delete(sessionId)
    this.acceptedSends.delete(sessionId)
  }

  retireSettledChildrenOnNewTurn(
    sessionId: string,
    session: StatusFeedSession,
    acceptedSendKey: string
  ): void {
    const seen = this.acceptedSends.has(sessionId)
    const previous = this.acceptedSends.get(sessionId)
    this.acceptedSends.set(sessionId, acceptedSendKey)
    if (!seen || acceptedSendKey === previous) {
      return
    }
    this.admitChildWork(sessionId, session, [
      { type: 'turn-started', observedAt: this.deps().now() }
    ])
  }

  publishHeldSends(
    sessionId: string,
    changes: readonly { clientMessageId: string; held: boolean }[],
    producer: StructuredAgentSessionChildWorkProducer | undefined
  ): ChildWorkAdmission {
    const session = this.deps().sessions.get(sessionId)
    if (!session || !producer) {
      return { accepted: false, reason: 'closed' }
    }
    this.heldProducers.set(sessionId, producer)
    return acceptedSubmissionWork(
      session.journal,
      changes.map((change) => ({
        ...change,
        held:
          change.held ||
          structuredAgentSessionHandingOver(session.journal).has(change.clientMessageId)
      })),
      producer,
      () => this.publishSession(sessionId)
    )()
  }

  handoverChanged(sessionId: string, clientMessageId: string): void {
    const session = this.deps().sessions.get(sessionId)
    const producer = this.heldProducers.get(sessionId)
    const held = session?.child?.heldSends?.()
    if (!session || !producer || held === undefined) {
      return
    }
    const append = acceptedSubmissionWork(
      session.journal,
      [
        {
          clientMessageId,
          held:
            held.has(clientMessageId) ||
            structuredAgentSessionHandingOver(session.journal).has(clientMessageId)
        }
      ],
      producer,
      () => this.publishSession(sessionId)
    )
    void finishChildWorkAdmission(producer.continueWork?.(append) ?? append(), producer).then(
      (result) => {
        if (!result.ok) {
          this.deps().logger.warn('handover ended unwritten', {
            scope: 'held-work',
            sessionId,
            error: result.error
          })
        }
      }
    )
  }

  admitChildWork(
    sessionId: string,
    session: StatusFeedSession,
    evidence: AgentChildWorkEvidence[],
    producer?: StructuredAgentSessionChildWorkProducer
  ): ChildWorkAdmission {
    try {
      return this.publishChildWork(
        sessionId,
        evidence,
        session.params.provider,
        producer,
        {
          journal: session.journal,
          scope: () =>
            structuredAgentSessionCurrentWork(session.journal, {
              record: this.deps().getConversation(sessionId),
              child: session.child ?? null,
              ended: session.lastEndedChild,
              replaced: this.deps().replacedRuntime?.(sessionId)
            }).turnScope()
        },
        () => {
          this.deps().onChildWorkChanged?.(sessionId, producer)
          this.publishSession(sessionId)
        }
      )
    } catch (error) {
      this.deps().logger.warn('child work publish failed', {
        scope: 'child-work-publish',
        sessionId,
        error
      })
      return { accepted: false, reason: 'failed' }
    }
  }
}
