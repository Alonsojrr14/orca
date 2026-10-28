import { beforeEach, describe, expect, it, vi } from 'vitest'

const { connectRuntime, connectWslHost, fetchRepos, toastError } = vi.hoisted(() => ({
  connectRuntime: vi.fn(),
  connectWslHost: vi.fn(),
  fetchRepos: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => options?.[name] ?? '')
}))
vi.mock('@/hooks/runtime-project-refresh-scheduler', () => ({
  refreshRuntimeProjectWorktreesAndLineage: vi.fn()
}))
vi.mock('@/store', () => {
  const state = {
    wslHostStatuses: { 'env-1': { distro: 'Ubuntu', state: 'distro-stopped' } },
    setRuntimeEnvironmentStatus: vi.fn(),
    fetchRuntimeEnvironmentRepos: fetchRepos,
    fetchWorktrees: vi.fn(),
    fetchWorktreeLineage: vi.fn()
  }
  return { useAppStore: { getState: () => state } }
})

import { startWslHostAndReloadProjects } from './wsl-host-user-start'

const START_FAILED = 'Couldn’t start Ubuntu. Check it in Settings → Remote Orca Servers.'

beforeEach(() => {
  connectRuntime.mockReset().mockResolvedValue({ ok: true, result: {} })
  connectWslHost.mockReset().mockResolvedValue(undefined)
  fetchRepos.mockReset().mockResolvedValue([])
  toastError.mockReset()
  Object.assign(globalThis, {
    window: {
      api: {
        runtimeEnvironments: { connect: connectRuntime, wslHosts: { connect: connectWslHost } }
      }
    }
  })
})

describe('startWslHostAndReloadProjects', () => {
  it('connects the host once per Start', async () => {
    await expect(startWslHostAndReloadProjects('env-1')).resolves.toBe(true)
    // Main routes this one explicit connect to the WSL host; a second connect reruns its launch.
    expect(connectRuntime).toHaveBeenCalledOnce()
    expect(connectRuntime).toHaveBeenCalledWith(expect.objectContaining({ selector: 'env-1' }))
    expect(connectWslHost).not.toHaveBeenCalled()
  })

  it('names the distro once, never the probe command, when the start fails', async () => {
    connectRuntime.mockRejectedValueOnce(
      new Error('Command "uname -r" failed (exit 1): Wsl/Service/E_UNEXPECTED')
    )
    await expect(startWslHostAndReloadProjects('env-1')).resolves.toBe(false)
    expect(toastError).toHaveBeenCalledOnce()
    expect(toastError).toHaveBeenCalledWith(START_FAILED)
  })

  it('says the same when reloading its projects fails after the boot', async () => {
    fetchRepos.mockRejectedValueOnce(new Error('runtime_call_failed: repo.list timed out'))
    await expect(startWslHostAndReloadProjects('env-1')).resolves.toBe(false)
    expect(toastError).toHaveBeenCalledOnce()
    expect(toastError).toHaveBeenCalledWith(START_FAILED)
  })
})
