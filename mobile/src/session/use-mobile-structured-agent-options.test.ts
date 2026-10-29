import { createElement, useLayoutEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionResult,
  AgentSessionOptionsResult
} from '../../../src/shared/agent-session-wire'
import type { SessionOptionDescriptor } from '../../../src/shared/native-chat/input/native-chat-session-options'
import type { RpcClient } from '../transport/rpc-client'
import type {
  StructuredAgentSessionMutate,
  StructuredAgentSessionMutationResult
} from './mobile-structured-agent-session-rpc'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'
import { rememberMobileCreatedStructuredSession } from './mobile-created-structured-sessions'

const OPTIONS: AgentSessionOptionsResult = {
  models: [
    {
      id: 'gpt-live',
      label: 'GPT Live',
      isDefault: true,
      defaultEffort: 'medium',
      efforts: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' }
      ]
    },
    {
      id: 'gpt-fast',
      label: 'GPT Fast',
      isDefault: false,
      defaultEffort: 'low',
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' }
      ]
    }
  ],
  current: { model: 'gpt-live', effort: 'medium' }
}

const FAST_OPTIONS: AgentSessionOptionsResult = {
  ...OPTIONS,
  models: OPTIONS.models.map((model) => ({ ...model, supportsFastMode: true })),
  fastModeSupport: { supported: true },
  current: { ...OPTIONS.current, fastMode: false, confirmed: ['fastMode'] }
}

const FAST_OPTIONS_ON: AgentSessionOptionsResult = {
  ...FAST_OPTIONS,
  current: { ...FAST_OPTIONS.current, fastMode: true }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function rpcSuccess(result: unknown) {
  return { id: 'rpc-1', ok: true as const, result, _meta: { runtimeId: 'runtime-1' } }
}

type SentRequest = { method: string; params: unknown }

function optionsClient(
  reads: () => Promise<AgentSessionOptionsResult>,
  catalog?: (params: unknown) => Promise<AgentSessionModelCatalogResult>
) {
  const sent: SentRequest[] = []
  const client: RpcClient = {
    sendRequest: async (method: string, params?: unknown) => {
      sent.push({ method, params })
      if (method === 'agentSession.modelCatalog') {
        // Without a scripted catalog, the host predates the method.
        return catalog
          ? rpcSuccess(await catalog(params))
          : {
              id: 'rpc-1',
              ok: false as const,
              error: { code: 'method_not_found', message: 'Unknown method' },
              _meta: { runtimeId: 'runtime-1' }
            }
      }
      return rpcSuccess(method === 'agentSession.options' ? await reads() : {})
    },
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  const methods = (name: string) => sent.filter((entry) => entry.method === name)
  return { client, sent, methods, optionReads: () => methods('agentSession.options').length }
}

function queuedReads(...results: AgentSessionOptionsResult[]) {
  let index = 0
  return () => Promise.resolve(results[Math.min(index++, results.length - 1)]!)
}

type MutateCall = { method: string; fields: Record<string, unknown> }

// Use an untyped mock: a concrete fixture cannot satisfy arbitrary TValue from the generic mutation caller.
function recordingMutate(
  next: (call: number) => Promise<StructuredAgentSessionMutationResult<AgentSessionOptionResult>>
) {
  const calls: MutateCall[] = []
  const mock = vi.fn()
  mock.mockImplementation(
    (method: string, _fingerprintMethod: string, fields: Record<string, unknown>) => {
      calls.push({ method, fields })
      return next(calls.length - 1)
    }
  )
  const mutate: StructuredAgentSessionMutate = mock
  return { calls, mutate }
}

function accepted(
  value: AgentSessionOptionResult,
  sameFence: boolean
): StructuredAgentSessionMutationResult<AgentSessionOptionResult> {
  return { status: 'accepted', value, sameFence }
}

type Controller = ReturnType<typeof useMobileStructuredAgentOptions>

type ProbeProps = {
  agent: string | null
  client: RpcClient | null
  sessionId: string | null
  fence: number | null
  mutate: StructuredAgentSessionMutate
  optionStamp?: string
  turnId?: string | null
  sendSelection?: boolean
  coherentCatalog?: boolean
  onRender: (controller: Controller) => void
}

function Probe(props: ProbeProps): null {
  const controller = useMobileStructuredAgentOptions({
    agent: props.agent,
    client: props.client,
    sessionId: props.sessionId,
    enabled: true,
    fence: props.fence,
    mutate: props.mutate,
    turnId: props.turnId ?? null,
    ...(props.optionStamp ? { optionStamp: props.optionStamp } : {}),
    hostSupport: {
      permissionModes: true,
      statusFeed: false,
      sendSelection: props.sendSelection,
      coherentModelCatalog: props.coherentCatalog
    }
  })
  useLayoutEffect(() => props.onRender(controller), [controller, props.onRender])
  return null
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mountOptions(props: Omit<ProbeProps, 'onRender'>) {
  let rendered: Controller | null = null
  const onRender = (controller: Controller) => {
    rendered = controller
  }
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(Probe, { ...props, onRender }))
  })
  await settle()
  const current = (): Controller => {
    if (!rendered) {
      throw new Error('probe never rendered')
    }
    return rendered
  }
  return {
    current,
    rerender: async (next: Partial<Omit<ProbeProps, 'onRender'>>) => {
      await act(async () => {
        renderer?.update(createElement(Probe, { ...props, ...next, onRender }))
      })
      await settle()
    },
    unmount: async () => {
      await act(async () => renderer?.unmount())
    }
  }
}

function descriptorFor(
  snapshot: readonly SessionOptionDescriptor[],
  id: string
): SessionOptionDescriptor | undefined {
  return snapshot.find((entry) => entry.id === id)
}

function currentValueOf(snapshot: readonly SessionOptionDescriptor[], id: string) {
  const kind = descriptorFor(snapshot, id)?.kind
  return kind && 'currentValue' in kind ? kind.currentValue : undefined
}

const BASE = { agent: 'codex', sessionId: 'session-1', fence: 1 } as const

describe('useMobileStructuredAgentOptions fast mode', () => {
  it('round-trips a boolean fastMode pick as the wire string and remembers the decoded pick', async () => {
    const client = optionsClient(queuedReads(FAST_OPTIONS, FAST_OPTIONS_ON))
    const { calls, mutate } = recordingMutate(async () =>
      accepted(
        { key: 'fastMode', value: 'true', options: { model: 'gpt-live', fastMode: 'true' } },
        true
      )
    )
    const harness = await mountOptions({ ...BASE, client: client.client, mutate })

    expect(currentValueOf(harness.current().optionSnapshot, 'fastMode')).toBe(false)

    let outcome: boolean | null = null
    await act(async () => {
      outcome = await harness.current().setStructuredOption('fastMode', true)
    })
    await settle()

    expect(outcome).toBe(true)
    expect(calls).toEqual([
      { method: 'agentSession.setOption', fields: { key: 'fastMode', value: 'true' } }
    ])
    expect(currentValueOf(harness.current().optionSnapshot, 'fastMode')).toBe(true)

    const persisted = client.methods('settings.mutateNativeChatSessionOptions')
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.params).toMatchObject({
      type: 'apply-picks',
      agent: 'codex',
      picks: expect.arrayContaining([{ modelId: 'gpt-live', optionId: 'fastMode', value: true }])
    })
    await harness.unmount()
  })

  it('offers no Fast row when the provider catalog never claimed support', async () => {
    const client = optionsClient(queuedReads(OPTIONS))
    const { calls, mutate } = recordingMutate(async () =>
      accepted({ key: 'fastMode', value: 'true' }, true)
    )
    const harness = await mountOptions({ ...BASE, client: client.client, mutate })

    expect(descriptorFor(harness.current().optionSnapshot, 'model')).toBeDefined()
    expect(descriptorFor(harness.current().optionSnapshot, 'fastMode')).toBeUndefined()

    let outcome: boolean | null = null
    await act(async () => {
      outcome = await harness.current().setStructuredOption('fastMode', true)
    })
    expect(outcome).toBe(true)
    expect(calls).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({ key: 'fastMode', value: 'true' })
      })
    ])
    await harness.unmount()
  })

  it('offers no Fast row when the session reports fast mode unsupported', async () => {
    const client = optionsClient(
      queuedReads({ ...FAST_OPTIONS, fastModeSupport: { supported: false, reason: 'account' } })
    )
    const { mutate } = recordingMutate(async () => ({ status: 'rejected' }))
    const harness = await mountOptions({ ...BASE, client: client.client, mutate })

    expect(descriptorFor(harness.current().optionSnapshot, 'fastMode')).toBeUndefined()
    await harness.unmount()
  })

  it('offers no Fast row when the model capability is unknown', async () => {
    const client = optionsClient(
      queuedReads({
        ...FAST_OPTIONS,
        models: OPTIONS.models
      })
    )
    const { mutate } = recordingMutate(async () => ({ status: 'rejected' }))
    const harness = await mountOptions({ ...BASE, client: client.client, mutate })

    expect(descriptorFor(harness.current().optionSnapshot, 'fastMode')).toBeUndefined()
    await harness.unmount()
  })
})

describe('useMobileStructuredAgentOptions post-write refresh', () => {
  it('reads options back after an accepted same-fence write and applies the refreshed value', async () => {
    const client = optionsClient(queuedReads(FAST_OPTIONS, FAST_OPTIONS_ON))
    // The reply settles the operation; only the query installs the chat's selection.
    const { mutate } = recordingMutate(async () =>
      accepted({ key: 'fastMode', value: 'true', options: {} }, true)
    )
    const harness = await mountOptions({ ...BASE, client: client.client, mutate })

    expect(client.optionReads()).toBe(1)
    expect(currentValueOf(harness.current().optionSnapshot, 'fastMode')).toBe(false)

    await act(async () => {
      await harness.current().setStructuredOption('fastMode', true)
    })
    await settle()

    expect(client.optionReads()).toBe(2)
    expect(currentValueOf(harness.current().optionSnapshot, 'fastMode')).toBe(true)
    await harness.unmount()
  })

  it('revalidates an accepted operation even when its reply names an older fence', async () => {
    const client = optionsClient(queuedReads(FAST_OPTIONS, FAST_OPTIONS_ON))
    const { mutate } = recordingMutate(async () =>
      accepted({ key: 'fastMode', value: 'true', options: {} }, false)
    )
    const harness = await mountOptions({ ...BASE, client: client.client, mutate })

    await act(async () => {
      await harness.current().setStructuredOption('fastMode', true)
    })
    await settle()

    expect(client.optionReads()).toBe(2)
    expect(currentValueOf(harness.current().optionSnapshot, 'fastMode')).toBe(true)
    await harness.unmount()
  })
})

describe('useMobileStructuredAgentOptions reads', () => {
  it('re-reads the options each turn, as desktop does', async () => {
    const client = optionsClient(queuedReads(OPTIONS))
    const { mutate } = recordingMutate(async () => ({ status: 'unknown' }))
    const harness = await mountOptions({ ...BASE, client: client.client, mutate })
    expect(client.optionReads()).toBe(1)
    await harness.rerender({ turnId: 'turn-1' })
    expect(client.optionReads()).toBe(2)
    await harness.unmount()
  })
})

describe('useMobileStructuredAgentOptions generation fencing', () => {
  it('drops an options read a later write superseded', async () => {
    const stale = deferred<AgentSessionOptionsResult>()
    const first = optionsClient(queuedReads(FAST_OPTIONS))
    // Reconnect replaces the client without staling the retained record; generation must fence its prior read.
    let reads = 0
    const reconnected = optionsClient(() =>
      reads++ === 0
        ? stale.promise
        : Promise.resolve({
            ...FAST_OPTIONS,
            current: { ...FAST_OPTIONS.current, model: 'gpt-fast' }
          })
    )
    const { mutate } = recordingMutate(async () =>
      accepted({ key: 'model', value: 'gpt-fast', options: { model: 'gpt-fast' } }, true)
    )
    const harness = await mountOptions({ ...BASE, client: first.client, mutate })

    expect(currentValueOf(harness.current().optionSnapshot, 'model')).toBe('gpt-live')
    await harness.rerender({ client: reconnected.client })
    expect(reconnected.optionReads()).toBe(1)

    let outcome: boolean | null = null
    await act(async () => {
      outcome = await harness.current().setStructuredOption('model', 'gpt-fast')
    })
    await settle()
    expect(outcome).toBe(true)
    expect(currentValueOf(harness.current().optionSnapshot, 'model')).toBe('gpt-fast')

    await act(async () => {
      stale.resolve({ ...FAST_OPTIONS, conversationCommands: ['compact'] })
    })
    await settle()

    expect(currentValueOf(harness.current().optionSnapshot, 'model')).toBe('gpt-fast')
    expect(harness.current().conversationCommands).toEqual([])
    await harness.unmount()
  })
})

describe('useMobileStructuredAgentOptions images', () => {
  it.each([
    ['claude', undefined, true],
    ['grok', undefined, false],
    ['claude', false, false],
    ['grok', true, true]
  ] as const)('offers %s images when its report says %s', async (agent, reported, offered) => {
    const report = reported === undefined ? OPTIONS : { ...OPTIONS, acceptsImages: reported }
    const client = optionsClient(queuedReads(report))
    const { mutate } = recordingMutate(async () => ({ status: 'unknown' }))
    const harness = await mountOptions({ ...BASE, agent, client: client.client, mutate })
    expect(client.optionReads()).toBe(1)
    expect(harness.current().acceptsImages).toBe(offered)
    await harness.unmount()
  })

  it('keeps the answer through a pick made during the read', async () => {
    const stale = deferred<AgentSessionOptionsResult>()
    const first = optionsClient(queuedReads(OPTIONS))
    const reconnected = optionsClient(() => stale.promise)
    const { mutate } = recordingMutate(async () => ({ status: 'unknown' }))
    const harness = await mountOptions({ ...BASE, agent: 'opencode', client: first.client, mutate })
    await harness.rerender({ client: reconnected.client })
    await act(async () => {
      await harness.current().setStructuredOption('model', 'gpt-fast')
    })
    expect(harness.current().acceptsImages).toBe(false)
    await act(async () => {
      stale.resolve({ ...OPTIONS, acceptsImages: true })
    })
    await settle()
    expect(harness.current().acceptsImages).toBe(true)
    await harness.unmount()
  })

  it("never shows one chat's answer on the next while its read is in flight", async () => {
    const next = deferred<AgentSessionOptionsResult>()
    let reads = 0
    const client = optionsClient(() =>
      reads++ === 0 ? Promise.resolve({ ...OPTIONS, acceptsImages: true }) : next.promise
    )
    const { mutate } = recordingMutate(async () => ({ status: 'unknown' }))
    const harness = await mountOptions({ ...BASE, agent: 'grok', client: client.client, mutate })
    expect(harness.current().acceptsImages).toBe(true)
    await harness.rerender({ sessionId: 'session-2' })
    expect(harness.current().acceptsImages).toBe(false)
    await harness.unmount()
  })
})

describe('useMobileStructuredAgentOptions pending picks', () => {
  it('holds a repeat of an option on its way but lets another option go, as desktop does', async () => {
    const client = optionsClient(queuedReads(FAST_OPTIONS, FAST_OPTIONS_ON))
    const inFlight = deferred<StructuredAgentSessionMutationResult<AgentSessionOptionResult>>()
    const { calls, mutate } = recordingMutate(async (call) =>
      call === 0 ? inFlight.promise : accepted({ key: 'fastMode', value: 'true' }, false)
    )
    const harness = await mountOptions({ ...BASE, client: client.client, mutate })

    let firstWrite: Promise<boolean> | null = null
    await act(async () => {
      firstWrite = harness.current().setStructuredOption('effort', 'high')
    })
    expect(calls).toHaveLength(1)
    expect(harness.current().pendingOptionId).toBe('effort')

    let repeat: boolean | null = null
    await act(async () => {
      repeat = await harness.current().setStructuredOption('effort', 'medium')
    })
    expect(repeat).toBe(false)
    expect(calls).toHaveLength(1)

    let other: boolean | null = null
    await act(async () => {
      other = await harness.current().setStructuredOption('fastMode', true)
    })
    expect(other).toBe(true)
    expect(calls).toHaveLength(2)

    await act(async () => {
      inFlight.resolve(accepted({ key: 'effort', value: 'high' }, false))
      await firstWrite
    })
    await settle()
    expect(await firstWrite).toBe(true)
    expect(harness.current().pendingOptionId).toBeNull()
    await harness.unmount()
  })
})

describe('useMobileStructuredAgentOptions for every agent', () => {
  it('reads and picks for an agent with no built-in list, as the desktop does', async () => {
    const client = optionsClient(queuedReads(OPTIONS))
    const { calls, mutate } = recordingMutate(async () =>
      accepted({ key: 'model', value: 'gpt-fast', options: { model: 'gpt-fast' } }, true)
    )
    const harness = await mountOptions({ ...BASE, agent: 'grok', client: client.client, mutate })

    expect(client.optionReads()).toBe(1)
    expect(currentValueOf(harness.current().optionSnapshot, 'model')).toBe('gpt-live')
    await act(async () => {
      await harness.current().setStructuredOption('model', 'gpt-fast')
    })
    await settle()
    expect(calls).toEqual([
      { method: 'agentSession.setOption', fields: { key: 'model', value: 'gpt-fast' } }
    ])
    expect(client.methods('settings.mutateNativeChatSessionOptions')[0]?.params).toMatchObject({
      agent: 'grok'
    })
    await harness.unmount()
  })
})

describe('useMobileStructuredAgentOptions host catalog', () => {
  const HOST_CATALOG: AgentSessionModelCatalogResult = {
    origin: 'probe',
    models: [
      {
        id: 'grok-4',
        label: 'Grok 4',
        isDefault: true,
        defaultEffort: 'high',
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' }
        ]
      }
    ],
    fetchedAt: 1,
    listingNamesConfiguredModel: true
  }

  it('lists the host’s models while the session’s own options read is still waiting', async () => {
    const pending = deferred<AgentSessionOptionsResult>()
    const client = optionsClient(
      () => pending.promise,
      async () => HOST_CATALOG
    )
    const { mutate } = recordingMutate(async () => ({ status: 'unknown' }))
    const harness = await mountOptions({ ...BASE, agent: 'grok', client: client.client, mutate })

    expect(client.methods('agentSession.modelCatalog')[0]?.params).toEqual({
      agent: 'grok',
      sessionId: 'session-1'
    })
    const model = descriptorFor(harness.current().optionSnapshot, 'model')
    expect(model?.kind.type === 'select' && model.kind.choices.map((c) => c.value)).toEqual([
      'grok-4'
    ])
    expect(currentValueOf(harness.current().optionSnapshot, 'model')).toBeUndefined()

    pending.resolve({ ...OPTIONS, current: { model: 'gpt-live', confirmed: ['model'] } })
    await settle()
    expect(currentValueOf(harness.current().optionSnapshot, 'model')).toBe('gpt-live')
    await harness.unmount()
  })

  it.each(['grok', 'codex'])(
    'names the configured model and its effort for a %s chat this phone created',
    async (agent) => {
      const sessionId = `${agent}-created-here`
      rememberMobileCreatedStructuredSession(sessionId, 'id:wt-1')
      const client = optionsClient(
        () => deferred<AgentSessionOptionsResult>().promise,
        async () => HOST_CATALOG
      )
      const { mutate } = recordingMutate(async () => ({ status: 'unknown' }))
      const harness = await mountOptions({
        ...BASE,
        agent,
        sessionId,
        client: client.client,
        mutate
      })

      expect(client.methods('agentSession.modelCatalog')[0]?.params).toEqual({
        agent,
        sessionId,
        worktree: 'id:wt-1'
      })
      expect(currentValueOf(harness.current().optionSnapshot, 'model')).toBe('grok-4')
      expect(currentValueOf(harness.current().optionSnapshot, 'effort')).toBe('high')
      await harness.unmount()
    }
  )

  it('does not name the listed default when a chat this phone created is reopened', async () => {
    const sessionId = 'grok-reopened'
    rememberMobileCreatedStructuredSession(sessionId, 'id:wt-1')
    const live = { ...OPTIONS, current: { model: 'gpt-fast', confirmed: ['model'] } }
    const first = optionsClient(
      () => Promise.resolve(live),
      async () => HOST_CATALOG
    )
    const { mutate } = recordingMutate(async () => ({ status: 'unknown' }))
    const opened = await mountOptions({
      ...BASE,
      agent: 'grok',
      sessionId,
      client: first.client,
      mutate
    })
    await settle()
    await opened.unmount()

    const pending = deferred<AgentSessionOptionsResult>()
    const second = optionsClient(
      () => pending.promise,
      async () => HOST_CATALOG
    )
    const reopened = await mountOptions({
      ...BASE,
      agent: 'grok',
      sessionId,
      client: second.client,
      mutate
    })
    await settle()

    expect(second.methods('agentSession.modelCatalog')[0]?.params).toEqual({
      agent: 'grok',
      sessionId
    })
    expect(currentValueOf(reopened.current().optionSnapshot, 'model')).toBeUndefined()
    pending.resolve(live)
    await settle()
    expect(currentValueOf(reopened.current().optionSnapshot, 'model')).toBe('gpt-fast')
    await reopened.unmount()
  })

  it('waits once for the host’s first listing of the account', async () => {
    const catalog = vi.fn(async (params: unknown): Promise<AgentSessionModelCatalogResult> =>
      typeof params === 'object' && params !== null && 'waitForListing' in params
        ? HOST_CATALOG
        : { origin: 'unknown', listingInProgress: true }
    )
    const client = optionsClient(() => deferred<AgentSessionOptionsResult>().promise, catalog)
    const { mutate } = recordingMutate(async () => ({ status: 'unknown' }))
    const harness = await mountOptions({ ...BASE, agent: 'grok', client: client.client, mutate })
    await settle()

    expect(catalog).toHaveBeenCalledTimes(2)
    const model = descriptorFor(harness.current().optionSnapshot, 'model')
    expect(model?.kind.type === 'select' && model.kind.choices.map((c) => c.value)).toEqual([
      'grok-4'
    ])
    await harness.unmount()
  })

  it('keeps a cold Codex picker usable on the built-in list and lands the listing in place', async () => {
    const listed = deferred<AgentSessionModelCatalogResult>()
    const catalog = vi.fn(async (params: unknown): Promise<AgentSessionModelCatalogResult> =>
      typeof params === 'object' && params !== null && 'waitForListing' in params
        ? listed.promise
        : { origin: 'unknown', listingInProgress: true }
    )
    const client = optionsClient(() => deferred<AgentSessionOptionsResult>().promise, catalog)
    const { calls, mutate } = recordingMutate(async () =>
      accepted({ key: 'model', value: '' }, true)
    )
    const harness = await mountOptions({ ...BASE, client: client.client, mutate })
    await settle()

    const seeded = descriptorFor(harness.current().optionSnapshot, 'model')
    expect(seeded?.settable).toBe(true)
    const seedChoices = seeded?.kind.type === 'select' ? seeded.kind.choices : []
    expect(seedChoices.length).toBeGreaterThan(0)
    await act(async () => {
      await harness.current().setStructuredOption('model', seedChoices[0]!.value)
    })
    expect(calls).toHaveLength(1)

    listed.resolve(HOST_CATALOG)
    await settle()
    const model = descriptorFor(harness.current().optionSnapshot, 'model')
    expect(model?.kind.type === 'select' && model.kind.choices.map((c) => c.value)).toEqual([
      'grok-4',
      seedChoices[0]!.value
    ])
    expect(currentValueOf(harness.current().optionSnapshot, 'model')).toBe(seedChoices[0]!.value)
    await harness.unmount()
  })

  it('keeps the provider-default pill when an older host has no catalog method', async () => {
    const client = optionsClient(() => deferred<AgentSessionOptionsResult>().promise)
    const { mutate } = recordingMutate(async () => ({ status: 'unknown' }))
    const harness = await mountOptions({ ...BASE, agent: 'grok', client: client.client, mutate })

    expect(descriptorFor(harness.current().optionSnapshot, 'model')).toMatchObject({
      settable: false,
      valueSource: 'unknown'
    })
    await harness.unmount()
  })
})

describe('useMobileStructuredAgentOptions after a lost pick reply', () => {
  const tiers = (value: string, label: string) => [{ value, label }]
  const answer = (model: string, serviceTier: string): AgentSessionOptionsResult => ({
    models: [
      {
        id: 'm1',
        label: 'M1',
        isDefault: true,
        efforts: [],
        serviceTiers: tiers('priority', 'Fast')
      },
      { id: 'm2', label: 'M2', isDefault: false, efforts: [], serviceTiers: tiers('flex', 'Flex') }
    ],
    listedModelIds: ['m1', 'm2'],
    current: { model, serviceTier, confirmed: ['model'] }
  })
  const speed = (controller: Controller) => {
    const kind = descriptorFor(controller.optionSnapshot, 'serviceTier')?.kind
    return kind?.type === 'select'
      ? { value: kind.currentValue, choices: kind.choices.map((choice) => choice.value) }
      : null
  }

  it('draws the tier the host reconciled to, stays usable through a failed read, and takes the reconnect read', async () => {
    const pendingRead = deferred<AgentSessionOptionsResult>()
    const reads = [
      () => Promise.resolve(answer('m1', 'priority')),
      () => Promise.reject(new Error('offline')),
      () => pendingRead.promise,
      () => Promise.resolve(answer('m2', 'flex'))
    ]
    const client = optionsClient(() =>
      (reads.shift() ?? (() => Promise.resolve(answer('m2', 'flex'))))()
    )
    const { mutate } = recordingMutate(async () => ({ status: 'unknown' }))
    const harness = await mountOptions({ ...BASE, client: client.client, mutate })
    expect(speed(harness.current())?.value).toBe('priority')

    // The host switched and set Standard, but its reply never arrived.
    await act(async () => {
      await harness.current().setStructuredOption('model', 'm2')
    })
    expect(currentValueOf(harness.current().optionSnapshot, 'model')).toBe('m2')
    expect(speed(harness.current())).toEqual({ value: 'default', choices: ['default', 'flex'] })
    expect(harness.current().pendingOptionId).toBeNull()

    // The status-triggered read fails: nothing changes.
    await harness.rerender({ optionStamp: 'status-1' })
    expect(speed(harness.current())?.value).toBe('default')

    // A read in flight when the user picks Flex answers for the old state and is dropped.
    await harness.rerender({ optionStamp: 'status-2' })
    let picked = false
    await act(async () => {
      picked = await harness.current().setStructuredOption('serviceTier', 'flex')
    })
    expect(picked).toBe(true)
    await act(async () => pendingRead.resolve(answer('m1', 'priority')))
    await settle()
    expect(currentValueOf(harness.current().optionSnapshot, 'model')).toBe('m2')
    expect(speed(harness.current())?.value).toBe('flex')

    // Reconnected, the host's answer stands.
    await harness.rerender({ optionStamp: 'status-3' })
    expect(currentValueOf(harness.current().optionSnapshot, 'model')).toBe('m2')
    expect(speed(harness.current())?.value).toBe('flex')
    expect(client.optionReads()).toBe(5)
    await harness.unmount()
  })
})

it('phone retains a queried seed-catalog base across its fence until later metadata arrives', async () => {
  const catalog = deferred<AgentSessionModelCatalogResult>()
  let reads = 0
  const client = optionsClient(
    () =>
      ++reads === 1
        ? Promise.resolve({
            ...OPTIONS,
            current: {
              model: 'gpt-live',
              effort: 'high',
              defaulted: ['model'],
              acceptedInputSources: { effort: 'saved' }
            }
          })
        : deferred<AgentSessionOptionsResult>().promise,
    () => catalog.promise
  )
  const { mutate } = recordingMutate(async () => accepted({ key: 'effort', value: 'low' }, true))
  rememberMobileCreatedStructuredSession('answered-retention', 'worktree')
  const harness = await mountOptions({
    ...BASE,
    sessionId: 'answered-retention',
    client: client.client,
    mutate,
    sendSelection: true,
    coherentCatalog: true
  })
  expect(harness.current().sendSelection()).toEqual({ selection: { effort: 'high' } })
  await harness.rerender({ fence: 2 })
  expect(harness.current().sendSelection()).toEqual({ selection: { effort: 'high' } })
  await act(async () =>
    catalog.resolve({
      origin: 'probe',
      fetchedAt: 1,
      models: OPTIONS.models,
      listingNamesConfiguredModel: true
    })
  )
  await settle()
  expect(harness.current().sendSelection()).toEqual({ selection: { effort: 'high' } })
  await harness.unmount()
})

it('phone captures accepted echoed inputs, preserves false, and freezes empty vs legacy presence', async () => {
  let answer: AgentSessionOptionsResult = {
    ...FAST_OPTIONS,
    models: [
      {
        id: 'opus',
        label: 'Opus',
        isDefault: true,
        supportsFastMode: true,
        efforts: [{ value: 'high', label: 'High' }]
      }
    ],
    current: {
      model: 'opus',
      effort: 'high',
      fastMode: false,
      confirmed: ['fastMode'],
      acceptedInputSources: {}
    }
  }
  const client = optionsClient(async () => answer)
  const { mutate } = recordingMutate(async () => accepted({ key: 'model', value: 'opus' }, true))
  const harness = await mountOptions({
    ...BASE,
    agent: 'claude',
    client: client.client,
    mutate,
    sendSelection: true
  })
  expect(harness.current().sendSelection()).toEqual({ selection: {} })
  answer = {
    ...answer,
    current: { ...answer.current, acceptedInputSources: { model: 'saved', fastMode: 'policy' } }
  }
  await harness.rerender({ optionStamp: 'saved-origin' })
  await settle()
  const captured = harness.current().sendSelection()
  expect(captured).toEqual({ selection: { model: 'opus', fastMode: 'false' } })
  answer = {
    ...answer,
    current: { ...answer.current, effort: 'high', acceptedInputSources: { effort: 'saved' } }
  }
  await harness.rerender({ optionStamp: 'other-client' })
  await settle()
  expect(harness.current().sendSelection()).toEqual({ selection: { effort: 'high' } })
  expect(captured).toEqual({ selection: { model: 'opus', fastMode: 'false' } })
  await harness.unmount()
})

it('refuses a typed literal at an unresolved fence and accepts it when that fence is ready with no menu', async () => {
  const pending = deferred<AgentSessionOptionsResult>()
  let reads = 0
  const client = optionsClient(() =>
    ++reads === 1 ? Promise.resolve({ models: [], current: {} }) : pending.promise
  )
  const { calls, mutate } = recordingMutate(async () =>
    accepted({ key: 'model', value: 'literal', options: { model: 'literal' } }, true)
  )
  const view = await mountOptions({ ...BASE, client: client.client, mutate })
  await view.rerender({ fence: 2 })
  let result = true
  await act(async () => {
    result = await view.current().setStructuredOption('model', 'literal')
  })
  expect(result).toBe(false)
  expect(calls).toHaveLength(0)
  await act(async () => pending.resolve({ models: [], current: {} }))
  await settle()
  await act(async () => {
    result = await view.current().setStructuredOption('model', 'literal')
  })
  expect(result).toBe(true)
  expect(calls).toHaveLength(1)
  await view.unmount()
})
