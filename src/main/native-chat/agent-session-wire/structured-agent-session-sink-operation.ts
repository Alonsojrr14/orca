import type { StructuredAgentSessionEventTarget } from './structured-agent-session-event-sink'

export type StructuredAgentSessionSinkOperation = {
  sequence: number
  bytes: number
  lifecycleBytes?: number
  lifecycle?: boolean
  finalTail?: true
  /** Only publications coalesce by key; replacing journal writes would reorder them behind later work. */
  publicationKey?: string
  /** Handover synchronously joins the journal queue in submission order. */
  run: (
    target: StructuredAgentSessionEventTarget,
    reserveBytes: (bytes: number) => void
  ) => Promise<unknown> | void
}

export function runStructuredAgentSessionSinkOperation(
  run: () => Promise<unknown> | void
): Promise<unknown> {
  try {
    return Promise.resolve(run())
  } catch (error) {
    return Promise.reject(error)
  }
}
