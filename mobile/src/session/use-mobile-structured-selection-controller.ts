import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { createStructuredSessionSelectionController } from '../../../src/shared/structured-agent-session-selection-operations'
import { persistMobileStructuredOptionPicks } from './native-chat/input/mobile-native-chat-session-option-persistence'
import type { RpcClient } from '../transport/rpc-client'

/** Temporary operations belong to one phone authority, above its queried host answer. */
export function useMobileStructuredSelectionController(args: {
  agent: string | null
  client: RpcClient | null
  sessionId: string | null
  onRevalidate: () => void
}) {
  const { agent, client, sessionId, onRevalidate } = args
  const clientGeneration = client?.getGeneration?.()
  const controller = useMemo(
    () =>
      createStructuredSessionSelectionController((picks) => {
        if (agent) {
          void persistMobileStructuredOptionPicks({ client, agent, picks })
        }
      }),
    [agent, client, clientGeneration, sessionId]
  )
  useEffect(() => () => controller.abandon(), [controller])
  const selectionRevision = useSyncExternalStore(controller.subscribe, controller.snapshot)
  const terminal = controller.terminalSnapshot()
  useEffect(() => {
    if (terminal) {
      onRevalidate()
    }
  }, [terminal, onRevalidate])
  useEffect(() => {
    let generation = client?.getGeneration?.()
    return client?.onStateChange((state) => {
      if (generation !== client.getGeneration?.()) {
        generation = client.getGeneration?.()
        controller.abandon()
      }
      if (state === 'connected') {
        onRevalidate()
      }
    })
  }, [client, controller, onRevalidate])
  return { controller, selectionRevision, clientGeneration }
}
