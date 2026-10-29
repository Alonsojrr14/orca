import { expect, it } from 'vitest'
import { execFileAndroidCommandRunner } from './android-command-runner'

it('preserves argument bytes and returns both output streams and nonzero exits as data', async () => {
  const args = ['space text', 'quote\'"', '$() & | ;', '漢🙂']
  const result = await execFileAndroidCommandRunner(process.execPath, [
    '-e',
    'process.stdout.write(JSON.stringify(process.argv.slice(1))); process.stderr.write("stderr"); process.exitCode=7',
    ...args
  ])
  expect(result).toEqual({ stdout: JSON.stringify(args), stderr: 'stderr', code: 7 })
})

it('returns a failed result for a missing executable', async () => {
  await expect(
    execFileAndroidCommandRunner(`${process.execPath}.orca-missing-owned-fixture`, [])
  ).resolves.toEqual({ stdout: '', stderr: '', code: 1 })
})

it('fails a command that exceeds its deadline', async () => {
  const result = await execFileAndroidCommandRunner(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    { timeoutMs: 500 }
  )
  expect(result).toEqual({ stdout: '', stderr: '', code: 1 })
})

it('preserves zero as an unlimited timeout', async () => {
  await expect(
    execFileAndroidCommandRunner(
      process.execPath,
      ['-e', 'setTimeout(()=>process.stdout.write("done"),30)'],
      { timeoutMs: 0 }
    )
  ).resolves.toEqual({ stdout: 'done', stderr: '', code: 0 })
})

it.each(['stdout', 'stderr'] as const)('fails and caps excessive %s output', async (stream) => {
  const result = await execFileAndroidCommandRunner(process.execPath, [
    '-e',
    `process.${stream}.write(Buffer.alloc(17*1024*1024,120));setInterval(()=>{},1000)`
  ])
  expect(result.code).toBe(1)
  expect(Buffer.byteLength(result[stream])).toBe(16 * 1024 * 1024)
})

it('closes unused stdin so a no-input command can finish', async () => {
  await expect(
    execFileAndroidCommandRunner(
      process.execPath,
      ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("eof"))'],
      { timeoutMs: 3000 }
    )
  ).resolves.toEqual({ stdout: 'eof', stderr: '', code: 0 })
})
