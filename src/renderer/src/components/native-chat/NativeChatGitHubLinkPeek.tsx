import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Button } from '@/components/ui/button'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import { GitHubUserAvatar } from '@/components/github/github-user-avatar'
import { WorkItemStateBadge } from '@/components/github/work-item-state-badge'
import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import { DiffLineCounts } from '@/components/right-sidebar/source-control/listing/diff-line-counts'
import { translate } from '@/i18n/i18n'
import { parseGitHubIssueOrPRLink, type GitHubIssueOrPRLink } from '../../../../shared/github/links'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  loadGitHubLinkPreview,
  readCachedGitHubLinkPreview
} from './native-chat-github-link-preview'
import { githubLinkBelongsToRepo, type NativeChatGitHubRepo } from './native-chat-github-repo'

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; item: GitHubWorkItem }
  | { status: 'failed' }

function usePreview(
  repo: Repo,
  link: GitHubIssueOrPRLink
): {
  state: PreviewState
  retry: () => void
} {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<PreviewState>(() => {
    const cached = readCachedGitHubLinkPreview(repo, link)
    return cached ? { status: 'ready', item: cached } : { status: 'loading' }
  })
  useEffect(() => {
    let cancelled = false
    loadGitHubLinkPreview(repo, link).then(
      (item) => !cancelled && setState(item ? { status: 'ready', item } : { status: 'failed' }),
      () => !cancelled && setState({ status: 'failed' })
    )
    return () => {
      cancelled = true
    }
  }, [repo, link, attempt])
  return {
    state,
    retry: () => {
      setState({ status: 'loading' })
      setAttempt((value) => value + 1)
    }
  }
}

function PeekFooter({ item }: { item: GitHubWorkItem }): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {item.author ? (
        <>
          <GitHubUserAvatar
            login={item.author}
            avatarUrl={item.authorAvatarUrl}
            className="size-4"
          />
          <span className="min-w-0 truncate">{item.author}</span>
          <span aria-hidden>·</span>
        </>
      ) : null}
      {item.updatedAt ? (
        <span className="shrink-0">
          {translate('components.native-chat.githubPeek.updated', 'updated {{time}}', {
            time: formatRelativeTime(item.updatedAt)
          })}
        </span>
      ) : null}
      {item.type === 'pr' && (item.additions || item.deletions) ? (
        <>
          <span aria-hidden>·</span>
          <DiffLineCounts added={item.additions} removed={item.deletions} size="sm" />
        </>
      ) : null}
      {item.type === 'issue' && item.commentCount !== undefined ? (
        <>
          <span aria-hidden>·</span>
          <span className="shrink-0">
            {item.commentCount === 1
              ? translate('components.native-chat.githubPeek.oneComment', '1 comment')
              : translate('components.native-chat.githubPeek.comments', '{{count}} comments', {
                  count: item.commentCount
                })}
          </span>
        </>
      ) : null}
    </div>
  )
}

function PeekBody({ repo, link }: { repo: Repo; link: GitHubIssueOrPRLink }): React.JSX.Element {
  const { state, retry } = usePreview(repo, link)
  return (
    <div className="flex flex-col gap-1.5">
      {/* Known from the URL, so the card has a header before the lookup answers. */}
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <GitHubIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">
          {link.slug.owner}/{link.slug.repo}
        </span>
        <span className="shrink-0 font-mono">#{link.number}</span>
        {state.status === 'ready' ? (
          <WorkItemStateBadge
            item={state.item}
            closedIssue="neutral"
            className="ml-auto h-4.5 px-1.5 text-2xs"
          />
        ) : null}
      </div>
      {state.status === 'ready' ? (
        <>
          <div className="line-clamp-2 text-sm font-semibold text-foreground">
            {state.item.title}
          </div>
          {state.item.type === 'issue' && state.item.labels.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {state.item.labels.slice(0, 4).map((label) => (
                <span
                  key={label}
                  className="rounded-full border border-border px-1.5 text-3xs text-muted-foreground"
                >
                  {label}
                </span>
              ))}
            </div>
          ) : null}
          <PeekFooter item={state.item} />
        </>
      ) : state.status === 'loading' ? (
        <div aria-hidden className="flex flex-col gap-1.5 motion-safe:animate-pulse">
          <div className="h-3.5 w-11/12 rounded bg-muted" />
          <div className="h-3.5 w-1/2 rounded bg-muted" />
          <div className="mt-0.5 h-3 w-1/3 rounded bg-muted" />
        </div>
      ) : (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span>
            {translate('components.native-chat.githubPeek.unavailable', 'Preview unavailable.')}
          </span>
          <Button variant="link" size="xs" onClick={retry}>
            {translate('components.native-chat.githubPeek.retry', 'Retry')}
          </Button>
        </div>
      )}
    </div>
  )
}

/** Hover or focus a PR/issue link into the chat's own GitHub repo to see its title, state and author. */
export function NativeChatGitHubLinkPeek({
  githubRepo,
  href,
  children
}: {
  githubRepo: NativeChatGitHubRepo | null
  href: string | undefined
  children: ReactNode
}): ReactNode {
  const [open, setOpen] = useState(false)
  const link = useMemo(() => (href ? parseGitHubIssueOrPRLink(href) : null), [href])
  if (!githubRepo || !link || !githubLinkBelongsToRepo(githubRepo, link.slug)) {
    return children
  }
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={350} closeDelay={120}>
      <HoverCardTrigger asChild>
        {/* A click opens the link (or its action popover); the peek must not sit on top of it. */}
        <span onClickCapture={() => setOpen(false)}>{children}</span>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-96">
        <PeekBody key={href} repo={githubRepo.repo} link={link} />
      </HoverCardContent>
    </HoverCard>
  )
}
