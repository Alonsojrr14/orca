import { lookupGitHubWorkItemByOwnerRepoForSource } from '@/lib/github-work-item-source-lookup'
import type { GitHubIssueOrPRLink } from '../../../../shared/github/links'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { Repo } from '../../../../shared/repo-types'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { buildTaskSourceContextFromRepo } from '../../../../shared/task-source-context'

const FRESH_MS = 60_000
const MAX_ENTRIES = 200

type Entry = {
  promise: Promise<GitHubWorkItem | null>
  settledAt: number | null
  value?: GitHubWorkItem
}
const previews = new Map<string, Entry>()

function previewKey(repo: Repo, link: GitHubIssueOrPRLink): string {
  return `${repo.id}:${githubRepoIdentityKey(link.slug)}#${link.number}:${link.type}`
}

async function lookup(
  repo: Repo,
  link: GitHubIssueOrPRLink,
  type: 'issue' | 'pr'
): Promise<GitHubWorkItem | null> {
  return lookupGitHubWorkItemByOwnerRepoForSource({
    repoPath: repo.path,
    repoId: repo.id,
    sourceContext: buildTaskSourceContextFromRepo({
      provider: 'github',
      projectId: repo.id,
      repo
    }),
    owner: link.slug.owner,
    repo: link.slug.repo,
    host: link.slug.host,
    number: link.number,
    type,
    preview: true
  })
}

async function fetchPreview(repo: Repo, link: GitHubIssueOrPRLink): Promise<GitHubWorkItem | null> {
  const item = await lookup(repo, link, link.type)
  // Hosts without the preview lookup answer null for a PR asked for as an issue (bare #N links).
  return item || link.type !== 'issue' ? item : lookup(repo, link, 'pr')
}

/** Lets a reopened card paint its last answer without a loading frame. */
export function readCachedGitHubLinkPreview(
  repo: Repo,
  link: GitHubIssueOrPRLink
): GitHubWorkItem | null {
  return previews.get(previewKey(repo, link))?.value ?? null
}

/** One request per link at a time; successes stay fresh for a minute, failures retry on the next open. */
export function loadGitHubLinkPreview(
  repo: Repo,
  link: GitHubIssueOrPRLink
): Promise<GitHubWorkItem | null> {
  const key = previewKey(repo, link)
  const cached = previews.get(key)
  if (cached && (cached.settledAt === null || Date.now() - cached.settledAt < FRESH_MS)) {
    return cached.promise
  }
  const entry: Entry = { promise: Promise.resolve(null), settledAt: null }
  const forget = (): void => {
    if (previews.get(key) === entry) {
      previews.delete(key)
    }
  }
  entry.promise = fetchPreview(repo, link).then(
    (item) => {
      if (item) {
        entry.settledAt = Date.now()
        entry.value = item
      } else {
        forget()
      }
      return item
    },
    (error: unknown) => {
      forget()
      throw error
    }
  )
  previews.delete(key)
  previews.set(key, entry)
  if (previews.size > MAX_ENTRIES) {
    const oldest = previews.keys().next().value
    if (oldest !== undefined) {
      previews.delete(oldest)
    }
  }
  return entry.promise
}
