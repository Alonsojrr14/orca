// Order by creation sequence then write index, never time: crash recovery can append an earlier provider clock at a later sequence.

import type { AgentJournalRenderItem } from './agent-session-journal-types'
import type { NativeChatMessage } from './native-chat-types'

/** Where the journal placed an item: the sequence of the row that created it,
 *  then its place among that row's writes. The timeline's only ordering key. */
export type AgentJournalPosition = {
  sequence: number
  index: number
}

type PositionedItem = Pick<AgentJournalRenderItem, 'sequence' | 'sequenceIndex'>

/** Keep row identity/order when projection changes shape, such as an answered question. */
export function agentJournalItemRowOrigin(
  item: AgentJournalRenderItem
): Pick<NativeChatMessage, 'id' | 'timestamp' | 'source' | 'journalPosition'> {
  return {
    id: item.itemId,
    timestamp: item.observedAt,
    source: 'transcript',
    journalPosition: agentJournalItemPosition(item)
  }
}

export function agentJournalItemPosition(item: PositionedItem): AgentJournalPosition {
  return { sequence: item.sequence, index: item.sequenceIndex ?? 0 }
}

export function compareAgentJournalPositions(
  a: AgentJournalPosition,
  b: AgentJournalPosition
): number {
  return a.sequence - b.sequence || a.index - b.index
}

export function compareAgentJournalItems(a: PositionedItem, b: PositionedItem): number {
  return a.sequence - b.sequence || (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0)
}
