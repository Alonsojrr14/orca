import type { StructuredAgentSessionHost } from './structured-agent-session-host'

/** Recovery assertions explicitly open chats; startup no longer does that work. */
export async function openTestChats(
  host: StructuredAgentSessionHost,
  ids?: readonly string[]
): Promise<void> {
  await host.reconcileRestartLeases()
  for (const id of ids ?? host.deps.store.listConversations().map((record) => record.sessionId)) {
    const runtime = host.collaboratorsForTests().runtimeState
    await host.deps.store.reconcileOnRestart({
      sessionId: id,
      probe: (record) => runtime.probeRecord(record),
      now: host.deps.now?.() ?? Date.now()
    })
    await runtime.resolveRecovery(id).catch(() => {})
    await host.revealSession(id)
  }
}
