import type { StructuredAgentSessionHost } from './structured-agent-session-host'

/** Exercise startup and opening through the public production paths. */
export async function openTestChats(
  host: StructuredAgentSessionHost,
  ids?: readonly string[]
): Promise<void> {
  await host.reconcileRestartLeases()
  await host.seedSessionTabs(ids)
  for (const { sessionId } of host.listSessionTabs()) {
    await host.revealSession(sessionId)
  }
}
