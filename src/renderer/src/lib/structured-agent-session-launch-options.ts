import { useSyncExternalStore } from 'react'
import { structuredSessionSelectionController } from './structured-agent-session-selection-controller'
import type {
  SelectionOperation,
  SelectionOutcome
} from '../../../shared/structured-agent-session-selection-operations'
import {
  structuredAgentSessionOptionPicks,
  type StructuredAgentSessionOptionState
} from '../../../shared/structured-agent-session-options'
import type {
  AgentSessionMutationResult,
  AgentSessionOptionResult
} from '../../../shared/agent-session-wire'
import {
  STRUCTURED_LAUNCH_OPTION_IDS,
  structuredLaunchCompatibleOptions,
  structuredLaunchRequestedOptions
} from '../../../shared/native-chat/input/native-chat-session-option-defaults'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../shared/structured-agent-session-mutation'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  StructuredAgentSessionLaunchCancelledError,
  type StructuredAgentLaunchReceipt
} from './agent-session/launch/structured-agent-session-launch-recovery'
import {
  getStructuredLaunchStateBySessionId,
  subscribeStructuredAgentLaunchStatus,
  type StructuredLaunchState
} from './agent-session/launch/structured-agent-session-launch-registry'
import {
  agentSessionRefusalFailure,
  agentSessionThrownFailure
} from '../../../shared/agent-session-write-failure'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { StructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'

/** The options a launch starts with, replaced whole so readers can compare by identity. */
export type StructuredLaunchSelection = {
  /** The immutable create seed, until a queried host answer replaces it. */
  seed?: Readonly<Record<string, string>>
  /** Immutable action input, separate from later picker operations. */
  explicit?: Readonly<Record<string, string>>
  /** A paired server has not yet said what create seeds, so nothing can be picked against it. */
  seedPending?: true
}

export function initialStructuredLaunchSelection(
  intent: StructuredAgentSessionLaunchIntent
): StructuredLaunchSelection {
  return {
    seed: intent.seedOptions,
    ...(intent.explicitLaunchOptions ? { explicit: intent.explicitLaunchOptions } : {}),
    ...(intent.target.kind !== 'local' && !intent.seedOptions ? { seedPending: true } : {})
  }
}

export type StructuredLaunchOptionOutcome = SelectionOutcome

const launchControllers = new WeakMap<
  StructuredLaunchState,
  ReturnType<typeof structuredSessionSelectionController>
>()
const selectionController = (state: StructuredLaunchState) => {
  let controller = launchControllers.get(state)
  if (!controller) {
    controller = structuredSessionSelectionController(
      state.intent.target,
      state.intent.sessionId,
      state.intent.agent
    )
    launchControllers.set(state, controller)
  }
  return controller
}
const receipts = new WeakMap<StructuredLaunchState, StructuredAgentLaunchReceipt>()
/** Create and the attached view read the same finite operation overlay. */
export function structuredLaunchOptionOverlay(
  state: StructuredLaunchState
): Record<string, string> {
  return selectionController(state).overlay()
}

/** Hold picks only before publication; published/missing launches use the normal session option path. */
export function holdStructuredAgentSessionLaunchOption(
  sessionId: string,
  id: string,
  encoded: string,
  /** The picker's list, under which a model pick keeps only the held values the model offers. */
  picker?: StructuredAgentSessionOptionState
): Promise<StructuredLaunchOptionOutcome> | null {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (!state || state.cancelled || state.callers.outcome === 'published') {
    return null
  }
  if (state.selection.seedPending) {
    return null
  }
  const model = picker
    ? (structuredAgentSessionOptionPicks(picker, { [id]: encoded })[0]?.modelId ?? null)
    : (state.selection.seed?.model ?? null)
  const operation = selectionController(state).issue(id, encoded, model)
  const receipt = receipts.get(state)
  if (receipt) {
    void applyStructuredLaunchHeldOptions(state, receipt, false)
  }
  return operation.result
}

export async function setStructuredSessionSelectionOption(
  target: RuntimeClientTarget,
  sessionId: string,
  fence: number,
  key: string,
  value: string
): Promise<StructuredLaunchOptionOutcome> {
  const fields = { key, value }
  try {
    const result = await callStructuredAgentSession<
      AgentSessionMutationResult<AgentSessionOptionResult>
    >(target, 'agentSession.setOption', {
      envelope: {
        sessionId,
        clientOperationId: createStructuredAgentSessionOperationId(createBrowserUuid),
        expectedRuntimeFence: fence,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.setOption',
          sessionId,
          fields
        })
      },
      ...fields
    })
    return result.ok
      ? { kind: 'accepted', options: result.value.options ?? { [key]: value } }
      : { kind: 'refused', failure: agentSessionRefusalFailure(result.refusal) }
  } catch (error) {
    const failure = agentSessionThrownFailure(
      error,
      error instanceof RuntimeRpcCallError ? error.code : undefined
    )
    return failure.kind === 'unconfirmed'
      ? { kind: 'unknown', failure }
      : { kind: 'refused', failure }
  }
}

/** Older hosts apply action inputs before the held picker operations and opening prompt. */
export async function applyStructuredLaunchExplicitOptions(
  state: StructuredLaunchState,
  receipt: StructuredAgentLaunchReceipt
): Promise<StructuredAgentLaunchReceipt> {
  const controller = selectionController(state)
  const held = controller.overlay()
  const requested = structuredLaunchRequestedOptions({ explicit: state.selection.explicit, held })
  if (requested) {
    const compatible = structuredLaunchCompatibleOptions(state.intent.agent, requested)
    for (const id of STRUCTURED_LAUNCH_OPTION_IDS) {
      const value = compatible[id]
      if (value === undefined || held[id] !== undefined || id === 'fastMode') {
        continue
      }
      if (state.cancelled) {
        throw new StructuredAgentSessionLaunchCancelledError()
      }
      const outcome = await setStructuredSessionSelectionOption(
        state.intent.target,
        receipt.sessionId,
        receipt.fence,
        id,
        value
      )
      if (
        (outcome.kind === 'refused' || outcome.kind === 'unknown') &&
        outcome.failure &&
        requested[id] !== undefined
      ) {
        for (const operation of controller.pending()) {
          controller.settle(operation, outcome)
        }
        return { ...receipt, configurationFailure: outcome.failure }
      }
    }
  }
  return applyStructuredLaunchHeldOptions(state, receipt)
}

const createHeld = new WeakMap<StructuredLaunchState, readonly SelectionOperation[]>()

/** Freeze identities, so a later equal-valued choice is a distinct operation. */
export function holdStructuredLaunchCreatePicks(state: StructuredLaunchState): void {
  createHeld.set(state, selectionController(state).freeze(createHeld.get(state)))
}

export function settleStructuredLaunchCreateOptions(
  state: StructuredLaunchState,
  options: Readonly<Record<string, string>>
): void {
  for (const operation of createHeld.get(state) ?? []) {
    selectionController(state).settle(operation, { kind: 'accepted', options })
  }
  createHeld.delete(state)
}

/** Enqueue the current batch before attachment; later picks use this same ordered sender. */
export async function applyStructuredLaunchHeldOptions(
  state: StructuredLaunchState,
  receipt: StructuredAgentLaunchReceipt,
  waitForDrain = true
): Promise<StructuredAgentLaunchReceipt> {
  receipts.set(state, receipt)
  const controller = selectionController(state)
  controller.flush(async (operation) => {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    return setStructuredSessionSelectionOption(
      state.intent.target,
      state.intent.sessionId,
      receipt.fence,
      operation.key,
      operation.value
    )
  })
  if (waitForDrain) {
    await controller.drain()
  }
  return receipt
}

export function getStructuredAgentSessionLaunchSelection(
  sessionId: string
): StructuredLaunchSelection | null {
  return getStructuredLaunchStateBySessionId(sessionId)?.selection ?? null
}

/** The launch's selection while it is in the registry; null before and after. */
export function useStructuredAgentSessionLaunchSelection(
  sessionId: string
): StructuredLaunchSelection | null {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentSessionLaunchSelection(sessionId),
    () => null
  )
}
