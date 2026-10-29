/** A passive restore of a WSL bridge pane whose distro is stopped: held, never started (E9). */
export const WSL_DISTRO_STOPPED_HOLD_ERROR = 'terminal_held_wsl_distro_stopped'

export function wslDistroStoppedHoldMessage(distro: string): string {
  return `${WSL_DISTRO_STOPPED_HOLD_ERROR}:${distro}`
}

/** The stopped distro a hold names, or null when the message is not one. */
export function parseWslDistroStoppedHold(message: string): string | null {
  const start = message.indexOf(`${WSL_DISTRO_STOPPED_HOLD_ERROR}:`)
  if (start === -1) {
    return null
  }
  const distro = message.slice(start + WSL_DISTRO_STOPPED_HOLD_ERROR.length + 1).split(/\s/)[0]
  return distro || null
}
