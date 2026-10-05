import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import {
  applyRemoteRequestHeaders,
  attachRemoteRequestHeaderListener,
  collectRemoteHeaderSources,
  createGatewayRendererPredicate,
  createRegistryGatewayWsUrlHandler,
  createRemoteWsHeaderStore,
  oauthLoginLoadUrlOptions,
  type RegistryGatewayWsConnection,
  type RemoteRequestDetails,
  resolveRemoteRequestHeaders
} from './remote-ws-headers'

const accessHeaders = {
  'CF-Access-Client-Id': 'client-id',
  'CF-Access-Client-Secret': 'client-secret'
}

const rendererUrl = 'http://127.0.0.1:47891/'

function rendererFrame(url = rendererUrl, parent: object | null = null) {
  return { url, parent, detached: false, isDestroyed: () => false }
}

function rendererContents(id: number, type: ReturnType<WebContents['getType']> = 'window', url = rendererUrl) {
  return { id, getType: () => type, isDestroyed: () => false, mainFrame: rendererFrame(url) }
}

function createRendererHarness() {
  const ownedWebContents = new WeakSet<object>()
  const contentsById = new Map<number, ReturnType<typeof rendererContents>>()
  const main = rendererContents(1)
  const secondary = rendererContents(2, 'window', `${rendererUrl}?win=secondary#/session`)

  for (const contents of [main, secondary]) {
    ownedWebContents.add(contents)
    contentsById.set(contents.id, contents)
  }

  const dependencies = {
    rendererBaseUrl: () => rendererUrl,
    ownedWebContents,
    webContentsFromId: (id: number) => contentsById.get(id)
  }

  const isAppRenderer = createGatewayRendererPredicate(dependencies)

  return { contentsById, isAppRenderer, main, ownedWebContents, secondary }
}

function rendererRequest(contents: ReturnType<typeof rendererContents>) {
  return {
    url: 'wss://gateway.example/api/ws?ticket=fresh',
    resourceType: 'webSocket',
    frame: contents.mainFrame,
    webContents: contents,
    webContentsId: contents.id,
    requestHeaders: { Origin: rendererUrl }
  }
}

function createHarness(connection: RegistryGatewayWsConnection) {
  const store = createRemoteWsHeaderStore()
  const ensureBackend = vi.fn(async () => connection)
  const mintTicket = vi.fn(async () => 'fresh-ticket')

  const handler = createRegistryGatewayWsUrlHandler({
    ensureBackend,
    mintTicket,
    buildTicketUrl: baseUrl => `${baseUrl.replace(/^https:/, 'wss:')}/api/ws?region=us&ticket=fresh-ticket&profile=old`,
    rememberHeaders: store.remember
  })

  return { ensureBackend, handler, mintTicket, store }
}

function expectRequestHeaders(
  store: ReturnType<typeof createRemoteWsHeaderStore>,
  url: string,
  expected: Record<string, string> | undefined
) {
  const callback = vi.fn()

  applyRemoteRequestHeaders({ url, requestHeaders: { Origin: 'app://hermes' } }, callback, store.headersFor)

  expect(callback).toHaveBeenCalledOnce()
  expect(callback).toHaveBeenCalledWith(expected ? { requestHeaders: { Origin: 'app://hermes', ...expected } } : {})
}

function expectNoHeadersForNearbyUrls(store: ReturnType<typeof createRemoteWsHeaderStore>, exactUrl: string) {
  const exact = new URL(exactUrl)
  const unscoped = new URL(exact)
  unscoped.searchParams.delete('profile')
  const sibling = new URL(exact)
  sibling.pathname = '/api/ws/sibling'
  const otherProfile = new URL(exact)
  otherProfile.searchParams.set('profile', 'analysis')
  const otherCredential = new URL(exact)

  if (otherCredential.searchParams.has('ticket')) {
    otherCredential.searchParams.set('ticket', 'other-ticket')
  } else {
    otherCredential.searchParams.set('token', 'other-token')
  }

  const reordered = new URL(exact)
  const entries = [...reordered.searchParams.entries()].reverse()
  reordered.search = ''

  for (const [name, value] of entries) {
    reordered.searchParams.append(name, value)
  }

  for (const url of [unscoped, sibling, otherProfile, otherCredential, reordered]) {
    expect(store.headersFor(url.toString())).toEqual({})
    expectRequestHeaders(store, url.toString(), undefined)
  }
}

describe('registry gateway WebSocket headers', () => {
  it('evicts the least recently accessed exact URL', () => {
    const store = createRemoteWsHeaderStore(2)
    const firstUrl = 'wss://gateway.example/api/ws?token=first&profile=research'
    const secondUrl = 'wss://gateway.example/api/ws?token=second&profile=research'
    const thirdUrl = 'wss://gateway.example/api/ws?token=third&profile=research'

    store.remember(firstUrl, accessHeaders)
    store.remember(secondUrl, accessHeaders)
    expect(store.headersFor('wss://gateway.example/api/ws?token=missing&profile=research')).toEqual({})
    expect(store.headersFor(firstUrl)).toEqual(accessHeaders)

    store.remember(thirdUrl, accessHeaders)

    expect(store.headersFor(firstUrl)).toEqual(accessHeaders)
    expect(store.headersFor(secondUrl)).toEqual({})
    expect(store.headersFor(thirdUrl)).toEqual(accessHeaders)
  })

  it('updates headers without changing insertion recency', () => {
    const store = createRemoteWsHeaderStore(2)
    const firstUrl = 'wss://gateway.example/api/ws?token=first'
    const secondUrl = 'wss://gateway.example/api/ws?token=second'
    const thirdUrl = 'wss://gateway.example/api/ws?token=third'

    store.remember(firstUrl, { 'CF-Access-Client-Id': 'old-client-id' })
    store.remember(secondUrl, accessHeaders)
    store.remember(firstUrl, { 'CF-Access-Client-Id': 'updated-client-id' })
    store.remember(thirdUrl, accessHeaders)

    expect(store.headersFor(firstUrl)).toEqual({})
    expect(store.headersFor(secondUrl)).toEqual(accessHeaders)
    expect(store.headersFor(thirdUrl)).toEqual(accessHeaders)
  })

  it('token path binds headers to the exact profile scoped URL', async () => {
    const { ensureBackend, handler, mintTicket, store } = createHarness({
      authMode: 'token',
      baseUrl: 'https://gateway.example',
      wsUrl: 'wss://gateway.example/api/ws?token=secret&trace=one&profile=old',
      headers: accessHeaders,
      profile: 'research',
      sharedRemote: true
    })

    const result = await handler({ connectionId: 'remote-one', profile: 'research' })
    const expectedUrl = 'wss://gateway.example/api/ws?token=secret&trace=one&profile=research'

    expect(result).toBe(expectedUrl)
    expect(ensureBackend).toHaveBeenCalledWith('remote-one', 'research')
    expect(mintTicket).not.toHaveBeenCalled()
    expect(store.headersFor(result)).toEqual(accessHeaders)
    expectRequestHeaders(store, result, accessHeaders)
    expectNoHeadersForNearbyUrls(store, result)
  })

  it('OAuth path binds headers to the exact fresh profile scoped URL', async () => {
    const { handler, mintTicket, store } = createHarness({
      authMode: 'oauth',
      baseUrl: 'https://gateway.example',
      wsUrl: 'wss://gateway.example/api/ws?ticket=stale',
      headers: accessHeaders,
      profile: 'research',
      sharedRemote: true
    })

    const result = await handler({ connectionId: 'cloud-one', profile: 'research' })
    const expectedUrl = 'wss://gateway.example/api/ws?region=us&ticket=fresh-ticket&profile=research'

    expect(result).toBe(expectedUrl)
    expect(mintTicket).toHaveBeenCalledOnce()
    expect(mintTicket).toHaveBeenCalledWith('https://gateway.example', accessHeaders)
    expect(store.headersFor(result)).toEqual(accessHeaders)
    expectRequestHeaders(store, result, accessHeaders)
    expectNoHeadersForNearbyUrls(store, result)
  })

  it('sharedRemote false preserves the original URL and exact header behavior', async () => {
    const { handler, store } = createHarness({
      authMode: 'token',
      baseUrl: 'https://gateway.example',
      wsUrl: 'wss://gateway.example/api/ws?trace=one&token=secret',
      headers: accessHeaders,
      profile: 'research',
      sharedRemote: false
    })

    const result = await handler({ connectionId: 'remote-one', profile: 'research' })

    expect(result).toBe('wss://gateway.example/api/ws?trace=one&token=secret')
    expect(store.headersFor(result)).toEqual(accessHeaders)
    expectRequestHeaders(store, result, accessHeaders)
    expect(store.headersFor('wss://gateway.example/api/ws?token=secret&trace=one')).toEqual({})
  })
})

describe('desktop renderer gateway Origin', () => {
  it('recognizes the registered main and secondary app windows directly', () => {
    const { isAppRenderer, main, secondary } = createRendererHarness()

    expect(isAppRenderer(rendererRequest(main))).toBe(true)
    expect(isAppRenderer(rendererRequest(secondary))).toBe(true)
  })

  it('does not stamp an unregistered WebContents with the exact renderer URL', () => {
    const { contentsById, isAppRenderer } = createRendererHarness()
    const foreign = rendererContents(3)
    contentsById.set(foreign.id, foreign)
    const details = rendererRequest(foreign)
    const store = createRemoteWsHeaderStore()
    store.remember(details.url)
    const callback = vi.fn()

    applyRemoteRequestHeaders(details, callback, store.headersFor, { isGatewayUrl: store.hasUrl, isAppRenderer })

    expect(callback).toHaveBeenCalledWith({})
    expect(isAppRenderer(details)).toBe(false)
  })

  it('does not stamp a renderer-URL iframe under a foreign parent in a registered window', () => {
    const { isAppRenderer, main } = createRendererHarness()
    main.mainFrame = rendererFrame('https://external.example/')
    const details = { ...rendererRequest(main), frame: rendererFrame(rendererUrl, main.mainFrame) }
    const store = createRemoteWsHeaderStore()
    store.remember(details.url)
    const callback = vi.fn()

    applyRemoteRequestHeaders(details, callback, store.headersFor, { isGatewayUrl: store.hasUrl, isAppRenderer })

    expect(callback).toHaveBeenCalledWith({})
    expect(isAppRenderer(details)).toBe(false)
  })

  it.each<[
    string,
    (details: RemoteRequestDetails, harness: ReturnType<typeof createRendererHarness>) => void
  ]>([
    ['missing owner', details => Object.assign(details, { webContents: undefined, webContentsId: undefined })],
    ['unknown owner id', details => Object.assign(details, { webContents: undefined, webContentsId: 99 })],
    ['conflicting owner id', (details, { secondary }) => { details.webContentsId = secondary.id }],
    ['incorrect id resolution', (details, { contentsById, main }) => {
      Object.assign(details, { webContents: undefined, webContentsId: 99 })
      contentsById.set(99, main)
    }],
    ['destroyed owner', (_details, { main }) => { main.isDestroyed = () => true }],
    ['webview owner', (_details, { main }) => { main.getType = () => 'webview' }],
    ['browserView owner', (_details, { main }) => { main.getType = () => 'browserView' }],
    ['missing frame', details => { details.frame = undefined }],
    ['null frame', details => { details.frame = null }],
    ['destroyed frame', (_details, { main }) => { main.mainFrame.isDestroyed = () => true }],
    ['detached frame', (_details, { main }) => { main.mainFrame.detached = true }],
    ['previous main frame', (_details, { main }) => { main.mainFrame = rendererFrame() }],
    ['app-parent iframe', (details, { main }) => { details.frame = rendererFrame(rendererUrl, main.mainFrame) }],
    ['foreign current URL', (_details, { main }) => { main.mainFrame.url = 'https://external.example/' }],
    ['non-WebSocket request', details => { details.resourceType = 'xhr' }],
    ['throwing frame URL', (_details, { main }) => {
      Object.defineProperty(main.mainFrame, 'url', {
        get: () => {
          throw new Error('Frame navigated')
        }
      })
    }]
  ])('rejects %s directly and leaves its Origin unstamped', (_scenario, invalidate) => {
    const harness = createRendererHarness()
    const { isAppRenderer, main } = harness
    const details: RemoteRequestDetails = rendererRequest(main)
    invalidate(details, harness)

    const store = createRemoteWsHeaderStore()
    store.remember(details.url)
    const callback = vi.fn()

    expect(isAppRenderer(details)).toBe(false)
    applyRemoteRequestHeaders(details, callback, store.headersFor, { isGatewayUrl: store.hasUrl, isAppRenderer })
    expect(callback).toHaveBeenCalledWith({})
  })

  it('resolves an id-only event to its registered owner and accepts an owner-only event', () => {
    const { isAppRenderer, main, secondary } = createRendererHarness()

    expect(isAppRenderer({ ...rendererRequest(main), webContents: undefined })).toBe(true)
    expect(isAppRenderer({ ...rendererRequest(secondary), webContentsId: undefined })).toBe(true)
  })

  it('stamps the gateway origin only for an exact admitted URL from the app renderer', () => {
    const { isAppRenderer, main } = createRendererHarness()
    const store = createRemoteWsHeaderStore()
    const url = 'ws://10.0.0.12:9120/api/ws?ticket=fresh&profile=default'
    store.remember(url)
    const callback = vi.fn()

    applyRemoteRequestHeaders(
      {
        ...rendererRequest(main),
        url,
        requestHeaders: { origin: 'http://127.0.0.1:47891', 'Sec-WebSocket-Version': '13' }
      },
      callback,
      store.headersFor,
      { isGatewayUrl: store.hasUrl, isAppRenderer }
    )

    expect(callback).toHaveBeenCalledWith({
      requestHeaders: { Origin: 'http://10.0.0.12:9120', 'Sec-WebSocket-Version': '13' }
    })
  })

  it('does not stamp unadmitted URLs or even admitted HTTP and malformed URLs', () => {
    const { isAppRenderer, main } = createRendererHarness()
    const store = createRemoteWsHeaderStore()
    const url = 'wss://gateway.example/api/ws?ticket=fresh'
    store.remember(url)
    store.remember('https://gateway.example/api/status')
    store.remember('not a url')

    for (const target of [`${url}&profile=other`, 'https://gateway.example/api/status', 'not a url']) {
      const callback = vi.fn()
      applyRemoteRequestHeaders(
        { ...rendererRequest(main), url: target, requestHeaders: { Origin: 'https://external.example' } },
        callback,
        store.headersFor,
        { isGatewayUrl: store.hasUrl, isAppRenderer }
      )
      expect(callback).toHaveBeenCalledWith({})
    }
  })

  it('preserves extra headers and uses HTTPS for WSS without duplicate Origin headers', () => {
    const { isAppRenderer, secondary } = createRendererHarness()
    const store = createRemoteWsHeaderStore()
    const url = 'wss://gateway.example:9443/team/api/ws?ticket=fresh'
    store.remember(url, accessHeaders)
    const callback = vi.fn()
    applyRemoteRequestHeaders(
      {
        ...rendererRequest(secondary),
        url,
        requestHeaders: { ORIGIN: 'null', origin: 'http://localhost:5174', Cookie: 'session=test' }
      },
      callback,
      store.headersFor,
      { isGatewayUrl: store.hasUrl, isAppRenderer }
    )
    expect(callback).toHaveBeenCalledWith({
      requestHeaders: { ...accessHeaders, Cookie: 'session=test', Origin: 'https://gateway.example:9443' }
    })
  })

  it('evicts headerless admitted URLs instead of authorizing them forever', () => {
    const store = createRemoteWsHeaderStore(1)
    store.remember('ws://gateway.example/api/ws?ticket=old')
    store.remember('ws://gateway.example/api/ws?ticket=new')
    expect(store.hasUrl('ws://gateway.example/api/ws?ticket=old')).toBe(false)
    expect(store.hasUrl('ws://gateway.example/api/ws?ticket=new')).toBe(true)
  })
})

describe('OAuth login and registry extra headers', () => {
  it('applies Connections extra headers to /login, not only an exact WebSocket URL', () => {
    const sources = collectRemoteHeaderSources({
      connections: [{ kind: 'local' }, { kind: 'remote', url: 'https://gateway.example', headers: accessHeaders }],
      v1Remote: { url: 'https://other.example', headers: { 'CF-Access-Client-Id': 'v1-only' } }
    })

    expect(resolveRemoteRequestHeaders('https://gateway.example/login', { sources })).toEqual(accessHeaders)
    expect(resolveRemoteRequestHeaders('https://gateway.example/api/status', { sources })).toEqual(accessHeaders)
    expect(oauthLoginLoadUrlOptions(accessHeaders)).toEqual({
      extraHeaders: 'CF-Access-Client-Id: client-id\nCF-Access-Client-Secret: client-secret'
    })
    expect(resolveRemoteRequestHeaders('https://other.example/login', { sources })).toEqual({
      'CF-Access-Client-Id': 'v1-only'
    })
  })

  it('injects extra headers on an OAuth partition session, not only defaultSession', () => {
    const listeners = []

    const oauthSession = {
      webRequest: {
        onBeforeSendHeaders: listener => {
          listeners.push(listener)
        }
      }
    }

    const sources = collectRemoteHeaderSources({
      connections: [{ kind: 'remote', url: 'https://gateway.example', headers: accessHeaders }]
    })

    attachRemoteRequestHeaderListener(oauthSession, url => resolveRemoteRequestHeaders(url, { sources }))

    const callback = vi.fn()
    listeners[0]({ url: 'https://gateway.example/login', requestHeaders: { Origin: 'app://hermes' } }, callback)

    expect(listeners).toHaveLength(1)
    expect(callback).toHaveBeenCalledWith({
      requestHeaders: { Origin: 'app://hermes', ...accessHeaders }
    })
  })
})
