import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChildWorkAdmission } from '../native-chat/agent-session-wire/structured-agent-session-accepted-child-work'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-translation'
import { createCodexStructuredNotificationRetry } from './codex-structured-notification-retry'
import { optionSession } from './codex-structured-option-session.test-fixture'

const SESSION_ID = 'session-1'

function retrySession() {
  const session = optionSession(async () => ({}))
  const connection = {
    ...session.connection,
    pauseReading: vi.fn(),
    resumeReading: vi.fn()
  }
  const forceCloseUnexpected = vi.fn(async () => false)
  session.connection = connection
  session.forceCloseUnexpected = forceCloseUnexpected
  return { session, connection, forceCloseUnexpected }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

it.each(['failed', 'closed'] as const)(
  'retains an immediate %s continuation failure until matching cleanup',
  async (reason) => {
    const { session, connection, forceCloseUnexpected } = retrySession()
    const translate = vi.fn(() => ({ accepted: true as const }))
    const retries = createCodexStructuredNotificationRetry({
      sessionFor: () => session,
      translate
    })
    const append = vi.fn<() => ChildWorkAdmission>(() => ({ accepted: false, reason }))

    expect(retries.continueWork(SESSION_ID, append)).toEqual({
      accepted: false,
      reason: 'failed'
    })
    expect(await retries.written(SESSION_ID, async () => ({ ok: true }))).toMatchObject({
      ok: false,
      error: expect.any(Error)
    })
    expect(retries.handle(SESSION_ID, 'turn/completed', {})).toEqual({
      accepted: false,
      reason: 'failed'
    })
    expect(translate).not.toHaveBeenCalled()
    expect(connection.resumeReading).toHaveBeenCalledOnce()
    expect(forceCloseUnexpected).toHaveBeenCalledExactlyOnceWith(
      new Error(`notification admission failed (${reason})`)
    )

    retries.clear(SESSION_ID, retrySession().connection)
    append.mockReturnValue({ accepted: true })
    expect(retries.continueWork(SESSION_ID, append)).toEqual({
      accepted: false,
      reason: 'failed'
    })
    expect(append).toHaveBeenCalledOnce()
    expect(await retries.written(SESSION_ID, undefined)).toMatchObject({ ok: false })

    retries.clear(SESSION_ID, connection)
    expect(retries.continueWork(SESSION_ID, append)).toEqual({ accepted: true })
    expect(await retries.written(SESSION_ID, undefined)).toEqual({ ok: true })
    expect(append).toHaveBeenCalledTimes(2)
    expect(forceCloseUnexpected).toHaveBeenCalledOnce()
  }
)

it('retains a timer-driven fatal notification refusal through drain and clears for recovery', async () => {
  const { session, connection, forceCloseUnexpected } = retrySession()
  const suffix = vi.fn<() => CodexJournalTranslationAdmission>(() => ({
    accepted: false,
    reason: 'backpressure'
  }))
  const translate = vi
    .fn<Parameters<typeof createCodexStructuredNotificationRetry>[0]['translate']>()
    .mockReturnValue({ accepted: false, reason: 'backpressure', retry: suffix })
  const sessionFor = vi
    .fn<Parameters<typeof createCodexStructuredNotificationRetry>[0]['sessionFor']>()
    .mockReturnValue(session)
  const retries = createCodexStructuredNotificationRetry({
    sessionFor,
    translate
  })

  expect(retries.handle(SESSION_ID, 'turn/completed', {})).toMatchObject({
    accepted: false,
    reason: 'backpressure'
  })
  expect(connection.pauseReading).toHaveBeenCalledOnce()
  expect(connection.resumeReading).not.toHaveBeenCalled()
  suffix.mockReturnValue({ accepted: false, reason: 'closed' })
  await vi.advanceTimersByTimeAsync(25)

  expect(await retries.written(SESSION_ID, async () => ({ ok: true }))).toMatchObject({
    ok: false,
    error: expect.any(Error)
  })
  const append = vi.fn<() => ChildWorkAdmission>(() => ({ accepted: true }))
  expect(retries.continueWork(SESSION_ID, append)).toEqual({ accepted: false, reason: 'failed' })
  expect(append).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(100)
  expect(suffix).toHaveBeenCalledTimes(2)
  expect(connection.resumeReading).toHaveBeenCalledOnce()
  expect(forceCloseUnexpected).toHaveBeenCalledExactlyOnceWith(
    new Error('notification admission failed (closed)')
  )

  session.ended = true
  expect(await retries.written(SESSION_ID, undefined)).toMatchObject({ ok: false })
  sessionFor.mockReturnValue(undefined)
  expect(await retries.written(SESSION_ID, undefined)).toMatchObject({ ok: false })

  retries.clear(SESSION_ID, null)
  session.ended = false
  sessionFor.mockReturnValue(session)
  translate.mockReturnValue({ accepted: true })
  expect(retries.handle(SESSION_ID, 'turn/started', {})).toEqual({ accepted: true })
  expect(await retries.written(SESSION_ID, async () => ({ ok: true }))).toEqual({ ok: true })
})

it('reports a fatal refusal reached by the write barrier and preserves underlying drain failures', async () => {
  const { session, forceCloseUnexpected } = retrySession()
  const retries = createCodexStructuredNotificationRetry({
    sessionFor: () => session,
    translate: () => ({ accepted: true })
  })
  const append = vi.fn<() => ChildWorkAdmission>(() => ({
    accepted: false,
    reason: 'backpressure'
  }))
  expect(retries.continueWork(SESSION_ID, append)).toEqual({ accepted: true })
  const drainFailure = { ok: false as const, error: new Error('journal write failed') }
  expect(await retries.written(SESSION_ID, async () => drainFailure)).toBe(drainFailure)
  expect(append).toHaveBeenCalledOnce()

  append.mockReturnValue({ accepted: false, reason: 'failed' })
  expect(await retries.written(SESSION_ID, async () => ({ ok: true }))).toMatchObject({
    ok: false,
    error: expect.any(Error)
  })
  expect(await retries.written(SESSION_ID, undefined)).toMatchObject({ ok: false })
  expect(forceCloseUnexpected).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['notification', 'continuation', 'barrier'] as const)(
  'allows a replacement connection to recover through a %s before stale exit cleanup',
  async (entry) => {
    const previous = retrySession()
    const replacement = retrySession()
    let session = previous.session
    const retries = createCodexStructuredNotificationRetry({
      sessionFor: () => session,
      translate: () => ({ accepted: true })
    })
    retries.continueWork(SESSION_ID, () => ({ accepted: false, reason: 'failed' }))
    session = replacement.session

    if (entry === 'notification') {
      expect(retries.handle(SESSION_ID, 'turn/started', {})).toEqual({ accepted: true })
    } else if (entry === 'continuation') {
      expect(retries.continueWork(SESSION_ID, () => ({ accepted: true }))).toEqual({
        accepted: true
      })
    }
    expect(await retries.written(SESSION_ID, undefined)).toEqual({ ok: true })

    const append = vi.fn<() => ChildWorkAdmission>(() => ({
      accepted: false,
      reason: 'backpressure'
    }))
    expect(retries.continueWork(SESSION_ID, append)).toEqual({ accepted: true })
    retries.clear(SESSION_ID, previous.connection)
    retries.retry(SESSION_ID, previous.connection)
    expect(append).toHaveBeenCalledOnce()
    append.mockReturnValue({ accepted: true })
    await vi.advanceTimersByTimeAsync(25)
    expect(append).toHaveBeenCalledTimes(2)
    expect(await retries.written(SESSION_ID, undefined)).toEqual({ ok: true })
    expect(replacement.forceCloseUnexpected).not.toHaveBeenCalled()
    expect(previous.forceCloseUnexpected).toHaveBeenCalledOnce()
    expect(replacement.connection.resumeReading).toHaveBeenCalledTimes(
      entry === 'continuation' ? 2 : 1
    )
  }
)
