// A background read refused so it would not boot a stopped WSL distro (E9). The text is the contract:
// it reaches the renderer through IPC and remote clients as a plain `runtime_error` message.

/** `retryStartsIt`: false where the surface's Retry is itself background and can't start it. */
export function wslDistroStoppedMessage(distro: string, retryStartsIt = true): string {
  return retryStartsIt
    ? `WSL distro '${distro}' is not running. Retry, or open a terminal in it, to start it.`
    : `WSL distro '${distro}' is not running. Open a terminal in it to start it.`
}

export function wslDistroUnverifiableMessage(distro: string): string {
  return `WSL didn't answer whether '${distro}' is running, so Orca left it alone. Retry in a moment.`
}

const NOT_RUNNING_REFUSAL =
  /WSL distro '[^']*' is not running\. (Retry|Open a terminal)|WSL didn't answer whether '[^']*' is running, so Orca left it alone/

/** A poller keeps its last data on this refusal instead of reporting a failure. */
export function isWslDistroNotRunningRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return NOT_RUNNING_REFUSAL.test(message)
}
