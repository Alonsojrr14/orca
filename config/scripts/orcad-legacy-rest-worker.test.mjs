import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  ORCAD_CHILD_ENTRY_POINTS,
  buildOrcadChild,
  orcadChildOutputFilename
} from './orcad-entry-build.mjs'
import {
  orcadArtifactFilenames,
  orcadTemplateCommonFilenames
} from '../../src/shared/orcad-artifacts.ts'
import { SERVER_TARGETS } from '../../src/shared/node-runtime-pin.ts'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../src/shared/agent-session-journal-types.ts'
import { agentJournalItemKey } from '../../src/shared/agent-session-journal-item-key.ts'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../src/main/native-chat/agent-session-journal/journal-host-database-test-support.ts'
import { openAgentSessionJournal } from '../../src/main/native-chat/agent-session-journal/journal-store-factory.ts'
import { LegacyRestSourceOwner } from '../../src/main/native-chat/agent-session-journal/journal-legacy-rest-source.ts'

const root = resolve(import.meta.dirname, '../..')
const directories = []
afterEach(async () => {
  closeTestJournalHostDatabases()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

it('classifies a legacy chat through the worker built and deployed beside the packaged server', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-packaged-legacy-rest-'))
  directories.push(directory)
  const built = join(directory, 'built')
  const deployed = join(directory, 'deployed # 100%')
  await mkdir(built)
  await mkdir(deployed)
  const filename = 'journal-legacy-rest-worker-entry.js'
  const entryPoint = Object.values(ORCAD_CHILD_ENTRY_POINTS).find(
    (entry) => orcadChildOutputFilename(entry) === filename
  )
  expect(entryPoint, 'legacy classifier must be built as an orcad child').toBeDefined()
  await buildOrcadChild(join(root, entryPoint), join(built, filename))
  // Deploy through the template inventory; an unlisted build output must stay behind.
  for (const artifact of orcadTemplateCommonFilenames([]).filter((file) => file === filename)) {
    await copyFile(join(built, artifact), join(deployed, artifact))
  }
  for (const target of SERVER_TARGETS) {
    expect(orcadArtifactFilenames(target, [])).toContain(filename)
  }
  const client = join(deployed, 'legacy-client.cjs')
  await buildOrcadChild(
    join(root, 'src/main/native-chat/agent-session-journal/journal-legacy-rest-worker.ts'),
    client
  )
  const { JournalLegacyRestWorker } = createRequire(import.meta.url)(client)
  const stateDirectory = join(directory, 'profile')
  const database = openTestJournalHostDatabase(stateDirectory)
  const sessionId = 'legacy-chat'
  const journal = await openAgentSessionJournal({
    database,
    identity: { sessionId, workspaceId: 'folder', hostId: 'remote', agent: 'codex' }
  })
  const identity = { provider: 'codex', threadId: sessionId, turnId: 'turn', ordinal: 0 }
  await journal.appendItem(
    identity,
    { kind: 'turn', turnId: 'turn', state: 'running', startedAt: 123 },
    {
      turnScope: AGENT_JOURNAL_THREAD_SCOPE,
      fence: 1
    }
  )
  await journal.close()
  database.db
    .prepare(
      'UPDATE journal_sessions SET open_turn_id=NULL, open_turn_since=NULL WHERE session_id=?'
    )
    .run(sessionId)
  const source = new LegacyRestSourceOwner({ database, owner: () => 'ended' }).source(sessionId)
  expect(source?.known).toBe(false)
  const worker = new JournalLegacyRestWorker(database, new Int32Array(new SharedArrayBuffer(8)))
  try {
    let response
    for (let grant = 0; grant < 20; grant++) {
      response = await worker.grant({ mode: 'replay', sessionId, source, generation: 0 })
      if (response.status === 'complete' || response.status === 'failed') {
        break
      }
    }
    expect(response).toMatchObject({
      status: 'complete',
      pending: false,
      fact: { itemId: agentJournalItemKey(identity), since: 123 }
    })
  } finally {
    await worker.close()
  }
}, 30_000)
