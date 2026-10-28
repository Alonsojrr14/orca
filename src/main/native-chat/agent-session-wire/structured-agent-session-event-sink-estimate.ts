import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'

export function estimateStructuredAgentSessionItemBytes(
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody
): number {
  return Buffer.byteLength(JSON.stringify({ identity, body }), 'utf8') + 512
}

/** JSON array delimiters and separators, plus the journal cost of every mutation. */
export function estimateStructuredAgentSessionSettlementBytes(
  mutations: readonly unknown[]
): number {
  return Buffer.byteLength(JSON.stringify(mutations), 'utf8') + mutations.length * 512
}

export function estimateStructuredAgentSessionMutationBytes(mutation: unknown): number {
  return Buffer.byteLength(JSON.stringify(mutation), 'utf8') + 513
}

export function estimateStructuredAgentSessionLifecycleBatchBytes(
  settlementId: string,
  mutations: readonly unknown[]
): number {
  return (
    estimateStructuredAgentSessionSettlementBytes(mutations) +
    Buffer.byteLength(settlementId, 'utf8') +
    512
  )
}
