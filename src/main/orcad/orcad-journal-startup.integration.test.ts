import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Store } from '../persistence/loading-store/store'
import {
  emptyTerminalSessionProfile,
  openTopologyStore
} from '../persistence/terminal-topology/terminal-topology-profile-fixture'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { main, startOrcad } from './orcad-entry'
import type { OrcadHandle } from './orcad-start-contract'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { NO_STRUCTURED_AGENTS } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { readJournalRestFacts } from '../native-chat/agent-session-journal/journal-row-table'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import {
  setStructuredAgentSessionHost,
  setStructuredJournalReadiness,
  structuredJournalBackgroundReady
} from '../native-chat/agent-session-wire/structured-agent-session-registry'

const state = vi.hoisted(() => {
  const value: {
    root: string
    store: Store | null
    finishPublication: ReturnType<typeof Promise.withResolvers<void>>
    healthError: Error | null
  } = { root: '', store: null, finishPublication: Promise.withResolvers<void>(), healthError: null }
  return value
})

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
// Host hook installation writes global agent configs; startup readiness needs no external agents.
vi.mock('./orcad-managed-agent-hooks', () => ({ startOrcadManagedAgentHooks: () => {} }))
vi.mock('./orcad-app-paths', () => ({
  resolveOrcadInstallRoot: () => state.root,
  resolveOrcadPath: () => state.root,
  resolveUserDataPath: () => state.root
}))
vi.mock('./orcad-plaintext-credential-migration', () => ({
  orcadCredentialRoot: () => state.root,
  migratePlaintextCredentials: () => ({ sealed: 0, failed: 0 })
}))
vi.mock('./orcad-account-services', () => ({ createOrcadAccountServices: () => null }))
vi.mock('./orcad-browser-provider', () => ({ resolveOrcadBrowserProvider: async () => null }))
vi.mock('./orcad-instance-lock', () => ({
  acquireOrcadInstanceLock: () => ({
    path: join(state.root, 'orcad.lock'),
    record: { pid: process.pid, startedAtMs: null, nonce: 'repair-instance' },
    release() {}
  })
}))
vi.mock('./orcad-daemon-supervision', () => ({
  startOrcadDaemon: async () => {},
  stopOrcadDaemon: async () => {}
}))
vi.mock('./orcad-health', () => ({
  collectOrcadHealth: async () => {
    if (state.healthError) {
      throw state.healthError
    }
    return {}
  }
}))
vi.mock('./orcad-automations', () => ({
  startOrcadAutomations: () => {},
  stopOrcadAutomationScheduler: () => {},
  orcadAutomationsKeepHostBusy: () => false
}))
vi.mock('../runtime/agent-state-rules/agent-state-rules-live-update', () => ({
  startAgentStateRulesLiveUpdates: () => {}
}))
vi.mock('../daemon/daemon-provider-state', () => ({ daemonOwnsFreshPersistentPtys: () => false }))
vi.mock('../ipc/pty/register-headless-runtime', () => ({
  registerHeadlessPtyRuntime: async () => {}
}))
vi.mock('../ipc/pty/provider/registry', () => ({ getLocalPtyProvider: () => null }))
vi.mock('./orcad-profile-state-startup', () => ({
  createOrcadProfileStateStartup: async () => ({
    store: state.store,
    authority: {
      backend: 'sqlite',
      classification: 'neither',
      authority_mode: 'sqlite-candidate',
      runtime: 'orcad',
      migrated: false
    }
  })
}))
vi.mock('../orca-profiles/profile-index-store', () => ({
  initOrcaProfilePaths() {},
  ensureActiveOrcaProfile: () => ({
    dataFile: join(state.root, 'profile.json'),
    stateDatabaseFile: join(state.root, 'profile-state.db'),
    profile: { id: 'repair-profile' }
  })
}))
vi.mock('../ssh/ssh-host-key-store', () => ({ initSshHostKeyStoreFile() {} }))
vi.mock('../server/serve-readiness', () => ({
  ServeReadinessPublisher: class {
    async publish() {
      await state.finishPublication.promise
    }
  }
}))
vi.mock('../runtime/push/desktop-push-service', () => ({
  DesktopPushService: { create: () => null }
}))

vi.mock('./orcad-session-search', () => ({ installOrcadSessionSearchService: async () => null }))
vi.mock('../native-chat/agent-session-journal/journal-legacy-rest-worker', async () => {
  const { InProcessLegacyRestWorker } =
    await import('../native-chat/agent-session-journal/journal-legacy-rest-replay-test-support')
  return { JournalLegacyRestWorker: InProcessLegacyRestWorker }
})

const SESSION = 'legacy-interrupted'
const NOW = 1_800_000_000_000
let host: StructuredAgentSessionHost
let server: OrcadHandle | undefined
let releaseRpc: ReturnType<typeof Promise.withResolvers<void>>
let rpcEntered: ReturnType<typeof Promise.withResolvers<void>>

beforeEach(async () => {
  vi.stubEnv('ORCA_USER_DATA_PATH', '')
  state.root = mkdtempSync(join(tmpdir(), 'orcad-journal-startup-'))
  state.store = await openTopologyStore(state.root, emptyTerminalSessionProfile())
  state.healthError = null
  state.finishPublication = Promise.withResolvers<void>()
  state.finishPublication.resolve()
  setStructuredJournalReadiness(() => false)
  const record = agentSessionRecordFixture({ sessionId: SESSION })
  await seedTestAgentSessionRecordStore(state.root, { records: [record] })
  const database = openTestJournalHostDatabase(state.root)
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: record.location.workspaceId,
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('provider', null)
    },
    database,
    now: () => NOW
  })
  await journal.appendSubmission({
    clientMessageId: 'sent',
    payloadFingerprint: '0'.repeat(64),
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'unfinished prompt' }] },
    fence: 1
  })
  await journal.appendItem(
    { provider: 'claude', sessionId: 'provider', uuid: 'turn' },
    { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: NOW, userItemId: 'orca:sent' },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.close()
  database.db
    .prepare(
      'UPDATE journal_sessions SET open_turn_id = NULL, open_turn_since = NULL WHERE session_id = ?'
    )
    .run(SESSION)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store: await openTestAgentSessionRecordStore(state.root),
    journalDatabase: database,
    adapter: {
      open: async () => ({ reportedOptions: { model: '' } }),
      acquire: vi.fn(),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      supportsCreate: () => true
    },
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn',
    now: () => NOW + 60_000
  })
  setStructuredAgentSessionHost(host)
  await host.restoreReadableSessions([SESSION])
  vi.spyOn(
    OrcaRuntimeService.prototype,
    'refreshRestoredOrchestrationAuthority'
  ).mockResolvedValue()
  vi.spyOn(OrcaRuntimeService.prototype, 'reconcileLegacyWorkerTerminals').mockResolvedValue({
    adoptedDispatchIds: [],
    exitedDispatchIds: [],
    deferredDispatchIds: []
  })
  vi.spyOn(
    OrcaRuntimeService.prototype,
    'installPendingOrcadMigrationShellHistory'
  ).mockResolvedValue()
  releaseRpc = Promise.withResolvers<void>()
  rpcEntered = Promise.withResolvers<void>()
  const start = OrcaRuntimeRpcServer.prototype.start
  vi.spyOn(OrcaRuntimeRpcServer.prototype, 'start').mockImplementation(async function (
    this: OrcaRuntimeRpcServer
  ) {
    rpcEntered.resolve()
    await releaseRpc.promise
    await start.call(this)
  })
})

afterEach(async () => {
  releaseRpc.resolve()
  state.finishPublication.resolve()
  await server?.stop()
  server = undefined
  setStructuredAgentSessionHost(null)
  setStructuredJournalReadiness(() => false)
  await host.flushAllStreamedEvents()
  await state.store?.freezeWritesAsync()
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(state.root, { recursive: true, force: true })
})

function restFacts() {
  return readJournalRestFacts(host.deps.journalDatabase.db, SESSION)
}

it('classifies legacy chats after standalone startup completes and closes the gate before RPC teardown', async () => {
  state.finishPublication = Promise.withResolvers<void>()
  const opening = vi.spyOn(AgentSessionJournal.prototype, 'open')
  const publish = vi.spyOn(OrcaRuntimeService.prototype, 'syncWindowGraph')
  const startup = startOrcad({ noPairing: true, json: true, port: 0, bind: '127.0.0.1' })
  await rpcEntered.promise
  expect(publish).toHaveBeenCalled()
  expect(structuredJournalBackgroundReady()).toBe(false)
  expect(restFacts()?.known).toBe(false)
  releaseRpc.resolve()
  await vi.waitFor(() => expect(OrcaRuntimeRpcServer.prototype.start).toHaveResolved())
  expect(structuredJournalBackgroundReady()).toBe(false)
  expect(restFacts()?.known).toBe(false)
  state.finishPublication.resolve()
  server = await startup
  expect(structuredJournalBackgroundReady()).toBe(true)
  await vi.waitFor(() => expect(restFacts()?.openTurn?.since).toBe(NOW))
  expect(host.readStatusSummary(SESSION)).toMatchObject({
    restoredInterruption: true,
    turnOutcome: 'cancellation'
  })
  expect(opening).not.toHaveBeenCalled()
  const stop = OrcaRuntimeRpcServer.prototype.stop
  vi.spyOn(OrcaRuntimeRpcServer.prototype, 'stop').mockImplementation(async function (
    this: OrcaRuntimeRpcServer
  ) {
    expect(structuredJournalBackgroundReady()).toBe(false)
    await stop.call(this)
  })
  await server.stop()
  expect(structuredJournalBackgroundReady()).toBe(false)
})

it.each(['rpc', 'health'])(
  'keeps legacy classification gated when %s initialization fails',
  async (failure) => {
    const error = new Error(`${failure} startup failed`)
    if (failure === 'rpc') {
      vi.mocked(OrcaRuntimeRpcServer.prototype.start).mockRejectedValueOnce(error)
    } else {
      state.healthError = error
    }
    const startup = startOrcad({ noPairing: true, json: true, port: 0, bind: '127.0.0.1' })
    const rejected = expect(startup).rejects.toBe(error)
    releaseRpc.resolve()
    await rejected
    expect(structuredJournalBackgroundReady()).toBe(false)
    expect(restFacts()?.known).toBe(false)
  }
)

it('does not open classification after shutdown is requested during startup', async () => {
  const shutdown = new AbortController()
  const startup = startOrcad(
    { noPairing: true, json: true, port: 0, bind: '127.0.0.1' },
    shutdown.signal
  )
  await rpcEntered.promise
  shutdown.abort()
  releaseRpc.resolve()
  server = await startup
  expect(structuredJournalBackgroundReady()).toBe(false)
  expect(restFacts()?.known).toBe(false)
  await server.stop()
  expect(structuredJournalBackgroundReady()).toBe(false)
})

it('keeps main startup gated when SIGTERM arrives before RPC initialization completes', async () => {
  let sigterm = (): void => {
    throw new Error('SIGTERM handler not installed')
  }
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    if (event === 'SIGTERM') {
      sigterm = listener
    }
    return process
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: process exit is recorded after teardown; the test worker must survive it.
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  const startup = main(['--no-pairing', '--json', '--port', '0', '--bind', '127.0.0.1'])
  await rpcEntered.promise
  vi.useFakeTimers()
  try {
    sigterm()
  } finally {
    vi.useRealTimers()
  }
  releaseRpc.resolve()
  await startup
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
  expect(structuredJournalBackgroundReady()).toBe(false)
  expect(restFacts()?.known).toBe(false)
})
