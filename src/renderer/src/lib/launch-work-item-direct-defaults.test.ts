import { afterEach, describe, expect, it, vi } from 'vitest'
import { mocks, hostMocks } from './launch-work-item-direct-test-fixture'
import { resolveProjectExecutionRuntime } from '../../../shared/project-execution-runtime'
import * as inventory from './agent-detection-target-inventory'
import * as localCapabilities from '@/runtime/local-runtime-capabilities'
import { resetHostStructuredAgentsForTests } from '@/runtime/host-structured-agents'
import {
  clearHostAgentMenuSettingsForTests,
  ensureAgentLaunchPreferences
} from '@/components/settings/use-host-agent-launch-preferences'
import { projectAgentLaunchSettings } from '../../../shared/agent-launch-settings'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { useAppStore } from '@/store'
import * as worktreeRows from '@/store/slices/worktree-helpers'
import * as routeInputs from './agent-launch-route-input'
import * as chatPrograms from './host-chat-program'
import { resolveDirectProspectiveAgent } from './launch-work-item-direct-preflight'
import * as availability from '@/runtime/host-structured-agent-availability'
import { RUNTIME_CAPABILITIES } from '../../../shared/protocol-version'
import { launchWorkItemDirect } from './launch-work-item-direct'
import { beginDirectWorkItemStructuredLaunch } from './launch-work-item-direct-agent-routing'

const item = {
  type: 'issue',
  number: 42,
  title: 'Use the preferred chat',
  url: 'https://github.com/acme/repo/issues/42'
} as const
const launch = (extra: Partial<Parameters<typeof launchWorkItemDirect>[0]> = {}) =>
  launchWorkItemDirect({
    repoId: 'repo-1',
    launchSource: 'task_page',
    openModalFallback: mocks.openModalFallback,
    item,
    ...extra
  })

function stageChat() {
  localCapabilities.setLocalRuntimeCapabilitiesForTests(RUNTIME_CAPABILITIES)
  hostMocks.callRuntimeRpc.mockResolvedValue({
    agents: ['codex', 'claude'].map((agent) => ({ agent, capabilities: {} }))
  })
  vi.mocked(beginDirectWorkItemStructuredLaunch).mockImplementation(({ plan, beforeOpen }) =>
    plan?.route === 'structured-native-chat'
      ? { completed: beforeOpen() !== false, structuredLaunch: true, primaryTabId: 'chat-tab' }
      : { completed: false, structuredLaunch: false, primaryTabId: null }
  )
}
afterEach(() => {
  resetHostStructuredAgentsForTests()
  clearHostAgentMenuSettingsForTests()
  localCapabilities.setLocalRuntimeCapabilitiesForTests(null)
})

describe('direct workspace defaults', () => {
  it.each(['codex', 'claude'] as const)(
    'keeps a usable preferred Codex chat over detected Claude, then honors the current default (%s)',
    async (currentDefault) => {
      vi.spyOn(inventory, 'loadProjectLaunchContext').mockResolvedValue({
        agents: ['claude'],
        workspaceKind: 'git-worktree',
        executionContext: {
          kind: 'host',
          projectRuntime: resolveProjectExecutionRuntime({ appPlatform: 'darwin', projectId: 'p1' })
        }
      })
      stageChat()
      vi.spyOn(availability, 'readHostStructuredAgentAvailability').mockReturnValue({
        state: 'received',
        byAgent: new Map([
          ['codex', { agent: 'codex', state: 'available', chatProgram: 'available' }]
        ])
      })
      hostMocks.callRuntimeRpc.mockResolvedValue({ agents: [{ agent: 'codex', capabilities: {} }] })
      vi.spyOn(availability, 'acquireHostStructuredAgentAvailability').mockReturnValue(() => {})
      vi.spyOn(availability, 'firstHostStructuredAgentAvailability').mockResolvedValue()
      mocks.ensureDetectedAgents.mockResolvedValue(['claude'])
      mocks.store.settings = { defaultTuiAgent: 'codex', experimentalNativeChat: true }
      mocks.createWorktree.mockImplementationOnce(async () => {
        mocks.store.settings = { defaultTuiAgent: currentDefault, experimentalNativeChat: true }
        return { worktree: { id: 'repo-1::/repo/worktree', path: '/repo/worktree' } }
      })
      vi.mocked(beginDirectWorkItemStructuredLaunch).mockImplementationOnce(({ beforeOpen }) => ({
        completed: beforeOpen() !== false,
        structuredLaunch: true,
        primaryTabId: 'chat-tab'
      }))

      const plannedAgents: string[] = []
      await expect(
        launchWorkItemDirect({
          repoId: 'repo-1',
          launchSource: 'task_page',
          openModalFallback: vi.fn(),
          resolveSessionOptions: (agent) => {
            plannedAgents.push(agent)
            return undefined
          },
          item: {
            type: 'issue',
            number: 42,
            title: 'Use the preferred chat',
            url: 'https://github.com/acme/repo/issues/42'
          }
        })
      ).resolves.toBe(true)

      expect(plannedAgents).toEqual(['codex', currentDefault])
      expect(mocks.updateWorktreeMeta).toHaveBeenCalledWith('repo-1::/repo/worktree', {
        createdWithAgent: currentDefault
      })
      expect(beginDirectWorkItemStructuredLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          plan: expect.objectContaining({ agent: currentDefault, route: 'structured-native-chat' })
        })
      )
    }
  )

  it('uses prospective native facts to ignore hidden args before create', async () => {
    vi.spyOn(inventory, 'loadProjectLaunchContext').mockResolvedValue({
      agents: ['codex'],
      workspaceKind: 'git-worktree',
      executionContext: {
        kind: 'host',
        projectRuntime: resolveProjectExecutionRuntime({
          appPlatform: 'darwin',
          projectId: 'p1'
        })
      }
    })
    vi.spyOn(localCapabilities, 'readLocalRuntimeCapabilitiesOrUnknown').mockReturnValue(
      RUNTIME_CAPABILITIES
    )
    mocks.store.settings = { experimentalNativeChat: true, disabledTuiAgents: ['codex'] }
    vi.mocked(beginDirectWorkItemStructuredLaunch).mockImplementationOnce(({ beforeOpen }) => ({
      completed: beforeOpen() !== false,
      structuredLaunch: true,
      primaryTabId: 'chat-tab'
    }))
    await launchWorkItemDirect({
      repoId: 'repo-1',
      launchSource: 'task_page',
      openModalFallback: vi.fn(),
      agentLaunchPreferences: { defaultTuiAgent: 'codex', disabledTuiAgents: undefined },
      agentArgs: '--model "unterminated',
      resolveSessionOptions: () => ({ model: 'chosen' }),
      item: {
        type: 'issue',
        number: 42,
        title: 'Fix',
        url: 'https://github.com/acme/repo/issues/42'
      }
    })
    expect(mocks.createWorktree).toHaveBeenCalledOnce()
    expect(
      vi.mocked(beginDirectWorkItemStructuredLaunch).mock.calls.at(-1)?.[0].plan?.launchOptions
    ).toEqual({ model: 'chosen' })
  })
  it.each([undefined, 'codex'] as const)(
    'uses actual WSL inventory after native project preflight (override %s)',
    async (agentOverride) => {
      localCapabilities.setLocalRuntimeCapabilitiesForTests([])
      const path = String.raw`\\wsl.localhost\Ubuntu\workspaces\task`
      const worktree = makeWorktree({ id: `repo-1::${path}`, path, repoId: 'repo-1' })
      mocks.store.repos = [
        { id: 'repo-1', path: String.raw`C:\src\repo`, addedAt: 1, displayName: 'Repo' }
      ]
      vi.spyOn(inventory, 'loadProjectLaunchContext').mockResolvedValue({
        agents: ['codex'],
        workspaceKind: 'git-worktree',
        executionContext: {
          kind: 'host',
          projectRuntime: resolveProjectExecutionRuntime({
            appPlatform: 'win32',
            projectId: 'repo-1'
          })
        }
      })
      mocks.ensureDetectedAgents.mockResolvedValue(['claude'])
      mocks.createWorktree.mockImplementationOnce(async () => {
        useAppStore.setState({ worktreesByRepo: { 'repo-1': [worktree] } })
        return { worktree }
      })
      await expect(launch({ agentOverride })).resolves.toBe(agentOverride === undefined)
      expect(mocks.ensureDetectedAgents).toHaveBeenCalledWith(worktree.id)
      if (agentOverride) {
        expect(mocks.toastError).toHaveBeenCalledWith(expect.any(String))
        expect(mocks.updateWorktreeMeta).not.toHaveBeenCalled()
      } else {
        expect(mocks.updateWorktreeMeta).toHaveBeenCalledWith(worktree.id, {
          createdWithAgent: 'claude'
        })
        expect(mocks.activateAndRevealWorktree.mock.lastCall?.[1].startup).toMatchObject({
          launchAgent: 'claude'
        })
        expect(mocks.activateAndRevealWorktree.mock.lastCall?.[1].startup.command).toContain(
          'claude'
        )
      }
    }
  )

  it.each([false, true])(
    'uses cached owner defaults and preserves supplied preferences (%s)',
    async (supplied) => {
      stageChat()
      const repo = {
        id: 'repo-1',
        path: '/repo',
        executionHostId: 'runtime:alpha',
        addedAt: 1,
        displayName: 'Repo'
      }
      const status = {
        ...createCompatibleRuntimeStatusResponse('r1').result,
        hostPlatform: 'linux' as const
      }
      useAppStore.setState({
        repos: [repo],
        runtimeStatusByEnvironmentId: new Map([['alpha', { status, checkedAt: 1 }]]),
        ensureRuntimeDetectedAgents: async () => ['claude', 'codex']
      })
      mocks.store.settings = { defaultTuiAgent: 'claude', experimentalNativeChat: true }
      hostMocks.supports.mockResolvedValue(true)
      hostMocks.callRuntimeRpc.mockResolvedValue({
        settings: projectAgentLaunchSettings({ defaultTuiAgent: 'codex' })
      })
      await ensureAgentLaunchPreferences(useAppStore.getState(), {
        kind: 'git-worktree',
        repoId: repo.id,
        executionHostId: repo.executionHostId
      })
      vi.spyOn(inventory, 'loadProjectLaunchContext').mockResolvedValue(undefined)
      hostMocks.callRuntimeRpc.mockClear()
      const agent = supplied ? 'claude' : 'codex'
      await expect(
        launch({
          ...(supplied
            ? { agentLaunchPreferences: { defaultTuiAgent: 'claude', disabledTuiAgents: [] } }
            : {})
        })
      ).resolves.toBe(true)
      expect(mocks.updateWorktreeMeta).toHaveBeenCalledWith('repo-1::/repo/worktree', {
        createdWithAgent: agent
      })
      expect(beginDirectWorkItemStructuredLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          plan: expect.objectContaining({ agent, route: 'structured-native-chat' })
        })
      )
      expect(hostMocks.callRuntimeRpc).not.toHaveBeenCalled()
    }
  )

  it('uses the post-availability snapshot for changed default, route and startup settings', async () => {
    stageChat()
    mocks.store.settings = { defaultTuiAgent: 'codex', experimentalNativeChat: true }
    mocks.ensureDetectedAgents.mockResolvedValue(['claude'])
    const opened = Promise.withResolvers<Parameters<typeof hostMocks.subscribe>[3]>()
    const unsubscribe = vi.fn()
    hostMocks.subscribe.mockImplementation(async (_target, _method, _params, handlers) => {
      opened.resolve(handlers)
      return { unsubscribe }
    })
    vi.spyOn(inventory, 'loadProjectLaunchContext').mockResolvedValue({
      agents: ['claude'],
      workspaceKind: 'git-worktree',
      executionContext: {
        kind: 'host',
        projectRuntime: resolveProjectExecutionRuntime({
          appPlatform: 'darwin',
          projectId: 'repo-1'
        })
      }
    })
    const action = launch()
    const handlers = await opened.promise
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        defaultTuiAgent: 'claude',
        experimentalNativeChat: false,
        agentCmdOverrides: { claude: 'custom-claude' }
      }
    })
    handlers.onEvent({
      type: 'availability',
      agents: [{ agent: 'codex', state: 'available', chatProgram: 'available' }]
    })
    await expect(action).resolves.toBe(true)
    expect(beginDirectWorkItemStructuredLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({
          agent: 'claude',
          route: 'terminal-tui',
          prompt: item.url,
          promptDelivery: 'draft'
        })
      })
    )
    expect(mocks.activateAndRevealWorktree.mock.lastCall?.[1].startup.command).toContain(
      'custom-claude'
    )
    expect(mocks.updateWorktreeMeta).toHaveBeenCalledWith('repo-1::/repo/worktree', {
      createdWithAgent: 'claude'
    })
    expect(hostMocks.subscribe).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it.each(['blank', 'codex'] as const)(
    'keeps blank creation and disabled preferred fallback (%s)',
    async (defaultTuiAgent) => {
      mocks.store.settings = {
        defaultTuiAgent,
        disabledTuiAgents: ['codex'],
        experimentalNativeChat: false
      }
      mocks.ensureDetectedAgents.mockResolvedValue(['claude', 'codex'])
      await expect(launch()).resolves.toBe(true)
      const selected = defaultTuiAgent === 'blank' ? undefined : 'claude'
      expect(mocks.activateAndRevealWorktree.mock.lastCall?.[1].startup?.launchAgent).toBe(selected)
    }
  )

  it('matches new-tab unavailable fallback through the moved prospective selector', async () => {
    const { resolveDefaultAgentForNewTab } = await import('./agent-tab-shortcuts')
    mocks.store.settings = { defaultTuiAgent: 'codex', experimentalNativeChat: false }
    mocks.ensureDetectedAgents.mockResolvedValue([])
    const store = useAppStore.getState()
    const prospective = await resolveDirectProspectiveAgent(store, store.repos[0], undefined, {})
    expect(prospective.prospectiveAgent).toBe(
      resolveDefaultAgentForNewTab({
        defaultTuiAgent: 'codex',
        detectedAgentIds: [],
        disabledTuiAgents: []
      })
    )
    expect(prospective.prospectiveAgent).toBeNull()
  })

  it.each([100, 1000])(
    'bounds real default acquisition without root traversal over %s worktrees',
    async (n) => {
      stageChat()
      mocks.store.settings = { defaultTuiAgent: 'codex', experimentalNativeChat: true }
      const rows = Array.from({ length: n }, (_, i) =>
        makeWorktree({ id: `repo-1::/repo/w${i}`, path: `/repo/w${i}`, repoId: 'repo-1' })
      )
      const target = rows[n - 1]
      useAppStore.setState({
        worktreesByRepo: { 'repo-1': rows },
        readLocalAgentInventory: () => ({ state: 'successful', ids: ['claude'] })
      })
      mocks.ensureDetectedAgents.mockResolvedValue(['claude'])
      mocks.createWorktree.mockResolvedValue({ worktree: target })
      vi.spyOn(inventory, 'loadProjectLaunchContext').mockResolvedValue({
        agents: ['claude'],
        workspaceKind: 'git-worktree',
        executionContext: {
          kind: 'host',
          projectRuntime: resolveProjectExecutionRuntime({
            appPlatform: 'darwin',
            projectId: 'repo-1'
          })
        }
      })
      const unsubscribe = vi.fn()
      hostMocks.subscribe.mockImplementation(async (_target, _method, _params, handlers) => {
        queueMicrotask(() =>
          handlers.onEvent({
            type: 'availability',
            agents: ['codex', 'claude'].map((agent) => ({
              agent,
              state: 'available',
              chatProgram: 'available'
            }))
          })
        )
        return { unsubscribe }
      })
      const offers = vi.spyOn(chatPrograms, 'agentsOfferedForLaunch')
      const routes = vi.spyOn(routeInputs, 'buildAgentLaunchRouteInput')
      let inRootLookup = false,
        visits = 0
      const find = rows.find
      vi.spyOn(rows, 'find').mockImplementation((predicate, thisArg) =>
        find.call(rows, (row, index, array) => {
          if (inRootLookup) visits++
          return predicate.call(thisArg, row, index, array)
        })
      )
      const lookup = worktreeRows.findWorktreeById
      const roots = vi.spyOn(worktreeRows, 'findWorktreeById').mockImplementation((byRepo, id) => {
        inRootLookup = true
        try {
          return lookup(byRepo, id)
        } finally {
          inRootLookup = false
        }
      })
      await expect(launch()).resolves.toBe(true)
      expect(offers).toHaveBeenCalledOnce()
      expect(offers.mock.results[0].value).toEqual(['claude', 'codex'])
      expect(routes.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(routes.mock.calls.length).toBeLessThanOrEqual(20)
      for (const cwd of [undefined, null, '', '  ']) {
        expect(
          routeInputs.buildAgentLaunchRouteInput(useAppStore.getState(), {
            agent: 'codex',
            workspace: { kind: 'git-worktree', worktreeId: target.id },
            tuiCustomization: { cwd }
          }).startsOutsideWorkspaceRoot
        ).toBe(false)
      }
      expect(roots).not.toHaveBeenCalled()
      expect(visits).toBe(0)
      expect(mocks.updateWorktreeMeta).toHaveBeenCalledWith(target.id, {
        createdWithAgent: 'codex'
      })
      expect(beginDirectWorkItemStructuredLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          plan: expect.objectContaining({ agent: 'codex', route: 'structured-native-chat' })
        })
      )
      expect(hostMocks.subscribe).toHaveBeenCalledOnce()
      expect(unsubscribe).toHaveBeenCalledOnce()
    }
  )
})
