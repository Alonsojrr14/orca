import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import type { ChildWorkAdmission } from '../native-chat/agent-session-wire/structured-agent-session-accepted-child-work'
import { ClaudePromptRegistry } from './claude-prompt-registry'
import { createClaudeInitProof } from './claude-structured-init-proof'
import { createClaudeSessionPublication } from './claude-structured-session-publication'
import { bindClaudeJournalReadingControl } from './claude-structured-session-journal-control'
import { publishClaudeChildWork } from './claude-structured-child-work-delivery'
import { emitClaudeStructuredSessionEvent } from './claude-structured-event-delivery'
import type { ClaudeStructuredSessionAdapterDeps } from './claude-structured-session-state'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'

const journals = createTrackedJournalOpener()
const roots: string[] = []
afterEach(async () => {
  await journals.closeAll()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each([false, true])(
  'retries options reports in order without new provider traffic (child work first=%s)',
  async (childWorkFirst) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-claude-notification-'))
    roots.push(root)
    const journal = await journals.open({ stateDirectory: root, identity: identityFor() })
    const deferred = createDeferredStructuredAgentSessionEventSink({
      ...testEventSinkLogging(),
      watermarks: { maxQueuedOperations: 1, pauseQueuedOperations: 1, lowQueuedOperations: 0 }
    })
    const { sink } = deferred
    const connection = await fakeClaude().openConnection({
      pathToClaudeCodeExecutable: 'claude',
      cwd: root,
      options: {}
    })
    const resumeReading = vi.spyOn(connection, 'resumeReading')
    const { session } = createClaudeSessionPublication({
      connection,
      providerSessionId: PROVIDER_SESSION_ID,
      leafUuid: null,
      turnEndLeafUuid: null,
      fence: 1,
      acquisitionGeneration: 'acquisition',
      continuesChain: false,
      prompts: new ClaudePromptRegistry(),
      translator: null,
      events: sink,
      process: { hostId: 'local', pid: 4321, processStartTimeMs: 1, spawnToken: 'spawn' },
      observedAt: 1,
      initialization: {
        proof: createClaudeInitProof(),
        account: undefined,
        resumesTranscript: false,
        claudeConfigDir: root,
        cwd: root,
        history: { leafUuid: null, covered: false, contextActivity: 0 },
        onLateRefusal: () => {}
      }
    })
    const delivered: string[] = []
    const deps: ClaudeStructuredSessionAdapterDeps = {
      resolveLaunch: async () => {
        throw new Error('unused launch')
      },
      onEvent: (event) => {
        if (event.type === 'options-reported' && event.reportedOptions.model) {
          delivered.push(event.reportedOptions.model)
        }
      },
      onChildWorkEvidence: (_id, _evidence, producer) => {
        const append = (): ChildWorkAdmission => {
          const result: ChildWorkAdmission = producer?.tryAppendTransition?.({
            steps: [],
            lifecycle: false,
            publish: true,
            onPublished: () => delivered.push('child')
          }) ?? { accepted: false, reason: 'closed' }
          return result.accepted ? result : { ...result, retry: append }
        }
        return producer?.continueWork?.(append) ?? append()
      }
    }
    const unbind = bindClaudeJournalReadingControl(
      sink,
      connection,
      null,
      () => session.retryChildWork?.() ?? { accepted: true }
    )
    try {
      expect(sink.tryAppendTransition?.({ steps: [], lifecycle: false, publish: false })).toEqual({
        accepted: true
      })
      if (childWorkFirst) {
        session.childWork.observe({
          type: 'system',
          subtype: 'task_started',
          task_id: 'child',
          tool_use_id: 'spawn-child',
          task_type: 'local_agent',
          description: 'Audit'
        })
      }
      for (const model of ['first-model', 'second-model']) {
        emitClaudeStructuredSessionEvent({
          session,
          event: {
            type: 'options-reported',
            sessionId: 'session-1',
            fence: 1,
            acquisitionGeneration: 'acquisition',
            reportedOptions: { model }
          },
          deps,
          publishChildWork: (id, child, message) => publishClaudeChildWork(deps, id, child, message)
        })
      }
      const retry = session.retryChildWork
      expect(retry).toBeTypeOf('function')
      expect(delivered).toEqual([])
      deferred.bind({ journal, fence: 1, publish: () => {} })
      for (let drain = 0; drain < 10 && deferred.state().queuedOperations > 0; drain++) {
        await expect(deferred.drained()).resolves.toEqual({ ok: true })
      }
      expect(delivered).toEqual([
        ...(childWorkFirst ? ['child'] : []),
        'first-model',
        'second-model'
      ])
      expect(session.retryChildWork).toBeUndefined()
      expect(resumeReading).toHaveBeenCalledOnce()
      // A captured retry can outlive admission while later notifications are still queued.
      expect(retry?.()).toEqual({ accepted: true })
      expect(deferred.state().queuedOperations).toBe(0)
      await deferred.drained()
      expect(delivered).toEqual([
        ...(childWorkFirst ? ['child'] : []),
        'first-model',
        'second-model'
      ])
      expect(deferred.state().queuedOperations).toBe(0)
    } finally {
      unbind?.()
      deferred.close()
      await connection.close()
    }
  }
)
