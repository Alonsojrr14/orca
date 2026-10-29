import { toWindowsWslPath } from '../../shared/wsl-paths'

export type ParsedFileUriPath = {
  path: string
  hostname: string
}

export type ParseFileUriPathOptions = {
  pathFlavor?: 'posix' | 'win32'
  remotePosixAuthority?: boolean
  wslDistro?: string
}

export function parseFileUriPath(
  uri: string,
  options: ParseFileUriPathOptions = {}
): string | null {
  return parseFileUriPathParts(uri, options)?.path ?? null
}

const FILE_URI_AUTHORITY = /^file:\/\/[^/]*/i

/**
 * Some shells (nushell) send `#`, `?` and a lone `%` raw in the path, which a URL parser would cut
 * at or reject. A properly encoded URI never contains them there, so encoding them first leaves its
 * result unchanged. A raw `%41` stays ambiguous and decodes to `A`, as it always has.
 */
function encodeRawPathDelimiters(uri: string): string {
  const authority = FILE_URI_AUTHORITY.exec(uri)
  if (!authority) {
    return uri
  }
  const path = uri
    .slice(authority[0].length)
    .replace(/%(?![0-9A-Fa-f]{2})/g, '%25')
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F')
  return authority[0] + path
}

export function parseFileUriPathParts(
  uri: string,
  options: ParseFileUriPathOptions = {}
): ParsedFileUriPath | null {
  try {
    const url = new URL(encodeRawPathDelimiters(uri))
    if (url.protocol !== 'file:') {
      return null
    }

    const decodedPath = decodeURIComponent(url.pathname)
    const hostname = url.hostname.toLowerCase()
    if (options.wslDistro) {
      return { path: toWindowsWslPath(decodedPath, options.wslDistro), hostname }
    }
    const pathFlavor = options.pathFlavor ?? (process.platform === 'win32' ? 'win32' : 'posix')
    if (pathFlavor !== 'win32') {
      return { path: decodedPath, hostname }
    }

    if (/^\/[A-Za-z]:/.test(decodedPath)) {
      return { path: decodedPath.slice(1), hostname }
    }
    // Local and remote-POSIX authorities keep POSIX paths; other nonlocal Windows authorities become UNC.
    if (hostname && hostname !== 'localhost' && !options.remotePosixAuthority) {
      return { path: `\\\\${url.hostname}${decodedPath.replace(/\//g, '\\')}`, hostname }
    }
    return { path: decodedPath, hostname }
  } catch {
    return null
  }
}
