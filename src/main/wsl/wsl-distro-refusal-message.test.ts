import { expect, it } from 'vitest'
import { isWslDistroRefusalError } from '../../shared/wsl-distro-refusal'
import { WslDistroStoppedError, WslDistroUnverifiableError } from './wsl-unc-access-gate'

it('recognizes both gate refusals as they arrive over IPC, and nothing else', () => {
  const overIpc = (error: Error): Error =>
    new Error(
      `Error invoking remote method 'preflight:detectAgents': ${error.name}: ${error.message}`
    )
  expect(isWslDistroRefusalError(overIpc(new WslDistroStoppedError('Ubuntu')))).toBe(true)
  expect(isWslDistroRefusalError(overIpc(new WslDistroUnverifiableError('Ubuntu')))).toBe(true)
  expect(isWslDistroRefusalError(new Error('wsl.exe timed out'))).toBe(false)
})
