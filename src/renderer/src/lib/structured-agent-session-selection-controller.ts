import {
  onRuntimeEnvironmentsRetired,
  onRuntimeEnvironmentRevisionsChanged,
  getRuntimeEnvironmentRevision
} from '@/runtime/runtime-environment-revision'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { createStructuredSessionSelectionController } from '../../../shared/structured-agent-session-selection-operations'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { AgentType } from '../../../shared/agent-status-types'
import { enqueueSessionOptionSettingsWrite } from '@/components/native-chat/native-chat-session-option-settings-write'

export function structuredSessionSelectionAuthority(target: RuntimeClientTarget): string {
  return target.kind === 'local'
    ? 'local'
    : JSON.stringify([
        getRuntimeEnvironmentRevision(target.environmentId),
        getRuntimeEnvironmentConnectionGeneration(target.environmentId)
      ])
}
const controllers = new Map<
  string,
  {
    sessionId: string
    host: string
    authority: string
    controller: ReturnType<typeof createStructuredSessionSelectionController>
  }
>()

/** Launch and attached views share the same sender on the execution host's logical chat. */
export function structuredSessionSelectionController(
  target: RuntimeClientTarget,
  sessionId: string,
  agent: AgentType
) {
  const host = target.kind === 'local' ? 'local' : target.environmentId
  const authority = structuredSessionSelectionAuthority(target)
  const key = JSON.stringify([host, sessionId, agent])
  const existing = controllers.get(key)
  if (existing?.authority === authority) {
    return existing.controller
  }
  existing?.controller.abandon()
  const controller = createStructuredSessionSelectionController((picks) => {
    void enqueueSessionOptionSettingsWrite(target, { type: 'apply-picks', agent, picks })
  })
  controllers.set(key, { sessionId, host, authority, controller })
  return controller
}

/** Closing/purging a chat explicitly ends its transient operations, including ambiguous writes. */
export function forgetStructuredSessionSelection(
  sessionId: string,
  target?: RuntimeClientTarget
): void {
  const host = target?.kind === 'local' ? 'local' : target?.environmentId
  for (const [key, entry] of controllers) {
    if (entry.sessionId === sessionId && (host === undefined || entry.host === host)) {
      entry.controller.abandon()
      controllers.delete(key)
    }
  }
}

const retireHosts = (ids: readonly string[]) => {
  for (const [key, entry] of controllers) {
    if (ids.includes(entry.host)) {
      entry.controller.abandon()
      controllers.delete(key)
    }
  }
}
onRuntimeEnvironmentsRetired(retireHosts)
onRuntimeEnvironmentRevisionsChanged(retireHosts)
