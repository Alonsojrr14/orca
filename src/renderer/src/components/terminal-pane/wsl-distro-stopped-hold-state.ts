import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

type HeldPane = {
  distro: string
  /** Reconnects as the user's act, which may start the distro. */
  release: () => Promise<unknown>
}

/** Restored WSL bridge panes held because their distro was stopped and no user act asked for them. */
export const wslDistroStoppedHoldStore = createStore<{ panes: Record<string, HeldPane> }>(() => ({
  panes: {}
}))

/** Registers a held pane; the returned teardown forgets it if it unmounts while held. */
export function holdPaneForStoppedWslDistro(paneKey: string, pane: HeldPane): () => void {
  wslDistroStoppedHoldStore.setState(({ panes }) => ({ panes: { ...panes, [paneKey]: pane } }))
  return () => forgetHeldPane(paneKey, pane.release)
}

function forgetHeldPane(paneKey: string, release: HeldPane['release']): void {
  wslDistroStoppedHoldStore.setState(({ panes }) => {
    if (panes[paneKey]?.release !== release) {
      return {}
    }
    const { [paneKey]: _forgotten, ...rest } = panes
    return { panes: rest }
  })
}

/** Start: every pane held for this distro reconnects; the first spawn starts the distro. */
export function startHeldPanesForWslDistro(distro: string): void {
  const held = Object.entries(wslDistroStoppedHoldStore.getState().panes).filter(
    ([, pane]) => pane.distro.toLowerCase() === distro.toLowerCase()
  )
  for (const [paneKey, pane] of held) {
    forgetHeldPane(paneKey, pane.release)
    void pane.release()
  }
}

/** The stopped distro this pane is held for, or null. */
export function useWslDistroStoppedHold(paneKey: string): string | null {
  return useStore(wslDistroStoppedHoldStore, (state) => state.panes[paneKey]?.distro ?? null)
}
