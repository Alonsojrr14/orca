import { makePaneKey } from '../../../../shared/stable-pane-id'
import { WslDistroStoppedCard } from './WslDistroStoppedCard'
import {
  startHeldPanesForWslDistro,
  useWslDistroStoppedHold
} from './wsl-distro-stopped-hold-state'

/** On a restored WSL bridge pane held because its distro is stopped: Start reconnects every such pane. */
export function WslDistroStoppedHoldCard({
  tabId,
  leafId
}: {
  tabId: string
  leafId: string
}): React.JSX.Element | null {
  const distro = useWslDistroStoppedHold(makePaneKey(tabId, leafId))
  if (!distro) {
    return null
  }
  return (
    <WslDistroStoppedCard
      distro={distro}
      data={{ 'data-terminal-wsl-distro-stopped-hold': distro }}
      onStart={() => startHeldPanesForWslDistro(distro)}
    />
  )
}
