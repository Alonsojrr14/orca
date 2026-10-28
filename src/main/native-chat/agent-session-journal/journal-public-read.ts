import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import { renderJournalState, type JournalReducerState } from './journal-reducer'

/** Only a committed journal owner can certify reuse across public reads. */
export function createJournalPublicReader() {
  let current:
    | {
        raw: JournalReducerState
        epoch: string
        sequence: number
        revision: string
        normalizationKey?: string
        view?: ReturnType<typeof readJournalPublicView>
      }
    | undefined
  return (
    raw: JournalReducerState,
    display: JournalReducerState,
    revision: string,
    normalizationKey = () => journalNormalizationKey(display)
  ) => {
    const { epoch, lastSequence: sequence } = raw
    if (
      current?.raw !== raw ||
      current.epoch !== epoch ||
      current.sequence !== sequence ||
      current.revision !== revision
    ) {
      current = { raw, epoch, sequence, revision }
    }
    const source = current
    return (source.view ??= readJournalPublicView(
      display,
      () => (source.normalizationKey ??= normalizationKey())
    ))
  }
}

/** Row progress cannot certify a historical display that the queue fold corrected. */
export function readJournalPublicView(
  state: JournalReducerState,
  normalizationKey = () => journalNormalizationKey(state)
): {
  snapshot: AgentJournalSnapshot
  normalizationKey: string
} {
  let snapshot: AgentJournalSnapshot | undefined
  return {
    get snapshot() {
      return (snapshot ??= renderJournalState(state))
    },
    get normalizationKey() {
      return normalizationKey()
    }
  }
}

function journalNormalizationKey(state: JournalReducerState): string {
  return state.selection.normalizationKey(state.epoch)
}
