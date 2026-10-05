import type { WebContents, WebFrameMain } from 'electron'

import { remoteRequestMatchesBaseUrl } from './connection-config'
import { withEmbedRefererStamp } from './embed-referer'
import { registryGatewayWsUrl } from './plugin-profile-routes'
import { isRendererUrl } from './renderer-url'

export interface RegistryGatewayWsConnection {
  authMode: string
  baseUrl: string
  wsUrl: string
  headers?: Record<string, string>
  profile?: null | string
  sharedRemote?: boolean
}

interface RegistryGatewayWsUrlDependencies {
  ensureBackend: (connectionId: unknown, profile: unknown) => Promise<RegistryGatewayWsConnection>
  mintTicket: (baseUrl: string, headers?: Record<string, string>) => Promise<string>
  buildTicketUrl: (baseUrl: string, ticket: string) => string
  rememberHeaders: (wsUrl: string, headers?: Record<string, string>) => void
}

export interface GatewayRendererWebContents extends Pick<WebContents, 'id' | 'getType' | 'isDestroyed'> {
  mainFrame: Pick<WebFrameMain, 'url' | 'isDestroyed' | 'detached'>
}

export interface RemoteRequestDetails {
  url: string
  requestHeaders?: Record<string, string>
  resourceType?: string
  frame?: GatewayRendererWebContents['mainFrame'] | null
  webContents?: GatewayRendererWebContents
  webContentsId?: number
}

type RemoteRequestCallback = (result: { requestHeaders?: Record<string, string> }) => void

interface GatewayOriginPolicy {
  isGatewayUrl: (url: string) => boolean
  isAppRenderer: (details: RemoteRequestDetails) => boolean
}

export function createGatewayRendererPredicate(dependencies: {
  rendererBaseUrl: () => string
  ownedWebContents: WeakSet<object>
  webContentsFromId: (id: number) => GatewayRendererWebContents | undefined
}) {
  return (details: RemoteRequestDetails): boolean => {
    try {
      const owner =
        details.webContents ??
        (details.webContentsId === undefined ? undefined : dependencies.webContentsFromId(details.webContentsId))

      const frame = details.frame

      if (
        details.resourceType !== 'webSocket' ||
        !owner ||
        !dependencies.ownedWebContents.has(owner) ||
        owner.isDestroyed() ||
        owner.getType() !== 'window' ||
        (details.webContentsId !== undefined && owner.id !== details.webContentsId)
      ) {
        return false
      }

      // Only the current top-level SPA can originate a native gateway upgrade.
      // Matching the URL of a guest/iframe or an old document is not ownership.
      return Boolean(
        frame &&
        !frame.isDestroyed() &&
        !frame.detached &&
        frame === owner.mainFrame &&
        frame.url &&
        isRendererUrl(frame.url, dependencies.rendererBaseUrl())
      )
    } catch {
      // A destroyed/navigated frame is not proof of app ownership.
      return false
    }
  }
}

export interface RemoteHeaderSource {
  headers?: Record<string, string>
  kind?: string
  url?: string
}

interface SessionLike {
  webRequest?: {
    onBeforeSendHeaders?: (listener: (details: RemoteRequestDetails, callback: RemoteRequestCallback) => void) => void
  }
}

/**
 * Header blocks that Chromium (login window, renderer WS) may attach to a
 * remote gateway request. Registry Connections are the live source; the v1
 * single-remote block is fallback. Longer base URLs win so a path-prefixed
 * gateway is not shadowed by its origin sibling.
 *
 * Values arrive already sanitized: decryptRemoteHeaders in main.ts strips
 * CR/LF on the single decrypt funnel, so there is no second normalizer here.
 */
export function collectRemoteHeaderSources(input: {
  connections?: RemoteHeaderSource[]
  v1Remote?: null | RemoteHeaderSource
}): RemoteHeaderSource[] {
  const sources: RemoteHeaderSource[] = []

  for (const connection of input.connections || []) {
    if (connection.kind && connection.kind !== 'remote' && connection.kind !== 'cloud') {
      continue
    }

    if (!connection.url || !connection.headers || Object.keys(connection.headers).length === 0) {
      continue
    }

    sources.push({ headers: connection.headers, url: connection.url })
  }

  if (input.v1Remote?.url && input.v1Remote.headers && Object.keys(input.v1Remote.headers).length > 0) {
    sources.push({
      headers: input.v1Remote.headers,
      url: input.v1Remote.url
    })
  }

  return sources.sort((a, b) => String(b.url || '').length - String(a.url || '').length)
}

export function resolveRemoteRequestHeaders(
  requestUrl: string,
  options: { exactHeaders?: Record<string, string>; sources?: RemoteHeaderSource[] } = {}
): Record<string, string> {
  const exact = options.exactHeaders || {}

  if (Object.keys(exact).length > 0) {
    return exact
  }

  for (const source of options.sources || []) {
    if (!source.url || !source.headers) {
      continue
    }

    if (Object.keys(source.headers).length > 0 && remoteRequestMatchesBaseUrl(requestUrl, source.url)) {
      return source.headers
    }
  }

  return {}
}

export function formatLoadUrlExtraHeaders(headers: Record<string, string> = {}): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}

export function oauthLoginLoadUrlOptions(headers: Record<string, string> = {}): { extraHeaders?: string } {
  const extraHeaders = formatLoadUrlExtraHeaders(headers)

  return extraHeaders ? { extraHeaders } : {}
}

export function attachRemoteRequestHeaderListener(
  sessionLike: SessionLike,
  headersForRequest: (requestUrl: string) => Record<string, string>,
  gatewayOriginPolicy?: GatewayOriginPolicy
) {
  // The YouTube embed Referer stamp composes onto this same listener: Electron
  // allows a single onBeforeSendHeaders listener per session, so the default
  // session (where chat embeds' iframes live) gets both behaviors here.
  sessionLike?.webRequest?.onBeforeSendHeaders?.(
    withEmbedRefererStamp((details, callback) => {
      applyRemoteRequestHeaders(details, callback, headersForRequest, gatewayOriginPolicy)
    })
  )
}

export function createRemoteWsHeaderStore(limit = 100) {
  const headersByUrl = new Map<string, Record<string, string>>()

  const remember = (wsUrl: string, headers: Record<string, string> = {}) => {
    if (!wsUrl) {
      return
    }

    headersByUrl.set(String(wsUrl), headers)

    while (headersByUrl.size > limit) {
      const oldest = headersByUrl.keys().next().value

      if (!oldest) {
        break
      }

      headersByUrl.delete(oldest)
    }
  }

  const headersFor = (requestUrl: string): Record<string, string> => {
    const key = String(requestUrl)
    const headers = headersByUrl.get(key)

    if (!headers) {
      return {}
    }

    headersByUrl.delete(key)
    headersByUrl.set(key, headers)

    return headers
  }

  return { hasUrl: (url: string) => headersByUrl.has(url), headersFor, remember }
}

export function applyRemoteRequestHeaders(
  details: RemoteRequestDetails,
  callback: RemoteRequestCallback,
  headersForRequest: (requestUrl: string) => Record<string, string>,
  gatewayOriginPolicy?: GatewayOriginPolicy
) {
  const headers = headersForRequest(details.url)
  let origin: string | undefined

  // The packaged SPA now has a loopback HTTP origin. A remote gateway's
  // rebinding guard correctly rejects that origin, even with a valid ticket.
  // Treat only main-admitted, exact gateway URLs from our own renderer as
  // native client upgrades; never relax the server guard or stamp webviews.
  if (gatewayOriginPolicy?.isGatewayUrl(details.url) && gatewayOriginPolicy.isAppRenderer(details)) {
    try {
      const target = new URL(details.url)

      if (target.protocol === 'ws:' || target.protocol === 'wss:') {
        target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
        origin = target.origin
      }
    } catch {
      // Malformed URLs retain their original headers.
    }
  }

  if (Object.keys(headers).length === 0 && !origin) {
    callback({})

    return
  }

  const requestHeaders = { ...details.requestHeaders, ...headers }

  if (origin) {
    for (const name of Object.keys(requestHeaders)) {
      if (name.toLowerCase() === 'origin') {
        delete requestHeaders[name]
      }
    }

    requestHeaders.Origin = origin
  }

  callback({ requestHeaders })
}

export function createRegistryGatewayWsUrlHandler(dependencies: RegistryGatewayWsUrlDependencies) {
  return async (payload: unknown): Promise<string> => {
    const { connectionId, profile } = payload && typeof payload === 'object' ? (payload as any) : ({} as any)
    const connection = await dependencies.ensureBackend(connectionId, profile)
    let wsUrl = connection.wsUrl

    if (connection.authMode === 'oauth') {
      const ticket = await dependencies.mintTicket(connection.baseUrl, connection.headers)
      wsUrl = dependencies.buildTicketUrl(connection.baseUrl, ticket)
    }

    const finalWsUrl = registryGatewayWsUrl(connection, wsUrl)

    dependencies.rememberHeaders(finalWsUrl, connection.headers)

    return finalWsUrl
  }
}
