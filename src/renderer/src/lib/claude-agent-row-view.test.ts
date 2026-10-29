import { beforeEach, expect, it, vi } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { ClaudeAgentViewResult } from '../../../shared/claude-agent-view'
import { buildLegacyAgentChildRowModels } from '../../../shared/agent-child-row-model'
import { makePaneKey } from '../../../shared/stable-pane-id'

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  getState: vi.fn(),
  rpc: vi.fn(),
  terminal: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { info: mocks.info } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/runtime/runtime-client-target', () => ({
  runtimeTargetForOwnerEnvironment: () => ({ kind: 'local' })
}))
vi.mock('./worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => undefined
}))
vi.mock('./active-agent-note-target', () => ({ findActiveRuntimeTerminal: mocks.terminal }))

import { canViewClaudeAgentRow, viewClaudeAgentFromRow } from './claude-agent-row-view'

const paneKey = makePaneKey('parent-tab', '11111111-1111-4111-8111-111111111111')
const parent: DashboardAgentRow = {
  paneKey,
  entry: {
    paneKey,
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'parent-session' },
    state: 'working',
    prompt: '',
    updatedAt: 1000,
    stateStartedAt: 1000,
    stateHistory: []
  },
  tab: {
    id: 'parent-tab',
    worktreeId: 'repo::/project',
    ptyId: 'pty',
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1000
  },
  agentType: 'claude',
  state: 'working',
  startedAt: 1000
}

function childRow(meta: {
  agentType: string
  description: string
  model: string
}): DashboardAgentRow {
  const [child] = buildLegacyAgentChildRowModels(
    [{ ...meta, id: 'agent-1', state: 'working', startedAt: 1000 }],
    {
      parentEvidenceFresh: true,
      transportObservation: 'live',
      parentObservedAt: 1000,
      hostClockOffsetMs: 0
    }
  )
  return {
    ...parent,
    paneKey: `${paneKey}:subagent:agent-1`,
    activationPaneKey: paneKey,
    rowSource: 'subagent',
    childRow: child
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getState.mockReturnValue({ agentStatusByPaneKey: { [paneKey]: parent.entry } })
  mocks.terminal.mockResolvedValue({ handle: 'terminal-handle' })
  mocks.rpc.mockResolvedValue({ view: { status: 'viewed' } })
})

it('keeps workflow agents on parent-pane activation while ordinary agents still open their own view', async () => {
  const workflowMeta = {
    agentType: 'workflow-subagent',
    isBuiltIn: true,
    description: 'wf-idle-agent-1',
    workflowPhase: 'Idle',
    spawnDepth: 1,
    requestShape: 'foreground',
    requestNonInteractive: false,
    model: 'haiku'
  }
  const workflow = childRow(workflowMeta)
  expect(canViewClaudeAgentRow(workflow)).toBe(false)
  await viewClaudeAgentFromRow(workflow)
  expect(mocks.terminal).not.toHaveBeenCalled()
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.info).not.toHaveBeenCalled()

  const ordinary = childRow({ ...workflowMeta, agentType: 'general-purpose' })
  expect(canViewClaudeAgentRow(ordinary)).toBe(true)
  await viewClaudeAgentFromRow(ordinary)
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    { kind: 'local' },
    'terminal.viewClaudeAgent',
    expect.objectContaining({ sessionId: 'parent-session', agentId: 'agent-1' }),
    { timeoutMs: 8000 }
  )
  await viewClaudeAgentFromRow(parent)
  expect(mocks.rpc.mock.lastCall?.[2]).not.toHaveProperty('agentId')
})

it('replaces a provider denial with actionable Claude copy', async () => {
  const view: ClaudeAgentViewResult = { status: 'denied', reason: 'no agent under that id' }
  mocks.rpc.mockResolvedValue({ view })
  await viewClaudeAgentFromRow(
    childRow({ agentType: 'general-purpose', description: 'Review', model: 'haiku' })
  )
  expect(mocks.info).toHaveBeenCalledExactlyOnceWith(
    'Claude could not open this agent. Open the parent conversation to follow its progress.'
  )
})
