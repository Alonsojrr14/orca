// Retire superseded chat history on the host's journal connection, on the attachment sweeps' schedule.

import {
  startJournalMaintenance,
  type JournalMaintenance,
  type JournalMaintenanceDatabase
} from '../native-chat/agent-session-journal/journal-maintenance'
import { retireSupersededJournalRevisions } from '../native-chat/agent-session-journal/journal-revision-retirement'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

// The first pass waits out startup; a restart never brings the next pass forward.
const MIN_PASS_DELAY_MS = 60 * 1000
const PASS_INTERVAL_MS = 6 * 60 * 60 * 1000

let maintenance: JournalMaintenance | null = null

export function installJournalMaintenance(deps: {
  journalDatabase: JournalMaintenanceDatabase
  logger: StructuredAgentSessionLogger
}): void {
  stopJournalMaintenance()
  maintenance = startJournalMaintenance(
    () => deps.journalDatabase,
    retireSupersededJournalRevisions,
    {
      minDelayMs: MIN_PASS_DELAY_MS,
      intervalMs: PASS_INTERVAL_MS,
      onError: (error) =>
        deps.logger.warn('chat history cleanup failed', { scope: 'journal-maintenance', error })
    }
  )
}

export function stopJournalMaintenance(): void {
  maintenance?.stop()
  maintenance = null
}
