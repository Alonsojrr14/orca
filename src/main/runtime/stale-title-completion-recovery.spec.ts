import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { settledWriteStub } from '../providers/settled-pty-write-stub'
import { rememberPaneKeyForPty } from '../ipc/pty/pane/key-state'
import { mainProcessState } from '../startup/main-process-state'
import { driveSyntheticTitleFromHookStatus } from '../startup/synthetic-title-runtime'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  insertDirectRunMessage,
  PANE_KEY,
  PTY_ID,
  TERMINAL_HANDLE,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'

describe('stale-working title clear and completion recovery', () => {
  afterEach(() => {
    vi.useRealTimers()
    mainProcessState.runtime = null
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  // Synthetic: Codex's done hook, then a final native spinner that only the timer clears (#19243).
  it('delivers mail once the clear confirms a live Codex behind a fresh done hook', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-stale-title-completion-')
    const hook: AgentStatusIpcPayload = {
      paneKey: PANE_KEY,
      terminalHandle: TERMINAL_HANDLE,
      agentType: 'codex',
      state: 'done',
      prompt: '',
      connectionId: null,
      receivedAt: Date.now(),
      stateStartedAt: Date.now()
    }
    const { runtime } = createRuntime(db, { getAgentStatusSnapshot: () => [hook] })
    const write = vi.fn((_ptyId: string, _data: string) => true)
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: vi.fn(async () => 'codex')
    })
    const run = createBoundRun(db, 'Timer Run')
    await runtime.listTerminals()
    runtime.ingestSyntheticTitleFrame(PTY_ID, '\x1b]0;Codex ready\x07')
    runtime.onPtyData(PTY_ID, '\x1b]0;⠋ mobile-rearch\x07', 1)
    runtime.onPtyData(PTY_ID, 'composer repaint without a title', 2)
    insertDirectRunMessage(db, run.id, 'Worker progress')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    db.close()
  })

  // Codex with its activity title off paints no working title, so only the working hook can
  // retract the ready label the previous turn's Stop hook wrote (#31980's lead on Windows).
  it('keeps a titleless Codex turn busy once its working hook arrives', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-titleless-codex-turn-')
    const hook: AgentStatusIpcPayload = {
      paneKey: PANE_KEY,
      terminalHandle: TERMINAL_HANDLE,
      agentType: 'codex',
      state: 'done',
      prompt: '',
      connectionId: null,
      receivedAt: Date.now(),
      stateStartedAt: Date.now()
    }
    const { runtime } = createRuntime(db, { getAgentStatusSnapshot: () => [hook] })
    const write = vi.fn((_ptyId: string, _data: string) => true)
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: vi.fn(async () => 'codex')
    })
    mainProcessState.runtime = runtime
    rememberPaneKeyForPty(PTY_ID, PANE_KEY)
    const run = createBoundRun(db, 'Titleless Run')
    await runtime.listTerminals()
    driveSyntheticTitleFromHookStatus({ paneKey: PANE_KEY, payload: hook })
    await vi.advanceTimersByTimeAsync(1_000)
    runtime.onPtyData(PTY_ID, 'next prompt\r', 1)

    hook.state = 'working'
    hook.receivedAt = Date.now()
    driveSyntheticTitleFromHookStatus({ paneKey: PANE_KEY, payload: hook })
    insertDirectRunMessage(db, run.id, 'Worker progress')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    const wait = runtime.waitForTerminal(TERMINAL_HANDLE, {
      condition: 'tui-idle',
      timeoutMs: 8_000
    })
    const settled = wait.then(
      () => 'satisfied',
      (error: Error) => error.message
    )
    // Past the 3 s stale-spinner clear, which only changes what the tab displays.
    for (let second = 1; second <= 8; second += 1) {
      runtime.onPtyData(PTY_ID, `\r• Working (${second}s • esc to interrupt)`, 1 + second)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    await expect(settled).resolves.toBe('timeout')
    expect(write).not.toHaveBeenCalled()
    db.close()
  })
})
