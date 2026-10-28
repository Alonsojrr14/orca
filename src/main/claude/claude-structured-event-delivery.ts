import {
  finishChildWorkAdmission,
  type ChildWorkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-accepted-child-work'
import { claudePromptCardWritten } from './claude-child-work-evidence'
import {
  resetClaudeRetiredModel,
  retireClaudeLaunchedModel
} from './claude-structured-retired-model'
import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

type ClaudeEventDelivery = {
  session: ClaudeSession | null
  event: ClaudeStructuredSessionEvent
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'onEvent' | 'requestTimeoutMs' | 'logger'>
  publishChildWork: (
    sessionId: string,
    session?: ClaudeSession | null,
    message?: Record<string, unknown> | null
  ) => ChildWorkAdmission
}

export function emitClaudeStructuredSessionEvent({
  session,
  event,
  deps,
  publishChildWork
}: ClaudeEventDelivery): void {
  if (event.type === 'ended') {
    session?.childWork.clear()
    session?.backgroundTasks.clear()
  } else if (event.type === 'message') {
    session?.childWork.observe(event.message)
    session?.backgroundTasks.observe(event.message, event.startsTurn === true)
  } else if (event.type === 'prompt-cancelled') {
    // Clear waiting before journaling cancellation so status cannot wait on a closed card.
    publishChildWork(event.sessionId, session)
  }
  if (event.type === 'message' && session?.commands.observe(event.message)) {
    session.events?.publish()
  }
  session?.translator?.handle(event)
  const retired =
    event.type === 'message' && session ? retireClaudeLaunchedModel(session, event.message) : null
  if (session && retired !== null) {
    resetClaudeRetiredModel(session, deps, event.sessionId, retired)
  }
  let admission = publishChildWork(
    event.sessionId,
    session,
    event.type === 'message' ? event.message : null
  )
  let notified = false
  const notify = (): void => {
    if (notified) {
      return
    }
    notified = true
    try {
      deps.onEvent?.(event)
    } catch (error) {
      deps.logger?.warn('Claude event observer failed', { scope: 'claude-event', error })
    }
  }
  let notification: ChildWorkAdmission | undefined
  const display = (): ChildWorkAdmission => {
    if (notification?.accepted) {
      return notification
    }
    if (session?.events?.tryAppendTransition) {
      const result = session.events.tryAppendTransition({
        steps: [],
        lifecycle: false,
        publish: false,
        onPublished: notify
      })
      notification = result.accepted ? result : { ...result, retry: display }
      return notification
    }
    notify()
    notification = { accepted: true }
    return notification
  }
  const retain = (result: ChildWorkAdmission): ChildWorkAdmission => {
    const retry = result.retry
    if (session && event.type !== 'ended') {
      session.retryChildWork = !result.accepted && retry ? () => retain(retry()) : undefined
      if (!result.accepted && result.reason === 'backpressure') {
        session.connection.pauseReading?.()
      }
    }
    return result
  }
  if (!admission.accepted && session?.retryChildWork) {
    const retry = session.retryChildWork
    let childWork = admission
    const resume = (): ChildWorkAdmission => {
      if (!childWork.accepted) {
        childWork = retry()
      }
      if (childWork.accepted) {
        session.retryChildWork = undefined
        const displayed = retain(display())
        return event.type === 'ended' ? childWork : displayed
      }
      return retain({ ...childWork, retry: resume })
    }
    session.retryChildWork = resume
    admission = { ...admission, retry: resume }
  } else if (admission.accepted) {
    retain(display())
  }
  if (event.type === 'ended') {
    // Physical exit must survive a refused semantic suffix; successful delivery keeps queue order.
    void Promise.resolve().then(async () => {
      let result = await finishChildWorkAdmission(admission, session?.events)
      if (result.ok) {
        result = await finishChildWorkAdmission(notification, session?.events)
      }
      if (!result.ok) {
        notify()
        try {
          deps.logger?.warn('Claude exit work ended unwritten', {
            scope: 'claude-child-work',
            sessionId: event.sessionId,
            error: result.error
          })
        } catch (error) {
          console.warn('[claude-exit] exit work reporter failed', error)
        }
      }
    })
  }
  // A prompt blocks its child only after the journal has written its card.
  void claudePromptCardWritten(session, event)
    ?.then(() => publishChildWork(event.sessionId))
    .catch((error: unknown) =>
      deps.logger?.warn('Claude prompt work ended unwritten', { scope: 'claude-child-work', error })
    )
}
