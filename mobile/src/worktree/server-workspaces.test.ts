import { describe, expect, it, vi } from 'vitest'

// The desktop's server-list feed loads react-native; its timer never runs without a subscriber.
vi.mock('react-native', () => ({}))
import type { MobileRelayHost } from '../../../src/shared/mobile-relay-hosts-contract'
import {
  applyServerWorkspaces,
  NO_SERVER_WORKSPACES,
  serverHostHealthLabel,
  serverHostHealthLabels
} from './server-workspaces'
import { relayHostsListRead } from './server-workspace-operations'
import { applyWorktreeHostContextLabels } from './worktree-host-context-labels'
import type { Worktree } from './workspace-list-types'

const host: MobileRelayHost = {
  hostId: 'runtime:env-1',
  label: 'Box',
  health: 'available',
  relay: 'ready'
}

function row(worktreeId: string): Worktree {
  return {
    worktreeId,
    repoId: 'repo-1',
    hostId: host.hostId,
    repo: 'orca',
    branch: 'main',
    displayName: worktreeId,
    path: `/srv/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}

describe('applyServerWorkspaces', () => {
  it('keeps the same hosts list when only the rows change', () => {
    const first = applyServerWorkspaces(NO_SERVER_WORKSPACES, {
      hosts: [host],
      rows: [[row('a')]]
    })
    const next = applyServerWorkspaces(first, {
      hosts: [{ ...host }],
      rows: [[row('a'), row('b')]]
    })
    expect(next.worktrees.map((worktree) => worktree.worktreeId)).toEqual(['a', 'b'])
    expect(next.hosts).toBe(first.hosts)
    const relabeled = applyServerWorkspaces(next, {
      hosts: [{ ...host, relay: 'unavailable' }],
      rows: [null]
    })
    expect(relabeled.hosts).not.toBe(first.hosts)
    expect(relabeled.worktrees).toEqual(next.worktrees)
    expect(
      applyServerWorkspaces(next, {
        hosts: [{ ...host }],
        rows: [[row('a'), row('b')]]
      })
    ).toBe(next)
  })
})

function listReply(hosts: unknown[]) {
  return relayHostsListRead.interpret({
    id: 'reply',
    ok: true,
    result: { hosts },
    _meta: { runtimeId: 'desktop' }
  })
}

// As the desktop sends a confirmed stop: no status, so 'disconnected', and the marker.
const wslHost: MobileRelayHost = {
  hostId: 'runtime:wsl%3Aubuntu',
  label: 'Ubuntu (WSL)',
  health: 'disconnected',
  relay: 'unavailable',
  stoppedOnDesktop: true
}

describe("the desktop's own WSL host", () => {
  it('reads the marker from a new desktop, and lists an older desktop’s hosts without it', () => {
    const listed = listReply([
      wslHost,
      { ...host, stoppedOnDesktop: 'yes', unavailableOnDesktop: 1 },
      {
        hostId: 'runtime:old',
        label: 'Old',
        health: 'available',
        relay: 'ready'
      }
    ])
    expect(listed.accepted && listed.value).toEqual([
      wslHost,
      { ...host, stoppedOnDesktop: undefined, unavailableOnDesktop: undefined },
      {
        hostId: 'runtime:old',
        label: 'Old',
        health: 'available',
        relay: 'ready'
      }
    ])
  })

  it('says to start it on the computer only for a stop the desktop confirmed', () => {
    expect(serverHostHealthLabel(wslHost)).toBe('Start on computer')
    // Starting, reconnecting or unconfirmed reads exactly like this on the wire: no marker.
    const { stoppedOnDesktop: _marker, ...unconfirmed } = wslHost
    expect(serverHostHealthLabel(unconfirmed)).toBeUndefined()
    expect(serverHostHealthLabels([unconfirmed]).size).toBe(0)
    // Not connected on the computer and not known stopped: say where to open it, not "Connecting".
    expect(
      serverHostHealthLabel({
        ...unconfirmed,
        health: 'connecting',
        unavailableOnDesktop: true
      })
    ).toBe('Open on computer')
    // Any other server keeps its health word.
    expect(serverHostHealthLabel({ ...host, relay: 'unavailable' })).toBeUndefined()
  })

  it("puts the words on that host's rows, over its health", () => {
    const [drawn] = applyWorktreeHostContextLabels([{ ...row('a'), hostId: wslHost.hostId }], {
      repoHostIdByRepoId: new Map(),
      hostLabelById: new Map([[wslHost.hostId, wslHost.label]]),
      hostPlatform: 'win32',
      hostHealthById: new Map([[wslHost.hostId, wslHost.health]]),
      hostHealthLabelById: serverHostHealthLabels([wslHost, host])
    })
    expect(drawn).toMatchObject({
      hostContextLabel: 'Ubuntu (WSL)',
      hostContextHealthLabel: 'Start on computer'
    })
  })

  it('keeps an older desktop’s list as it was: no marker, no WSL host, the health word only', () => {
    const listed = listReply([{ ...host, health: 'disconnected', relay: 'unavailable' }])
    const hosts = listed.accepted ? listed.value : []
    expect(serverHostHealthLabels(hosts).size).toBe(0)
    const [drawn] = applyWorktreeHostContextLabels([row('a')], {
      repoHostIdByRepoId: new Map(),
      hostLabelById: new Map([[host.hostId, host.label]]),
      hostPlatform: 'win32',
      hostHealthById: new Map([[host.hostId, 'disconnected' as const]]),
      hostHealthLabelById: serverHostHealthLabels(hosts)
    })
    expect(drawn.hostContextHealthLabel).toBe('Disconnected')
  })
})
