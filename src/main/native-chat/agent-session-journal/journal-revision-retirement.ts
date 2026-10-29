// A superseded revision keeps every field replay reads and loses only content its later revision replaces.
// User messages are left whole: replay matches provider echoes to sends by their text.

import type Database from '../../sqlite/sync-database'
import type { JournalSessionRetirement } from './journal-maintenance'
import { parseJournalRow } from './journal-row-schema'

const SELECT_ROW =
  'SELECT row_json FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?'
// The stored text must still be what was read; a concurrent rewrite wins.
const UPDATE_ROW = `UPDATE journal_rows SET row_json = ?
WHERE session_id = ? AND epoch = ? AND seq = ? AND row_json = ?`

export const retireSupersededJournalRevisions: JournalSessionRetirement = (
  db: Database.Database,
  { sessionId, epoch },
  superseded
) => {
  let retired = 0
  for (const { seq } of superseded) {
    const stored = db.prepare(SELECT_ROW).get(sessionId, epoch, seq) as
      | { row_json: string }
      | undefined
    // Damaged or newer rows stay byte-for-byte; blanking must never hide what replay would refuse.
    const original = stored ? parseJournalRow(stored.row_json) : null
    const blanked = stored && original?.ok ? blankSupersededContent(stored.row_json) : null
    if (!stored || blanked === null) {
      continue
    }
    // An UPDATE bypasses the insert-time read-back check; never store a row the next load rejects.
    const readBack = parseJournalRow(blanked)
    if (!readBack.ok || readBack.row.seq !== seq) {
      continue
    }
    retired += Number(
      db.prepare(UPDATE_ROW).run(blanked, sessionId, epoch, seq, stored.row_json).changes
    )
  }
  return retired
}

/** Edit the stored JSON, not a parsed row: re-serializing an upcast row would change its version. */
function blankSupersededContent(rowJson: string): string | null {
  let row: unknown
  try {
    row = JSON.parse(rowJson)
  } catch {
    return null
  }
  if (!isRecord(row) || row.kind !== 'item' || !isRecord(row.body)) {
    return null
  }
  const { body } = row
  let changed = false
  if (body.kind === 'message' && body.role !== 'user' && Array.isArray(body.blocks)) {
    for (const block of body.blocks) {
      if (isRecord(block)) {
        changed = blankBlock(block) || changed
      }
    }
  } else if (body.kind === 'tool-call') {
    changed = removeInput(body) || changed
    if (isRecord(body.output) && typeof body.output.head === 'string' && body.output.head !== '') {
      body.output.head = ''
      changed = true
    }
  }
  return changed ? JSON.stringify(row) : null
}

function blankBlock(block: Record<string, unknown>): boolean {
  if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
    block.text = ''
    return true
  }
  if (block.type === 'tool-result' && typeof block.output === 'string' && block.output !== '') {
    block.output = ''
    return true
  }
  return block.type === 'tool-call' && removeInput(block)
}

// `input` is optional on tool calls; persisted rows already omit it when undefined.
function removeInput(record: Record<string, unknown>): boolean {
  if (!Object.hasOwn(record, 'input')) {
    return false
  }
  delete record.input
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
