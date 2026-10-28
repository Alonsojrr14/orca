import {
  finishChildWorkAdmission,
  type ChildWorkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-accepted-child-work'
import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps
} from './structured/claude-structured-session-state'
import { drainClaudeChildWork } from './claude-child-work-evidence'

export function publishClaudeChildWork(
  deps: ClaudeStructuredSessionAdapterDeps,
  sessionId: string,
  session: ClaudeSession | null | undefined,
  message: Record<string, unknown> | null = null
): ChildWorkAdmission {
  if (!session) {
    return { accepted: true }
  }
  let previous = session.retryChildWork
  const evidence = drainClaudeChildWork(session, message, deps.now?.() ?? Date.now())
  const retain = (admission: ChildWorkAdmission): ChildWorkAdmission => {
    const retry = admission.retry
    session.retryChildWork = !admission.accepted && retry ? () => retain(retry()) : undefined
    if (!admission.accepted && admission.reason === 'backpressure') {
      session.connection.pauseReading?.()
    }
    return admission
  }
  const admission = evidence.length
    ? (deps.onChildWorkEvidence?.(
        sessionId,
        evidence,
        session.events && {
          ...session.events,
          tryAppendTransition: (transition) => {
            const head = previous?.()
            if (head && !head.accepted) {
              return head
            }
            previous = undefined
            return (
              session.events?.tryAppendTransition?.(transition) ?? {
                accepted: false,
                reason: 'closed'
              }
            )
          },
          continueWork: (append) => {
            let previous = session.retryChildWork
            const next = (): ChildWorkAdmission => {
              const head = previous?.()
              if (head && !head.accepted) {
                return { ...head, retry: next }
              }
              previous = undefined
              return append()
            }
            return retain(next())
          },
          written: async () => {
            const result = await session.events?.written?.()
            if (result && !result.ok) {
              return result
            }
            return finishChildWorkAdmission(session.retryChildWork?.(), session.events)
          }
        }
      ) ?? { accepted: true })
    : { accepted: true as const }
  if (!evidence.length && previous) {
    return retain(previous())
  }
  return retain(admission)
}

export function finishClaudeChildWorkAfterClose(
  deps: ClaudeStructuredSessionAdapterDeps,
  sessionId: string,
  session: ClaudeSession | undefined,
  publish: (sessionId: string, session: ClaudeSession | undefined) => ChildWorkAdmission
): void {
  void finishChildWorkAdmission(publish(sessionId, session), session?.events).then((result) => {
    if (!result.ok) {
      deps.logger?.warn('Claude child work ended unwritten', {
        scope: 'claude-child-work',
        sessionId,
        error: result.error
      })
    }
  })
}
