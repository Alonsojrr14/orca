/**
 * True for the E9 gate's "distro not running / unverifiable" refusal. Over IPC only the message
 * survives, so this matches WslDistroStoppedError and WslDistroUnverifiableError by text.
 */
export function isWslDistroRefusalError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /WSL distro '.+' is not running\.|WSL didn't answer whether '.+' is running/.test(message)
}
