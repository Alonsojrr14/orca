import { expect, vi } from 'vitest'
import * as environmentStore from '../../../shared/runtime-environment-store'
import {
  RUNTIME_PROTOCOL_VERSION,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
} from '../../../shared/protocol-version'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'
import {
  structuredSessionSelectionController,
  forgetStructuredSessionSelection
} from '@/lib/structured-agent-session-selection-controller'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

export async function verifyDeferredSelectionAffinity(
  userDataPath: string,
  sendRemoteRuntimeRequestMock: ReturnType<typeof vi.fn>,
  pairingCode: () => string
): Promise<void> {
  const original = environmentStore.addEnvironmentFromPairingCode(userDataPath, {
    name: 'selection-owner',
    pairingCode: pairingCode(),
    now: 1
  })
  const target = { kind: 'environment', environmentId: original.id } as const
  replaceRuntimeEnvironmentRevisions([original])
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: (args: {
          selector: string
          method: string
          params?: unknown
          expectedEnvironmentPairingRevision?: number
        }) =>
          callRuntimeEnvironment(
            userDataPath,
            args.selector,
            args.method,
            args.params,
            undefined,
            args.expectedEnvironmentPairingRevision
          )
      }
    }
  })
  const owner = structuredSessionSelectionController(target, 'selection-queue', 'codex')
  const release = Promise.withResolvers<void>()
  sendRemoteRuntimeRequestMock.mockImplementation(async (_connection, method) => {
    if (method === 'files.read') {
      await release.promise
    }
    return {
      id: method,
      ok: true,
      result:
        method === 'status.get'
          ? {
              runtimeId: 'host',
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
            }
          : {},
      _meta: { runtimeId: 'host' }
    }
  })
  const occupying = Array.from({ length: 8 }, () =>
    callRuntimeEnvironment(userDataPath, original.id, 'files.read', {})
  )
  await vi.waitFor(() =>
    expect(
      sendRemoteRuntimeRequestMock.mock.calls.filter(([, method]) => method === 'files.read')
    ).toHaveLength(8)
  )
  const sendPick = (options: { expectedEnvironmentPairingRevision?: number }) =>
    callRuntimeRpc(
      target,
      'agentSession.setOption',
      {},
      { ...options, skipCompatibilityCheck: true }
    )
  const queued = owner.request(sendPick)
  const changed = environmentStore.updateEnvironmentFromPairingCode(userDataPath, original.id, {
    pairingCode: pairingCode(),
    now: 2
  })
  replaceRuntimeEnvironmentRevisions([changed], {
    retired: [],
    sameHost: [],
    pending: [{ id: original.id, fromRevision: 1 }]
  })
  release.resolve()
  await Promise.all(occupying)
  await expect(queued).rejects.toMatchObject({ code: 'runtime_environment_changed' })
  expect(
    sendRemoteRuntimeRequestMock.mock.calls.some(
      ([, method]) => method === 'agentSession.setOption'
    )
  ).toBe(false)
  expect(structuredSessionSelectionController(target, 'selection-queue', 'codex')).toBe(owner)
  const accepted = owner.issue('model', 'gpt-5.4', null)
  owner.settle(accepted, { kind: 'accepted', options: { model: 'gpt-5.4' } })
  // Memory starts with the original revision too; the pending replacement cannot receive it.
  await Promise.resolve()
  expect(
    sendRemoteRuntimeRequestMock.mock.calls.some(
      ([, method]) => method === 'settings.mutateNativeChatSessionOptions'
    )
  ).toBe(false)
  replaceRuntimeEnvironmentRevisions([changed], {
    retired: [],
    sameHost: [{ id: original.id, fromRevision: 1, toRevision: changed.pairingRevision! }]
  })
  await owner.request(sendPick)
  const later = owner.issue('model', 'gpt-5.3-codex', null)
  owner.settle(later, { kind: 'accepted', options: { model: 'gpt-5.3-codex' } })
  await vi.waitFor(() =>
    expect(
      sendRemoteRuntimeRequestMock.mock.calls.filter(
        ([, method]) => method === 'settings.mutateNativeChatSessionOptions'
      )
    ).toHaveLength(1)
  )
  forgetStructuredSessionSelection('selection-queue', target)
  const count = sendRemoteRuntimeRequestMock.mock.calls.length
  await expect(
    owner.request((options) => callRuntimeRpc(target, 'agentSession.setOption', {}, options))
  ).rejects.toThrow('retired')
  expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledTimes(count)
  replaceRuntimeEnvironmentRevisions([])
}
