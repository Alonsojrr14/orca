import { createContext, useMemo, type ReactNode } from 'react'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import {
  useNativeChatImageRuntimeContext,
  type NativeChatImageRuntimeContext
} from './native-chat-image-runtime-context'
import { useNativeChatFileLinkContext } from './use-native-chat-file-link-context'
import { NativeChatGitHubRepoProvider } from './native-chat-github-repo'

export const NativeChatMarkdownImageOwnerContext = createContext<{
  fileLinkContext: NativeChatFileLinkContext | null
  runtimeContext: NativeChatImageRuntimeContext
  isVisible: boolean
  sessionId?: string | null
} | null>(null)

export function NativeChatMarkdownImageOwnerProvider({
  tabId,
  isVisible,
  sessionId,
  children
}: {
  tabId: string
  isVisible: boolean
  sessionId: string | null
  children: ReactNode
}): React.JSX.Element {
  const fileLinkContext = useNativeChatFileLinkContext(tabId)
  const runtimeContext = useNativeChatImageRuntimeContext(tabId)
  const value = useMemo(
    () => ({ fileLinkContext, runtimeContext, isVisible, sessionId }),
    [fileLinkContext, runtimeContext, isVisible, sessionId]
  )
  return (
    <NativeChatMarkdownImageOwnerContext.Provider value={value}>
      <NativeChatGitHubRepoProvider worktreeId={fileLinkContext?.worktreeId}>
        {children}
      </NativeChatGitHubRepoProvider>
    </NativeChatMarkdownImageOwnerContext.Provider>
  )
}
