import { translate } from '@/i18n/i18n'
import { RemoteRuntimeRecoveryCard } from './RemoteRuntimeRecoveryCard'

/** A pane whose WSL distro is stopped: nothing restarts it on its own (E9); Start is the user's act. */
export function WslDistroStoppedCard({
  distro,
  onStart,
  data
}: {
  distro: string
  onStart: () => void
  data: Record<`data-${string}`, string>
}): React.JSX.Element {
  return (
    <RemoteRuntimeRecoveryCard
      icon="stopped"
      data={data}
      title={translate('components.native-chat.hostOutage.stopped', '{{distro}} is stopped', {
        distro
      })}
      action={{
        label: translate('components.native-chat.hostOutage.start', 'Start'),
        onClick: onStart
      }}
    />
  )
}
