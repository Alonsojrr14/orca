import { runInNewContext } from 'node:vm'
import { posix, win32 } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ADOPTED_DIRECTORY_PROBE_SOURCE } from './adopted-directory-probe'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'

async function helper(
  workspaceCwd: string,
  sourceCwd: string,
  paths: Record<string, string>,
  windows = false
) {
  const reads: string[] = []
  let output = ''
  const process = {
    stdin: (async function* () {
      yield JSON.stringify({ version: 1, workspaceCwd, sourceCwd })
    })(),
    stdout: {
      write: (text: string) => {
        output += text
      }
    },
    exitCode: 0
  }
  await runInNewContext(ADOPTED_DIRECTORY_PROBE_SOURCE, {
    process,
    require: (name: string) =>
      name === 'node:path'
        ? windows
          ? win32
          : posix
        : {
            realpath: vi.fn(async (path: string) => {
              reads.push(path)
              if (!(path in paths)) {
                throw new Error('unavailable')
              }
              return paths[path]
            })
          }
  })
  return { reads, output, code: process.exitCode }
}

it('visits only selected native prefixes, stopping at a match or exhaustion', async () => {
  const result = await helper('/link/pkg', '/physical/pkg', {
    '/link/pkg': '/elsewhere',
    '/link': '/physical',
    '/': '/'
  })
  expect(result).toEqual({
    code: 0,
    output: '{"version":1,"matched":true}',
    reads: ['/link/pkg', '/link']
  })
  const noMatch = await helper('/link/pkg', '/foreign', {
    '/link/pkg': '/elsewhere',
    '/link': '/physical',
    '/': '/'
  })
  expect(noMatch.reads).toEqual(['/link/pkg', '/link', '/'])
  expect(noMatch.output).toBe('{"version":1,"matched":false}')
  const unavailable = await helper('/missing/pkg', '/foreign', { '/': '/' })
  expect(unavailable.code).toBe(1)
  expect(unavailable.output).toBe('')
  const posixBackslash = await helper('/link/pkg', '/physical\\/pkg', {
    '/link/pkg': '/elsewhere',
    '/link': '/physical\\'
  })
  expect(posixBackslash.output).toBe('{"version":1,"matched":true}')
  expect(posixBackslash.reads).toEqual(['/link/pkg', '/link'])
})

it('keeps native drive/UNC, NFC and POSIX comparison semantics, without source dot collapsing', async () => {
  for (const [workspace, resolved, source, windows] of [
    ['C:\\link\\pkg', 'D:\\Physical\\pkg', 'd:/physical/pkg/', true],
    ['\\\\host\\share\\link', '\\\\host\\share\\Physical', '//HOST/share/physical', true],
    ['C:\\link', '\\\\wsl.localhost\\Ubuntu\\Repo', '//wsl$/ubuntu/Repo', true],
    ['C:\\link', '\\\\wsl.localhost\\Ubuntu\\Repo', '//wsl$/ubuntu/repo', true],
    ['/link', '/café', '/cafe\u0301', false],
    ['/link', '/Physical', '/physical', false],
    ['/link', '/physical', '/other/../physical', false]
  ] as const) {
    const path = windows ? win32 : posix
    const paths: Record<string, string> = { [workspace]: resolved }
    for (let parent = path.dirname(workspace); !(parent in paths); parent = path.dirname(parent)) {
      paths[parent] = parent
      if (path.dirname(parent) === parent) {
        break
      }
    }
    const result = await helper(workspace, source, paths, windows)
    expect(result.code).toBe(0)
    expect(JSON.parse(result.output).matched).toBe(
      normalizeRuntimePathForComparison(resolved) === normalizeRuntimePathForComparison(source)
    )
  }
  const wsl = await helper('\\\\wsl.localhost\\Ubuntu\\repo', '/repo', {}, true)
  expect(wsl.code).toBe(1)
  expect(wsl.reads).toEqual([])
})
