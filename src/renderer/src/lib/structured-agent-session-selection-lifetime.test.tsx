// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { useAppStore } from '@/store'
import { useStructuredAgentSessionOptionState } from '@/components/native-chat/use-structured-agent-session-option-state'
import { structuredAgentSessionSeedCatalog } from '../../../shared/structured-agent-session-seed-catalog'
import { structuredAgentSessionMessageSelection } from '../../../shared/structured-agent-session-option-view'
import { structuredAgentSessionModelId } from '../../../shared/structured-agent-session-option-state'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import {
  holdStructuredAgentSessionLaunchOption,
  structuredLaunchSelectionController
} from './structured-agent-session-launch-options'
import {
  getStructuredLaunchStateBySessionId,
  resetStructuredAgentLaunchRegistryForTests
} from './agent-session/launch/structured-agent-session-launch-registry'
import { useStructuredAgentSessionOptions } from '@/components/native-chat/use-structured-agent-session-options'
import { listRuntimeSessionHostsForStartup } from '@/app-shell/startup-runtime-session-hosts'
import { structuredAgentSessionTargetForTab } from '@/runtime/structured-agent-session-owner'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import {
  forgetStructuredSessionSelection,
  structuredSessionSelectionController
} from './structured-agent-session-selection-controller'

const transport = vi.hoisted(() => ({
  create: vi.fn(),
  intent: vi.fn(),
  call: vi.fn(),
  remember: vi.fn()
}))
vi.mock('./launch-structured-agent-session', () => ({
  createStructuredAgentSessionLaunchIntent: transport.intent,
  abandonStructuredAgentSessionLaunchIntent: vi.fn()
}))
vi.mock('./structured-agent-session-launch-create-call', () => ({
  launchStructuredAgentSession: transport.create
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: transport.call
}))
vi.mock('@/components/native-chat/StructuredAgentSessionStatusBridge', () => ({
  useStructuredAgentSessionStatusSummary: () => ({ summary: undefined, observation: 0 })
}))
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapability: () => true,
  useStructuredAgentSessionOwnPermissionState: () => 'supported',
  structuredAgentSessionHostKey: () => 'paired-host'
}))
vi.mock('@/components/native-chat/native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: transport.remember
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() } }))

const target = { kind: 'environment', environmentId: 'paired-host' } as const
const sessionId = 'codex_reconnect'
const initial = useAppStore.getState()
const catalog = structuredAgentSessionSeedCatalog('codex')
const seed = { model: 'gpt-5.5' }
function publish(runtimeId: string, sequence: number) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the production status slice reads runtime identity and protocol fields here.
  const status = {
    runtimeId,
    runtimeProtocolVersion: 3,
    minCompatibleRuntimeClientVersion: 3
  } as RuntimeStatus
  useAppStore.getState().setRuntimeEnvironmentStatus(
    target.environmentId,
    {
      status,
      checkedAt: sequence,
      snapshot: {
        environmentId: target.environmentId,
        pairingRevision: 1,
        sequence,
        checkedAt: sequence,
        status,
        verification: 'verified',
        transport: 'ready'
      }
    },
    { suppressDisconnectToast: true }
  )
}
afterEach(() => {
  cleanup()
  forgetStructuredSessionSelection(sessionId)
  resetStructuredAgentLaunchRegistryForTests()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
})

it.each([false, true])(
  'keeps launch, hook, drawn and captured operations through the real runtime transition (newer pick=%s)',
  async (newer) => {
    const intent: StructuredAgentSessionLaunchIntent = {
      worktreeId: 'wt-lifetime',
      executionHostId: 'runtime:paired-host',
      target,
      sessionId,
      agent: 'codex',
      seedOptions: seed,
      params: {
        agent: 'codex',
        worktree: 'id:wt-lifetime',
        envelope: {
          sessionId,
          clientOperationId: 'original-create',
          payloadFingerprint: 'frozen',
          expectedRuntimeFence: null
        }
      }
    }
    transport.intent.mockReturnValue(intent)
    const create = Promise.withResolvers<{ sessionId: string; fence: number }>()
    transport.create.mockReturnValue(create.promise)
    const replies = [Promise.withResolvers<unknown>(), Promise.withResolvers<unknown>()]
    const reads: ReturnType<typeof Promise.withResolvers<unknown>>[] = []
    let sends = 0
    transport.call.mockImplementation((_target, method) => {
      if (method === 'agentSession.options') {
        const read = Promise.withResolvers<unknown>()
        reads.push(read)
        return read.promise
      }
      if (method === 'agentSession.setOption') {
        return replies[sends++].promise
      }
      return Promise.resolve({})
    })
    useAppStore.getState().setRuntimeEnvironments([environment(1)])
    publish('runtime-A', 1)
    const launch = startStructuredAgentLaunch('wt-lifetime', 'codex', {
      requestId: 'lifetime',
      executionHostId: 'runtime:paired-host'
    })
    const state = getStructuredLaunchStateBySessionId(sessionId)!
    const owner = structuredLaunchSelectionController(state)
    let original: ReturnType<typeof holdStructuredAgentSessionLaunchOption>
    act(() => {
      original = holdStructuredAgentSessionLaunchOption(sessionId, 'model', 'gpt-5.4')
    })
    const hook = renderHook(
      ({ visible }) =>
        useStructuredAgentSessionOptions({
          agent: 'codex',
          sessionId,
          target,
          fence: visible ? 7 : null,
          launch: { kind: 'new', seedOptions: seed },
          isVisible: false,
          transportEnabled: true,
          providerVisible: visible,
          turnId: null,
          unloadedTurnRevisions: undefined,
          mutate: async () => ({ status: 'rejected' })
        }),
      { initialProps: { visible: false } }
    )
    const readHook = renderHook(() =>
      useStructuredAgentSessionOptionState({
        agent: 'codex',
        optionCatalog: catalog,
        identity: `codex:${sessionId}`,
        fence: 1,
        sessionId,
        target,
        newLaunch: true,
        seedsModel: true,
        providerVisible: true,
        providerStarting: false,
        hostOptionStamp: '',
        readsBeforeStart: true,
        turnId: null,
        unloadedTurnRevisions: undefined
      })
    )
    expect(reads).toHaveLength(1)
    const capture = () => {
      const source = hook.result.current.sendSource
      const view = source.optionView(source.optionStateRef.current, seed)
      return {
        drawn: structuredAgentSessionModelId(view.record, 'own'),
        selection: structuredAgentSessionMessageSelection(view)
      }
    }
    let settled = false
    void original!.then(() => {
      settled = true
    })
    const retainedOwners = new Set([owner])
    for (let generation = 2; generation <= (newer ? 100 : 10); generation++) {
      act(() => publish(`runtime-${generation}`, generation))
      retainedOwners.add(structuredSessionSelectionController(target, sessionId, 'codex'))
      retainedOwners.add(structuredLaunchSelectionController(state))
    }
    expect(retainedOwners.size).toBe(1)
    await act(async () => reads[0].resolve({ models: [], current: { model: 'stale-generation' } }))
    expect(readHook.result.current.optionState.optionsAnswerPresent).not.toBe(true)
    readHook.unmount()
    reads.length = 0
    expect(structuredSessionSelectionController(target, sessionId, 'codex')).toBe(owner)
    expect(structuredLaunchSelectionController(state)).toBe(owner)
    expect(settled).toBe(false)
    expect(capture()).toMatchObject({ drawn: 'gpt-5.4', selection: { model: 'gpt-5.4' } })
    let chosen = original!
    if (newer) {
      act(() => {
        chosen = holdStructuredAgentSessionLaunchOption(sessionId, 'model', 'gpt-5.3-codex')!
      })
      await expect(original!).resolves.toEqual({ kind: 'superseded' })
    }
    const model = newer ? 'gpt-5.3-codex' : 'gpt-5.4'
    expect(capture()).toMatchObject({ drawn: model, selection: { model } })
    await act(async () => create.resolve({ sessionId, fence: 7 }))
    expect(sends).toBe(1)
    hook.rerender({ visible: true })
    await waitFor(() => expect(reads).toHaveLength(1))
    let attached: Promise<boolean> | undefined
    if (newer) {
      act(() => {
        attached = hook.result.current.setStructuredOption('effort', 'high')
      })
      expect(sends).toBe(2)
      expect(capture().selection).toMatchObject({ model, effort: 'high' })
      await act(async () =>
        replies[1].resolve({ ok: true, value: { options: { model, effort: 'high' } } })
      )
      await expect(attached).resolves.toBe(true)
      expect(transport.remember.mock.calls[0][1]).toMatchObject({
        picks: [{ modelId: model, optionId: 'effort', value: 'high' }]
      })
    }
    // This query predates acceptance and cannot acknowledge its later terminal identity.
    await act(async () => replies[0].resolve({ ok: true, value: { options: { model } } }))
    await expect(chosen).resolves.toMatchObject({ kind: 'accepted' })
    await launch.launchResult
    const completed = owner.captureRead()
    expect(completed).toHaveLength(newer ? 2 : 1)
    expect(transport.remember).toHaveBeenCalledTimes(newer ? 2 : 1)
    if (newer) {
      expect(transport.remember.mock.calls[1][1]).toMatchObject({
        picks: [
          { modelId: model, optionId: 'model', value: model, adoptModelAsLaunchDefault: false }
        ]
      })
    }
    expect(hook.result.current.sendSource.optionStateRef.current.optionsAnswerPresent).not.toBe(
      true
    )
    await act(async () => reads[0].resolve({ models: [], current: { model: 'other-client' } }))
    await waitFor(() => expect(reads).toHaveLength(2))
    expect(owner.captureRead()).toEqual(completed)
    await act(async () => reads[1].resolve({ models: [], current: { model: 'other-client' } }))
    await waitFor(() => expect(owner.captureRead()).toEqual([]))
    expect(owner.overlay()).toEqual({})
    expect(capture().drawn).toBe('other-client')
  }
)

const environment = (revision: number): PublicKnownRuntimeEnvironment => ({
  id: target.environmentId,
  name: 'restored',
  createdAt: 1,
  updatedAt: revision,
  pairingRevision: revision,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [],
  preferredEndpointId: 'loopback'
})

it.each(['present', 'initially-absent', 'already-hydrated'] as const)(
  'initializes restored hook affinity only at the first authoritative publication (%s)',
  async (mode) => {
    useAppStore.getState().setRuntimeEnvironments([])
    useAppStore.setState({
      runtimeEnvironmentCatalogHydrated: mode === 'already-hydrated',
      runtimeEnvironmentCatalogSettled: false
    })
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('first list failed'))
      .mockResolvedValue([environment(1)])
    const previousApi = window.api
    Object.defineProperty(window, 'api', {
      value: { runtimeEnvironments: { list } },
      configurable: true,
      writable: true
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      if (mode !== 'already-hydrated') {
        await useAppStore.getState().hydrateRuntimeEnvironmentStatuses()
        expect(useAppStore.getState().runtimeEnvironmentCatalogHydrated).toBe(false)
        expect(useAppStore.getState().runtimeEnvironmentCatalogSettled).toBe(true)
        expect((await listRuntimeSessionHostsForStartup()).hostIds).toEqual(['runtime:paired-host'])
      }
      const restored = structuredAgentSessionTargetForTab(useAppStore.getState(), {
        worktreeId: 'restored',
        executionHostId: 'runtime:paired-host'
      })!
      transport.call.mockResolvedValue({ models: [], current: { model: 'gpt-5.5' } })
      const hook = renderHook(
        ({ visible }) =>
          useStructuredAgentSessionOptionState({
            agent: 'codex',
            optionCatalog: catalog,
            identity: `codex:${sessionId}`,
            fence: 7,
            sessionId,
            target: restored,
            newLaunch: false,
            seedsModel: false,
            providerVisible: visible,
            providerStarting: false,
            hostOptionStamp: '',
            readsBeforeStart: false,
            turnId: null,
            unloadedTurnRevisions: undefined
          }),
        { initialProps: { visible: false } }
      )
      const owner = hook.result.current.controller
      const held = owner.issue('model', 'gpt-5.4', null)
      const unqualified = vi.fn()
      await expect(owner.request(unqualified)).rejects.toThrow('unavailable')
      expect(unqualified).not.toHaveBeenCalled()
      act(() =>
        useAppStore.getState().setRuntimeEnvironments(mode === 'present' ? [environment(1)] : [])
      )
      expect(hook.result.current.controller).toBe(owner)
      if (mode === 'present') {
        hook.rerender({ visible: true })
        await waitFor(() =>
          expect(transport.call).toHaveBeenCalledWith(
            restored,
            'agentSession.options',
            expect.anything(),
            { expectedEnvironmentPairingRevision: 1 }
          )
        )
        expect(held.outcome).toBeUndefined()
        act(() => useAppStore.getState().setRuntimeEnvironments([environment(2)]))
        expect(held.outcome).toEqual({ kind: 'superseded' })
        await expect(owner.request(async () => 'unsafe')).rejects.toThrow('retired')
      } else {
        act(() => useAppStore.getState().setRuntimeEnvironments([environment(2)]))
        const send = vi.fn()
        await expect(owner.request(send)).rejects.toThrow('unavailable')
        expect(send).not.toHaveBeenCalled()
      }
    } finally {
      error.mockRestore()
      Object.defineProperty(window, 'api', {
        value: previousApi,
        configurable: true,
        writable: true
      })
    }
  }
)
