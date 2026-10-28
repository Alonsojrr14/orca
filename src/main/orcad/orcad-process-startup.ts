import { resolveOrcadInstallRoot } from './orcad-app-paths'
import { installOrcadShutdownSignals, type OrcadShutdownTrigger } from './orcad-lifecycle'
import { installOrcadStopRequestListeners } from './orcad-stop-request-listener'
import { prepareOrcadManagedStop } from './orcad-managed-stop-admission'
import { bindOrcadIdleShutdown } from './orcad-managed-idle-exit-host'
import { installOrcadProcessErrorGuards } from './orcad-process-error-guards'
import type { OrcadHandle, OrcadOptions } from './orcad-start-contract'

/** Observe shutdown during startup, while teardown still waits for the host handle. */
export async function startOrcadProcess(
  options: OrcadOptions,
  start: (options: OrcadOptions, shutdownSignal: AbortSignal) => Promise<OrcadHandle>
): Promise<void> {
  let shutdownTrigger: OrcadShutdownTrigger | null = null
  // Fire-and-forget startup work can reject before its first await completes.
  installOrcadProcessErrorGuards(() => shutdownTrigger)
  const shutdown = new AbortController()
  const startup = start(options, shutdown.signal)
  const requestShutdown = installOrcadShutdownSignals(async () => {
    shutdown.abort()
    await (await startup).stop()
  })
  shutdownTrigger = requestShutdown
  const handle = await startup
  // Stop requests must name the runtime/instance established by startup.
  installOrcadStopRequestListeners(() => requestShutdown('stop request'), {
    installRoot: resolveOrcadInstallRoot(),
    managedStop: handle.managedStop,
    beforeManagedStop: prepareOrcadManagedStop
  })
  bindOrcadIdleShutdown(requestShutdown)
}
