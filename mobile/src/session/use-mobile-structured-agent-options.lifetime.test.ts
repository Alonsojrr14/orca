import { createElement, StrictMode, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it } from 'vitest'
import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import type {
  SelectionOperation,
  StructuredSessionSelectionController
} from '../../../src/shared/structured-agent-session-selection-operations'
import type { StructuredAgentSessionMutate } from './mobile-structured-agent-session-rpc'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import { requestStructuredAgentSessionMutation } from './mobile-structured-agent-session-rpc'
import { useMobileStructuredSelectionController } from './use-mobile-structured-selection-controller'
import {
  settle,
  OPTIONS,
  BASE,
  deferred,
  rpcSuccess,
  optionsClient,
  queuedReads,
  recordingMutate,
  mountOptions,
  currentValueOf
} from './use-mobile-structured-agent-options.test-fixture'

it('keeps actual phone operations and correlated acceptance through a stable-client path migration', async () => {
  const stale = deferred<AgentSessionOptionsResult>()
  let oldReads = 0
  const physical = optionsClient(() =>
    ++oldReads === 1 ? Promise.resolve(OPTIONS) : stale.promise
  )
  const currentReads: ReturnType<typeof deferred<AgentSessionOptionsResult>>[] = []
  const next = optionsClient(() => {
    const read = deferred<AgentSessionOptionsResult>()
    currentReads.push(read)
    return read.promise
  })
  const reply = deferred<ReturnType<typeof rpcSuccess>>()
  const send = physical.client.sendRequest
  physical.client.sendRequest = (method, params, options) =>
    method === 'agentSession.setOption' ? reply.promise : send(method, params, options)
  const client = createStableLogicalRpcClient(physical.client, 'lan')
  const mutate: StructuredAgentSessionMutate = async <TValue>(
    method: string,
    fingerprintMethod: string,
    fields: Record<string, unknown>
  ) => {
    const result = await requestStructuredAgentSessionMutation<TValue>({
      client,
      method,
      fingerprintMethod,
      fields,
      sessionId: BASE.sessionId,
      expectedRuntimeFence: 1
    })
    return result.status === 'accepted'
      ? { status: 'accepted', value: result.value, sameFence: false }
      : result.status === 'unknown'
        ? { status: 'unknown' }
        : { status: 'rejected' }
  }
  const view = await mountOptions({ ...BASE, client, mutate })
  let pick!: Promise<boolean>
  act(() => {
    pick = view.current().setStructuredOption('model', 'gpt-fast')
  })
  await view.rerender({ optionStamp: 'old-query' })
  await act(async () => {
    await client.migrateTo(next.client, 'relay')
  })
  await settle()
  await act(async () => stale.resolve({ ...OPTIONS, conversationCommands: ['compact'] }))
  expect(view.current().conversationCommands).toEqual([])
  expect(currentValueOf(view.current().optionSnapshot, 'model')).toBe('gpt-fast')
  await act(async () =>
    reply.resolve(rpcSuccess({ ok: true, value: { options: { model: 'gpt-fast' } } }))
  )
  await expect(pick).resolves.toBe(true)
  expect(next.methods('settings.mutateNativeChatSessionOptions')).toHaveLength(1)
  // The first current query began before acceptance; its trailing query captures the terminal ID.
  await act(async () => currentReads[0].resolve(OPTIONS))
  await settle()
  await act(async () => currentReads.at(-1)!.resolve(OPTIONS))
  await settle()
  expect(currentValueOf(view.current().optionSnapshot, 'model')).toBe('gpt-live')
  await view.unmount()
  client.close()
})

it.each(['session', 'client'] as const)(
  'ends actual %s scope and cleanup replay without reviving setup-time work',
  async (boundary) => {
    const firstClient = optionsClient(queuedReads(OPTIONS))
    const replacement = optionsClient(queuedReads(OPTIONS))
    let current!: StructuredSessionSelectionController
    const setups: {
      controller: StructuredSessionSelectionController
      operation: SelectionOperation
    }[] = []
    let cleanups = 0
    function Scope({ sessionId, client }: { sessionId: string; client: RpcClient }) {
      const { controller } = useMobileStructuredSelectionController({
        agent: 'codex',
        client,
        sessionId,
        onRevalidate: () => {}
      })
      current = controller
      useEffect(() => {
        setups.push({ controller, operation: controller.issue('model', 'gpt-live', null) })
        return () => {
          cleanups++
        }
      }, [controller])
      return null
    }
    const element = (sessionId: string, client: RpcClient) =>
      createElement(StrictMode, null, createElement(Scope, { sessionId, client }))
    let root!: ReactTestRenderer
    await act(async () => {
      root = create(element('scope-A', firstClient.client))
    })
    expect(setups).toHaveLength(2)
    expect(cleanups).toBe(1)
    const old = setups[0]
    await expect(old.operation.result).resolves.toEqual({ kind: 'superseded' })
    act(() =>
      old.controller.settle(old.operation, { kind: 'accepted', options: { model: 'gpt-live' } })
    )
    expect(firstClient.methods('settings.mutateNativeChatSessionOptions')).toHaveLength(0)
    const live = setups[1]
    act(() =>
      live.controller.settle(live.operation, { kind: 'accepted', options: { model: 'gpt-live' } })
    )
    await settle()
    expect(firstClient.methods('settings.mutateNativeChatSessionOptions')).toHaveLength(1)
    const first = current
    const held = first.issue('model', 'gpt-fast', null)
    await act(async () =>
      root.update(
        element(
          boundary === 'session' ? 'scope-B' : 'scope-A',
          boundary === 'client' ? replacement.client : firstClient.client
        )
      )
    )
    await expect(held.result).resolves.toEqual({ kind: 'superseded' })
    act(() => first.settle(held, { kind: 'accepted', options: { model: 'gpt-fast' } }))
    await expect(first.issue('model', 'dead', null).result).resolves.toEqual({ kind: 'superseded' })
    expect(current).not.toBe(first)
    const latest = setups.at(-1)!
    act(() =>
      latest.controller.settle(latest.operation, {
        kind: 'accepted',
        options: { model: 'gpt-live' }
      })
    )
    await settle()
    expect(firstClient.methods('settings.mutateNativeChatSessionOptions')).toHaveLength(
      boundary === 'session' ? 2 : 1
    )
    expect(replacement.methods('settings.mutateNativeChatSessionOptions')).toHaveLength(
      boundary === 'client' ? 1 : 0
    )
    const last = current
    const unmounted = last.issue('model', 'gpt-fast', null)
    await act(async () => root.unmount())
    await expect(unmounted.result).resolves.toEqual({ kind: 'superseded' })
    await expect(last.issue('model', 'dead', null).result).resolves.toEqual({ kind: 'superseded' })
  }
)

it('reads the new physical path after an idle connected-to-connected migration without an operation wake', async () => {
  const old = optionsClient(queuedReads(OPTIONS))
  const answer = deferred<AgentSessionOptionsResult>()
  const next = optionsClient(() => answer.promise)
  const client = createStableLogicalRpcClient(old.client, 'lan')
  const { mutate } = recordingMutate(async () => ({ status: 'rejected' }))
  const view = await mountOptions({ ...BASE, client, mutate })
  expect(old.optionReads()).toBe(1)
  expect(view.current().conversationCommands).toEqual([])
  await act(async () => {
    await client.migrateTo(next.client, 'relay')
  })
  await settle()
  expect(next.optionReads()).toBe(1)
  await act(async () => answer.resolve({ ...OPTIONS, conversationCommands: ['compact'] }))
  await settle()
  expect(view.current().conversationCommands).toEqual(['compact'])
  expect(next.methods('agentSession.setOption')).toHaveLength(0)
  await view.unmount()
  client.close()
})
