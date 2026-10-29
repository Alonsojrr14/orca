import { Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { themedStyleSheet } from '../theme/themed-styles'
import {
  mobileDictationStatusTitle,
  type MobileDictationStatusFlags
} from './MobileDictationStatusAnnouncement'

type MobileTerminalLiveInputStatusProps = {
  readonly dictation: MobileDictationStatusFlags
  readonly dictationMode: string | undefined
  readonly isAttaching: boolean
}

/** Shows transient recording/upload status over the field without intercepting its touches. */
export function MobileTerminalLiveInputStatus({
  dictation,
  dictationMode,
  isAttaching
}: MobileTerminalLiveInputStatusProps) {
  useMobileColorScheme()
  const dictationTitle = mobileDictationStatusTitle(dictation)
  if (!dictationTitle && !isAttaching) {
    return null
  }
  const title = dictationTitle ?? 'Uploading image'
  const detail = dictation.isRecording
    ? dictationMode === 'hold'
      ? 'Release mic to stop'
      : 'Tap mic to stop'
    : dictation.isProcessing
      ? 'Transcribing on desktop'
      : dictation.isStarting
        ? 'Preparing microphone'
        : 'Uploading image to host'

  return (
    <View style={styles.status} pointerEvents="none">
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.detail} numberOfLines={1} ellipsizeMode="head">
        {detail}
      </Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  // Cover the field in place so the dock, and with it the PTY, keeps its height.
  status: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.input,
    backgroundColor: colors.bgRaised
  },
  title: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  detail: {
    flexShrink: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily
  }
}))
