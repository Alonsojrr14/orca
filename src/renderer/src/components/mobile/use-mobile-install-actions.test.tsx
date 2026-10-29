// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useMobileInstallActions } from './use-mobile-install-actions'

afterEach(cleanup)

it.each([
  ['ios', 'preview'],
  ['ios', 'stable'],
  ['android', 'stable']
] as const)('opens the download page for %s and %s', (platform, channel) => {
  const openUrl = vi.fn()
  Object.defineProperty(window, 'api', { configurable: true, value: { shell: { openUrl } } })
  const { result } = renderHook(() => useMobileInstallActions(platform, channel))

  result.current.openInstallUrl()

  expect(openUrl).toHaveBeenCalledWith('https://onorca.dev/download')
})
