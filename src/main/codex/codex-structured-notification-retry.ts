import type { ChildWorkAdmission } from '../native-chat/agent-session-wire/structured-agent-session-accepted-child-work'
import type { StructuredAgentSessionSinkBarrier } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { CodexAppServerConnection } from './app-server/codex-app-server-connection-types'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-translation'
import type { CodexSession } from './codex-structured-session-state'

const MAX_RETRY_EVENTS = 256
const RETRY_DELAY_MS = 25

type PendingNotification = {
  method: string
  params: unknown
  bytes: number
  retry?: () => CodexJournalTranslationAdmission
  observedAt?: number
  dispatchSequenceAtReceipt?: number
}
type RetryState = {
  connection: CodexAppServerConnection
  events: PendingNotification[]
  bytes: number
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
  failed: boolean
}

export function createCodexStructuredNotificationRetry(deps: {
  sessionFor: (sessionId: string) => CodexSession | undefined
  translate: (
    sessionId: string,
    session: CodexSession,
    method: string,
    params: unknown,
    observedAt?: number,
    dispatchSequenceAtReceipt?: number
  ) => CodexJournalTranslationAdmission
}) {
  const states = new Map<string, RetryState>()

  const clear = (sessionId: string, connection: CodexAppServerConnection | null): void => {
    const state = states.get(sessionId)
    if (!state || (connection && state.connection !== connection)) {
      return
    }
    if (state.timer) {
      clearTimeout(state.timer)
    }
    state.events.length = 0
    state.bytes = 0
    states.delete(sessionId)
    state.connection.resumeReading?.()
  }

  const stateForConnection = (
    sessionId: string,
    connection: CodexAppServerConnection | undefined
  ): RetryState | undefined => {
    const state = states.get(sessionId)
    if (state && connection && state.connection !== connection) {
      clear(sessionId, state.connection)
      return undefined
    }
    return state
  }

  const retry = (sessionId: string, connection: CodexAppServerConnection): void => {
    const state = states.get(sessionId)
    if (!state || state.connection !== connection || state.running || state.failed) {
      return
    }
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    state.running = true
    try {
      while (state.events.length > 0) {
        const pending = state.events[0]
        if (!pending) {
          break
        }
        const session = deps.sessionFor(sessionId)
        if ((!session || session.connection !== connection || session.ended) && !pending.retry) {
          fail(sessionId, state, 'notification retry owner is no longer live')
          break
        }
        const admission: CodexJournalTranslationAdmission = pending.retry
          ? pending.retry()
          : session
            ? deps.translate(
                sessionId,
                session,
                pending.method,
                pending.params,
                pending.observedAt,
                pending.dispatchSequenceAtReceipt
              )
            : { accepted: false as const, reason: 'closed' as const }
        if (!admission.accepted) {
          pending.retry = admission.retry ?? pending.retry
          if (admission.reason === 'backpressure') {
            state.timer = setTimeout(() => {
              state.timer = null
              retry(sessionId, connection)
            }, RETRY_DELAY_MS)
            state.timer.unref?.()
          } else {
            fail(sessionId, state, `notification admission failed (${admission.reason})`)
          }
          break
        }
        state.events.shift()
        state.bytes = Math.max(0, state.bytes - pending.bytes)
      }
      if (!state.failed && state.events.length === 0) {
        states.delete(sessionId)
        connection.resumeReading?.()
      }
    } catch (error) {
      fail(
        sessionId,
        state,
        error instanceof Error ? error.message : 'notification continuation failed'
      )
    } finally {
      state.running = false
    }
  }

  const fail = (sessionId: string, state: RetryState, reason: string): void => {
    if (state.failed) {
      return
    }
    state.failed = true
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    // Unreplayable queues must release paused reads before host recovery.
    state.events.length = 0
    state.bytes = 0
    state.connection.resumeReading?.()
    const session = deps.sessionFor(sessionId)
    if (session?.connection === state.connection) {
      void session.forceCloseUnexpected?.(new Error(reason))
    }
  }

  const enqueue = (
    sessionId: string,
    connection: CodexAppServerConnection,
    method: string,
    params: unknown,
    observedAt: number | undefined,
    dispatchSequenceAtReceipt: number | undefined,
    continuation?: () => CodexJournalTranslationAdmission
  ): boolean => {
    const bytes = Buffer.byteLength(JSON.stringify({ method, params }), 'utf8')
    let state = stateForConnection(sessionId, connection)
    if (!state) {
      state = { connection, events: [], bytes: 0, timer: null, running: false, failed: false }
      states.set(sessionId, state)
    }
    if (state.failed) {
      return false
    }
    if (state.events.length >= MAX_RETRY_EVENTS) {
      fail(sessionId, state, 'notification retry queue overflow')
      return false
    }
    state.events.push({
      method,
      params,
      bytes,
      retry: continuation,
      ...(observedAt !== undefined ? { observedAt } : {}),
      ...(dispatchSequenceAtReceipt !== undefined ? { dispatchSequenceAtReceipt } : {})
    })
    state.bytes += bytes
    connection.pauseReading?.()
    return true
  }

  return {
    written: async (
      sessionId: string,
      written: (() => Promise<StructuredAgentSessionSinkBarrier>) | undefined
    ): Promise<StructuredAgentSessionSinkBarrier> => {
      const landed = await written?.()
      if (landed && !landed.ok) {
        return landed
      }
      const state = stateForConnection(sessionId, deps.sessionFor(sessionId)?.connection)
      if (state) {
        retry(sessionId, state.connection)
      }
      if (state?.failed) {
        return { ok: false, error: new Error('Codex normalized suffix failed') }
      }
      if (states.get(sessionId)?.events.length) {
        return {
          ok: false,
          error: new Error('Codex normalized suffix was not admitted after drain')
        }
      }
      return (await written?.()) ?? { ok: true }
    },
    continueWork: (sessionId: string, append: () => ChildWorkAdmission): ChildWorkAdmission => {
      const session = deps.sessionFor(sessionId)
      if (!session || session.ended) {
        return { accepted: false, reason: 'closed' }
      }
      if (
        !enqueue(sessionId, session.connection, 'accepted-work', null, undefined, undefined, append)
      ) {
        return { accepted: false, reason: 'failed' }
      }
      retry(sessionId, session.connection)
      return states.get(sessionId)?.failed
        ? { accepted: false, reason: 'failed' }
        : { accepted: true }
    },
    handle: (
      sessionId: string,
      method: string,
      params: unknown,
      observedAt?: number,
      dispatchSequenceAtReceipt?: number
    ): CodexJournalTranslationAdmission => {
      const session = deps.sessionFor(sessionId)
      if (!session) {
        return { accepted: true }
      }
      const state = stateForConnection(sessionId, session.connection)
      if (state?.failed) {
        return { accepted: false, reason: 'failed' }
      }
      if (state && state.events.length > 0) {
        enqueue(sessionId, state.connection, method, params, observedAt, dispatchSequenceAtReceipt)
        retry(sessionId, state.connection)
        return { accepted: false, reason: 'backpressure' }
      }
      const admission = deps.translate(
        sessionId,
        session,
        method,
        params,
        observedAt,
        dispatchSequenceAtReceipt
      )
      if (!admission.accepted && admission.reason !== 'backpressure') {
        void session.forceCloseUnexpected?.(
          new Error(`notification admission failed (${admission.reason})`)
        )
      }
      if (!admission.accepted && admission.reason === 'backpressure') {
        enqueue(
          sessionId,
          session.connection,
          method,
          params,
          observedAt,
          dispatchSequenceAtReceipt,
          admission.retry
        )
        retry(sessionId, session.connection)
      }
      return admission
    },
    retry,
    clear
  }
}

export type CodexStructuredNotificationRetry = ReturnType<
  typeof createCodexStructuredNotificationRetry
>
