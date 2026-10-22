// @vitest-environment node
import type { ServerRequest } from '@hermes/shared'
import { expect, test, vi } from 'vitest'

import { canonicalOwnerProfile } from './canonical-protocol'
import { HermesGateway } from './client'

const TITLE = 'Group: retained-room · retained-thread'
const SID = 'retained-session'

interface Frame {
  id: number
  method: string
  params: Record<string, unknown>
}

async function withGateway(run: (fixture: {
  client: HermesGateway
  sent: Frame[]
  event: (params: Record<string, unknown>) => void
  reply: (frame: Frame, result: unknown) => void
  refuse: (frame: Frame) => void
  flush: () => Promise<void>
  reconnect: () => Promise<void>
  connections: () => number
}) => Promise<void>): Promise<void> {
  const wsPackage = 'ws'
  const { WebSocketServer } = await import(wsPackage)
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => server.once('listening', resolve))
  const sent: Frame[] = []
  let connections = 0
  let peer: any
  server.on('connection', (socket: any) => {
    connections++
    peer = socket
    socket.on('message', (bytes: Buffer) => { sent.push(JSON.parse(bytes.toString())) })
  })
  const client = new HermesGateway()
  const event = (params: Record<string, unknown>) => peer.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params }))

  try {
    const address = server.address() as { port: number }
    const url = `ws://127.0.0.1:${address.port}/api/ws?native_dial=fixture&ticket=one-use`
    await client.connect(url)
    await run({
      client, sent, event,
      reply: (frame, result) => peer.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result })),
      refuse: frame => peer.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: {
        code: 4001, message: 'not_found', data: { reason: 'not_found' }
      } })),
      reconnect: () => client.connect(url),
      connections: () => connections,
      // A later global frame proves the real client processed all preceding events before ACK.
      flush: () => new Promise<void>(resolve => {
        const off = client.on('gateway.stderr', () => { off(); resolve() })
        event({ type: 'gateway.stderr', payload: { line: 'fixture checkpoint' } })
      })
    })
  } finally {
    client.close()

    for (const socket of server.clients) { socket.terminate() }
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

function prompt(kind: 'approval' | 'clarify', profile = 'ops', generation = 7) {
  return { kind, prompt_id: `${kind}-${profile}`, execution_generation: generation,
    command: 'build', question: 'Which target?', choices: ['once', 'deny'] }
}

function snapshot(profile: string, prompts: unknown[] = [], generation = 7) {
  return { session_id: SID, stored_session_id: SID, revision: 4, execution_generation: generation,
    replay_epoch: `epoch-${profile}`, messages: [], prompts, info: { profile_name: profile } }
}

test('idempotent connect preserves the open transport\'s authoritative owner proof', async () => {
  await withGateway(async ({ client, sent, event, reply, flush, reconnect, connections }) => {
    const shown: ServerRequest[] = []
    const seen: unknown[] = []
    client.onRequest(request => { shown.push(request) })
    client.on('message.delta', frame => { seen.push([frame.seq, canonicalOwnerProfile(frame)]) })
    const pending = prompt('approval', 'alpha', 3)
    const attached = client.request('session.resume', { session_id: SID, profile: 'alpha' })
    void attached.catch(() => undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    reply(sent[0], snapshot('alpha', [pending], 3))
    await attached
    event({ type: 'message.delta', session_id: SID, replay_epoch: 'epoch-alpha', seq: 1, payload: { text: 'before' } })
    await flush()
    expect(seen).toEqual([[1, 'alpha']])
    expect(shown).toHaveLength(1)

    await reconnect()
    event({ type: 'message.delta', session_id: SID, replay_epoch: 'epoch-alpha', seq: 2, payload: { text: 'after' } })
    await flush()
    expect(connections()).toBe(1)
    expect(client.connectionState).toBe('open')
    expect(seen).toEqual([[1, 'alpha'], [2, 'alpha']])
    expect(sent.map(frame => frame.method)).toEqual(['session.resume'])
    shown[0].respond({ choice: 'once' })
    shown[0].respond({ choice: 'once' })
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]).toMatchObject({ method: 'approval.respond', params: {
      session_id: SID, profile: 'alpha', prompt_id: pending.prompt_id, execution_generation: 3, choice: 'once'
    } })
    reply(sent[1], { status: 'resolved' })
    await flush()
    expect(sent.map(frame => frame.method)).toEqual(['session.resume', 'approval.respond'])
  })
})

test.each([
  ['approval', true], ['clarify', true], ['approval', false], ['clarify', false]
] as const)('pre-ACK title-resume %s waits for its authoritative owner and answers ops exactly once (epoch=%s)', async (kind, epoch) => {
  await withGateway(async ({ client, sent, event, reply, flush }) => {
    const shown: ServerRequest[] = []
    const named: unknown[] = []
    const wildcard: unknown[] = []
    client.onRequest(request => { shown.push(request) })
    client.on(`${kind}.request`, frame => { named.push(canonicalOwnerProfile(frame)) })
    client.onAny(frame => { if (frame.type === `${kind}.request`) { wildcard.push(canonicalOwnerProfile(frame)) } })
    const resumed = client.request('session.resume', { session_id: TITLE, profile: 'ops', omit_messages: true })
    void resumed.catch(() => undefined) // Teardown can close a still-pending ACK after a failed assertion.
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].params).toEqual({ title: TITLE, profile: 'ops', omit_messages: true })
    const pending = prompt(kind)
    event({ type: `${kind}.request`, session_id: SID, ...(epoch ? { replay_epoch: 'epoch-ops' } : {}), payload: pending })
    await flush()
    expect(shown).toHaveLength(0)
    expect(named).toEqual([])
    expect(wildcard).toEqual([])

    reply(sent[0], { ...snapshot('ops', [pending]), ...(epoch ? {} : { replay_epoch: undefined }) })
    await resumed
    await vi.waitFor(() => expect(shown).toHaveLength(1))
    expect(canonicalOwnerProfile(shown[0])).toBe('ops')
    expect(shown[0].params.session_id).toBe(SID)
    expect(named).toEqual(['ops'])
    expect(wildcard).toEqual(['ops'])
    const answer = kind === 'approval' ? { choice: 'once' } : { answer: 'staging' }
    shown[0].respond(answer)
    shown[0].respond(answer)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]).toMatchObject({ method: `${kind}.respond`, params: {
      session_id: SID, profile: 'ops', prompt_id: pending.prompt_id, execution_generation: 7, ...answer
    } })
    reply(sent[1], { status: 'resolved' })
    await flush()
    expect(shown).toHaveLength(1)
    expect(sent.map(frame => frame.method)).toEqual(['session.resume', `${kind}.respond`])
  })
})

test('concurrent title lookups sharing a stored ID route live-only prompts by epoch, never the first ACK', async () => {
  await withGateway(async ({ client, sent, event, reply, flush }) => {
    const shown: ServerRequest[] = []
    const named: string[] = []
    client.onRequest(request => { shown.push(request) })
    client.on('approval.request', frame => { named.push(canonicalOwnerProfile(frame)!) })
    const alpha = client.request('session.resume', { session_id: TITLE, profile: 'alpha', omit_messages: true })
    const beta = client.request('session.resume', { session_id: TITLE, profile: 'beta', omit_messages: true })
    void alpha.catch(() => undefined)
    void beta.catch(() => undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    const alphaPrompt = prompt('approval', 'alpha', 3)
    const betaPrompt = prompt('approval', 'beta', 9)

    for (const pending of [betaPrompt, alphaPrompt]) {
      event({ type: 'approval.request', session_id: SID, replay_epoch: `epoch-${pending === betaPrompt ? 'beta' : 'alpha'}`, payload: pending })
    }

    await flush()
    expect(shown).toEqual([])
    // The snapshot can predate the event: neither ACK contains its live-only prompt.
    reply(sent[0], snapshot('alpha', [], 3))
    await alpha
    expect(shown.map(canonicalOwnerProfile)).toEqual(['alpha'])
    expect(named).toEqual(['alpha'])
    // Another beta event while alpha is the only attached owner must still wait.
    event({ type: 'approval.request', session_id: SID, replay_epoch: 'epoch-beta', payload: betaPrompt })
    await flush()
    expect(shown.map(canonicalOwnerProfile)).toEqual(['alpha'])
    reply(sent[1], snapshot('beta', [], 9))
    await beta
    expect(shown.map(canonicalOwnerProfile)).toEqual(['alpha', 'beta'])
    expect(named).toEqual(['alpha', 'beta', 'beta'])

    for (const request of shown) { request.respond({ choice: 'once' }) }
    await vi.waitFor(() => expect(sent).toHaveLength(4))
    expect(sent.slice(2).map(frame => [frame.method, frame.params])).toEqual([
      ['approval.respond', { session_id: SID, profile: 'alpha', prompt_id: alphaPrompt.prompt_id, execution_generation: 3, choice: 'once' }],
      ['approval.respond', { session_id: SID, profile: 'beta', prompt_id: betaPrompt.prompt_id, execution_generation: 9, choice: 'once' }]
    ])

    for (const frame of sent.slice(2)) { reply(frame, { status: 'resolved' }) }

    await flush()
    expect(shown).toHaveLength(2)
    expect(sent.filter(frame => frame.method === 'session.resume')).toHaveLength(2)
  })
})

test('an unrelated title resume releases queued fresh-epoch prompts through one owner reconciliation', async () => {
  await withGateway(async ({ client, sent, event, reply, flush }) => {
    const shown: ServerRequest[] = []
    const named: unknown[] = []
    const wildcard: unknown[] = []
    client.onRequest(request => { shown.push(request) })
    client.on('approval.request', frame => { named.push(canonicalOwnerProfile(frame)) })
    client.onAny(frame => {
      if (frame.type === 'approval.request') { wildcard.push(canonicalOwnerProfile(frame)) }
    })
    const attached = Promise.all(['alpha', 'beta'].map(profile => client.request('session.resume', { session_id: SID, profile })))
    void attached.catch(() => undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    reply(sent[0], snapshot('alpha', [], 3))
    reply(sent[1], snapshot('beta', [], 9))
    await attached

    const unrelated = client.request('session.resume', { session_id: TITLE, profile: 'ops' })
    void unrelated.catch(() => undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(3))
    const first = prompt('approval', 'beta', 10)
    const second = { ...first, prompt_id: `${first.prompt_id}-second` }
    const epoch = 'epoch-beta-rotated'
    event({ type: 'approval.request', session_id: SID, replay_epoch: epoch, payload: first })
    await flush()
    expect(shown).toEqual([])
    expect(sent).toHaveLength(3)
    reply(sent[2], { ...snapshot('ops'), session_id: 'unrelated-session', stored_session_id: 'unrelated-session' })
    await unrelated
    // A later frame must join the same queue, not start a second probe or bypass its first frame.
    event({ type: 'approval.request', session_id: SID, replay_epoch: epoch, payload: second })
    await flush()
    await vi.waitFor(() => expect(sent).toHaveLength(5))
    expect(sent.slice(3).map(frame => [frame.method, frame.params])).toEqual([
      ['session.resume', { session_id: SID, profile: 'alpha' }],
      ['session.resume', { session_id: SID, profile: 'beta' }]
    ])
    expect(shown).toEqual([])
    expect(named).toEqual([])
    expect(wildcard).toEqual([])
    // Even learning beta's epoch cannot bypass the in-flight reconciliation's settle barrier.
    reply(sent[4], { ...snapshot('beta', [], 10), replay_epoch: epoch })
    await flush()
    expect(shown).toEqual([])
    expect(named).toEqual([])
    expect(wildcard).toEqual([])
    reply(sent[3], snapshot('alpha', [], 3))
    await vi.waitFor(() => expect(shown.map(request => request.id)).toEqual([first.prompt_id, second.prompt_id]))
    expect(shown.map(canonicalOwnerProfile)).toEqual(['beta', 'beta'])
    expect(named).toEqual(['beta', 'beta'])
    expect(wildcard).toEqual(['beta', 'beta'])

    for (const request of shown) {
      request.respond({ choice: 'once' })
      request.respond({ choice: 'once' })
    }

    await vi.waitFor(() => expect(sent).toHaveLength(7))
    expect(sent.slice(5).map(frame => [frame.method, frame.params])).toEqual([first, second].map(pending =>
      ['approval.respond', { session_id: SID, profile: 'beta', prompt_id: pending.prompt_id, execution_generation: 10, choice: 'once' }]))

    for (const frame of sent.slice(5)) { reply(frame, { status: 'resolved' }) }

    await flush()
    expect(shown).toHaveLength(2)
    expect(sent).toHaveLength(7)
  })
})

test('an epoch-less pre-ACK frame fails closed when title lookups resolve to equal IDs in different profiles', async () => {
  await withGateway(async ({ client, sent, event, reply, flush }) => {
    const shown: ServerRequest[] = []
    const named: unknown[] = []
    client.onRequest(request => { shown.push(request) })
    client.on('approval.request', frame => { named.push(canonicalOwnerProfile(frame)) })
    const alpha = client.request('session.resume', { session_id: TITLE, profile: 'alpha' })
    const beta = client.request('session.resume', { session_id: TITLE, profile: 'beta' })
    void alpha.catch(() => undefined)
    void beta.catch(() => undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    event({ type: 'approval.request', session_id: SID, payload: prompt('approval', 'unresolved', 999) })
    await flush()
    expect(shown).toEqual([])
    reply(sent[0], snapshot('alpha', [prompt('approval', 'alpha', 3)], 3))
    await alpha
    expect(shown.map(canonicalOwnerProfile)).toEqual(['alpha'])
    expect(named).toEqual([])
    reply(sent[1], snapshot('beta', [prompt('approval', 'beta', 9)], 9))
    await beta
    await flush()
    expect(shown.map(canonicalOwnerProfile)).toEqual(['alpha', 'beta'])
    expect(named).toEqual([])
    await expect(client.request('session.interrupt', { session_id: SID })).rejects.toThrow('several profiles')

    for (const request of shown) { request.respond({ choice: 'once' }) }

    await vi.waitFor(() => expect(sent).toHaveLength(4))
    expect(sent.slice(2).map(frame => [frame.params.profile, frame.params.execution_generation])).toEqual([['alpha', 3], ['beta', 9]])

    for (const frame of sent.slice(2)) { reply(frame, { status: 'resolved' }) }
  })
})

test.each([
  { outcome: 'aborted', epoch: true }, { outcome: 'refused', epoch: true },
  { outcome: 'aborted', epoch: false }, { outcome: 'refused', epoch: false }
] as const)('a $outcome beta title lookup cannot lend its orphaned frame to the sole alpha owner (epoch=$epoch)', async ({ outcome, epoch }) => {
  await withGateway(async ({ client, sent, event, reply, refuse, flush }) => {
    const shown: ServerRequest[] = []
    const named: unknown[] = []
    const wildcard: unknown[] = []
    client.onRequest(request => { shown.push(request) })
    client.on('approval.request', frame => { named.push(canonicalOwnerProfile(frame)) })
    client.onAny(frame => {
      if (frame.type === 'approval.request') { wildcard.push(canonicalOwnerProfile(frame)) }
    })
    const attached = client.request('session.resume', { session_id: SID, profile: 'alpha' })
    void attached.catch(() => undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    reply(sent[0], snapshot('alpha', [], 3))
    await attached

    const controller = new AbortController()
    const lookup = client.request('session.resume', { session_id: TITLE, profile: 'beta' }, undefined, controller.signal)
    const rejected = expect(lookup).rejects.toThrow(outcome === 'aborted' ? 'Aborted' : 'not_found')
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    const orphan = prompt('approval', 'beta', 9)
    event({ type: 'approval.request', session_id: SID, ...(epoch ? { replay_epoch: 'epoch-beta' } : {}), payload: orphan })
    await flush()
    expect(shown).toEqual([])
    expect(named).toEqual([])
    expect(wildcard).toEqual([])

    if (outcome === 'aborted') { controller.abort() } else { refuse(sent[1]) }

    await rejected

    if (epoch) {
      await vi.waitFor(() => expect(sent).toHaveLength(3))
      expect(sent[2]).toMatchObject({ method: 'session.resume', params: { session_id: SID, profile: 'alpha' } })
      // A successful probe is NOT proof for this frame: the stream epochs differ.
      reply(sent[2], snapshot('alpha', [], 3))
    }

    await flush()
    // The ACK's async adoption and all-settled continuations precede this next socket round-trip.
    await flush()
    expect(shown).toEqual([])
    expect(named).toEqual([])
    expect(wildcard).toEqual([])

    // Settled orphan queues are discarded, not made eligible by a later attachment.
    expect(sent).toHaveLength(epoch ? 3 : 2)
    const betaIndex = sent.length
    const beta = client.request('session.resume', { session_id: SID, profile: 'beta' })
    void beta.catch(() => undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(betaIndex + 1))
    reply(sent[betaIndex], snapshot('beta', [], 9))
    await beta
    await flush()
    expect(shown).toEqual([])
    expect(named).toEqual([])
    expect(wildcard).toEqual([])
    const current = { ...orphan, prompt_id: `${orphan.prompt_id}-current` }
    event({ type: 'approval.request', session_id: SID, replay_epoch: 'epoch-beta', payload: current })
    await flush()
    expect(shown.map(request => request.id)).toEqual([current.prompt_id])
    expect(shown.map(canonicalOwnerProfile)).toEqual(['beta'])
    expect(named).toEqual(['beta'])
    expect(wildcard).toEqual(['beta'])
    shown[0].respond({ choice: 'once' })
    shown[0].respond({ choice: 'once' })
    await vi.waitFor(() => expect(sent).toHaveLength(betaIndex + 2))
    expect(sent[betaIndex + 1]).toMatchObject({ method: 'approval.respond', params: {
      session_id: SID, profile: 'beta', prompt_id: current.prompt_id, execution_generation: 9, choice: 'once'
    } })
    reply(sent[betaIndex + 1], { status: 'resolved' })
    await flush()
    expect(sent).toHaveLength(betaIndex + 2)
  })
})

test('an overflowing unproven queue fails closed instead of releasing a partial fanout', async () => {
  await withGateway(async ({ client, sent, event, reply, flush }) => {
    const shown: ServerRequest[] = []
    const named: unknown[] = []
    const wildcard: unknown[] = []
    client.onRequest(request => { shown.push(request) })
    client.on('approval.request', frame => { named.push(canonicalOwnerProfile(frame)) })
    client.onAny(frame => {
      if (frame.type === 'approval.request') { wildcard.push(canonicalOwnerProfile(frame)) }
    })
    const lookup = client.request('session.resume', { session_id: TITLE, profile: 'beta' })
    void lookup.catch(() => undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    for (let i = 0; i < 1100; i++) {
      event({ type: 'approval.request', session_id: SID, replay_epoch: 'epoch-beta',
        payload: { ...prompt('approval', 'beta'), prompt_id: `overflow-${i}` } })
    }

    await flush()
    expect(shown).toEqual([])
    reply(sent[0], snapshot('beta'))
    await lookup
    await flush()
    expect(shown).toEqual([])
    expect(named).toEqual([])
    expect(wildcard).toEqual([])
    // Overflow retires this batch, not the proven stream or its next prompt.
    event({ type: 'approval.request', session_id: SID, replay_epoch: 'epoch-beta', payload: prompt('approval', 'beta') })
    await flush()
    expect(shown.map(request => request.id)).toEqual(['approval-beta'])
    expect(named).toEqual(['beta'])
    expect(wildcard).toEqual(['beta'])
  })
})

test.each([false, true])('one attached owner recovers a fresh epoch only after matching snapshot proof (parked=%s)', async parked => {
  await withGateway(async ({ client, sent, event, reply, refuse, flush }) => {
    const shown: ServerRequest[] = []
    const named: unknown[] = []
    const wildcard: unknown[] = []
    const messages: unknown[] = []
    client.onRequest(request => { shown.push(request) })
    client.on('approval.request', frame => { named.push(canonicalOwnerProfile(frame)) })
    client.on('message.complete', frame => { messages.push(['named', canonicalOwnerProfile(frame)]) })
    client.onAny(frame => {
      if (frame.type === 'approval.request') { wildcard.push(canonicalOwnerProfile(frame)) }

      if (frame.type === 'message.complete') { messages.push(['wildcard', canonicalOwnerProfile(frame)]) }
    })
    const attached = client.request('session.resume', { session_id: SID, profile: 'alpha' })
    void attached.catch(() => undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    reply(sent[0], snapshot('alpha', [], 3))
    await attached
    let lookup: Promise<unknown> | undefined

    if (parked) {
      lookup = client.request('session.resume', { session_id: TITLE, profile: 'ops' })
      void lookup.catch(() => undefined)
      await vi.waitFor(() => expect(sent).toHaveLength(2))
    }

    const first = prompt('approval', 'alpha', 4)
    const second = { ...first, prompt_id: `${first.prompt_id}-second` }
    const epoch = 'epoch-alpha-rotated'
    event({ type: 'approval.request', session_id: SID, replay_epoch: epoch, payload: first })
    await flush()
    expect(shown).toEqual([])
    expect(named).toEqual([])
    expect(wildcard).toEqual([])

    if (lookup) {
      const rejected = expect(lookup).rejects.toThrow('not_found')
      refuse(sent[1])
      await rejected
    }

    const probeIndex = parked ? 2 : 1
    await vi.waitFor(() => expect(sent).toHaveLength(probeIndex + 1))
    expect(sent[probeIndex]).toMatchObject({ method: 'session.resume', params: { session_id: SID, profile: 'alpha' } })
    event({ type: 'approval.request', session_id: SID, replay_epoch: epoch, payload: second })
    event({ type: 'message.complete', session_id: SID, replay_epoch: epoch, payload: { text: 'live only' } })
    await flush()
    expect(shown).toEqual([])
    expect(named).toEqual([])
    expect(wildcard).toEqual([])
    expect(messages).toEqual([])
    expect(sent).toHaveLength(probeIndex + 1)
    reply(sent[probeIndex], { ...snapshot('alpha', [], 4), replay_epoch: epoch })
    await vi.waitFor(() => expect(shown.map(request => request.id)).toEqual([first.prompt_id, second.prompt_id]))
    expect(shown.map(canonicalOwnerProfile)).toEqual(['alpha', 'alpha'])
    expect(named).toEqual(['alpha', 'alpha'])
    expect(wildcard).toEqual(['alpha', 'alpha'])
    expect(messages).toEqual([['named', 'alpha'], ['wildcard', 'alpha']])

    for (const request of shown) {
      request.respond({ choice: 'once' })
      request.respond({ choice: 'once' })
    }

    await vi.waitFor(() => expect(sent).toHaveLength(probeIndex + 3))
    expect(sent.slice(probeIndex + 1).map(frame => frame.params)).toEqual([first, second].map(pending => ({
      session_id: SID, profile: 'alpha', prompt_id: pending.prompt_id, execution_generation: 4, choice: 'once'
    })))

    for (const frame of sent.slice(probeIndex + 1)) { reply(frame, { status: 'resolved' }) }

    await flush()
    expect(shown).toHaveLength(2)
    expect(sent).toHaveLength(probeIndex + 3)
  })
})

test('a failed title lookup with no candidate owner discards its frames before a different profile attaches', async () => {
  await withGateway(async ({ client, sent, event, reply, refuse, flush }) => {
    const shown: ServerRequest[] = []
    const named: unknown[] = []
    const wildcard: unknown[] = []
    client.onRequest(request => { shown.push(request) })
    client.on('approval.request', frame => { named.push(canonicalOwnerProfile(frame)) })
    client.onAny(frame => {
      if (frame.type === 'approval.request') { wildcard.push(canonicalOwnerProfile(frame)) }
    })
    const lookup = client.request('session.resume', { session_id: TITLE, profile: 'beta' })
    const rejected = expect(lookup).rejects.toThrow('not_found')
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    event({ type: 'approval.request', session_id: SID, replay_epoch: 'epoch-beta', payload: prompt('approval', 'orphan') })
    event({ type: 'approval.request', session_id: SID, payload: prompt('approval', 'epochless-orphan') })
    await flush()
    refuse(sent[0])
    await rejected
    const alpha = client.request('session.resume', { session_id: TITLE, profile: 'alpha' })
    void alpha.catch(() => undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    reply(sent[1], snapshot('alpha'))
    await alpha
    await flush()
    await flush()
    expect(shown).toEqual([])
    expect(named).toEqual([])
    expect(wildcard).toEqual([])
    expect(sent).toHaveLength(2)
  })
})

test('an in-flight owner proof and its queued frames cannot survive reconnect', async () => {
  await withGateway(async ({ client, sent, event, reply, flush, reconnect }) => {
    const shown: ServerRequest[] = []
    const named: unknown[] = []
    const wildcard: unknown[] = []
    client.onRequest(request => { shown.push(request) })
    client.on('approval.request', frame => { named.push(canonicalOwnerProfile(frame)) })
    client.onAny(frame => {
      if (frame.type === 'approval.request') { wildcard.push(canonicalOwnerProfile(frame)) }
    })
    const attached = Promise.all(['alpha', 'beta'].map(profile => client.request('session.resume', { session_id: SID, profile })))
    void attached.catch(() => undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    reply(sent[0], snapshot('alpha'))
    reply(sent[1], snapshot('beta'))
    await attached
    const old = prompt('approval', 'old', 8)
    const epoch = 'epoch-beta-rotated'
    event({ type: 'approval.request', session_id: SID, replay_epoch: epoch, payload: old })
    await flush()
    await vi.waitFor(() => expect(sent).toHaveLength(4))
    reply(sent[3], { ...snapshot('beta', [], 8), replay_epoch: epoch })
    await flush()
    await flush()
    expect(shown).toEqual([])
    client.close()
    await reconnect()
    const resumed = client.request('session.resume', { session_id: SID, profile: 'beta' })
    void resumed.catch(() => undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(5))
    // Even a late reply carrying the formerly missing proof cannot release old callbacks.
    reply(sent[2], snapshot('alpha'))
    reply(sent[4], { ...snapshot('beta', [], 8), replay_epoch: epoch })
    await resumed
    await flush()
    await flush()
    expect(shown).toEqual([])
    expect(named).toEqual([])
    expect(wildcard).toEqual([])
    const current = prompt('approval', 'current', 8)
    event({ type: 'approval.request', session_id: SID, replay_epoch: epoch, payload: current })
    await flush()
    expect(shown.map(request => request.id)).toEqual([current.prompt_id])
    expect(named).toEqual(['beta'])
    expect(wildcard).toEqual(['beta'])
    shown[0].respond({ choice: 'once' })
    shown[0].respond({ choice: 'once' })
    await vi.waitFor(() => expect(sent).toHaveLength(6))
    expect(sent[5]).toMatchObject({ method: 'approval.respond', params: {
      session_id: SID, profile: 'beta', prompt_id: current.prompt_id, execution_generation: 8, choice: 'once'
    } })
    reply(sent[5], { status: 'resolved' })
  })
})

test('parked title-resume prompts cannot cross a socket generation', async () => {
  await withGateway(async ({ client, sent, event, reply, flush, reconnect }) => {
    const shown: ServerRequest[] = []
    const named: unknown[] = []
    client.onRequest(request => { shown.push(request) })
    client.on('approval.request', frame => { named.push(canonicalOwnerProfile(frame)) })
    const oldResume = client.request('session.resume', { session_id: TITLE, profile: 'ops' })
    const rejected = expect(oldResume).rejects.toThrow('connection closed')
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    event({ type: 'approval.request', session_id: SID, replay_epoch: 'epoch-ops', payload: prompt('approval', 'old') })
    await flush()
    expect(shown).toEqual([])
    client.close()
    await rejected
    await reconnect()
    const resumed = client.request('session.resume', { session_id: TITLE, profile: 'ops' })
    void resumed.catch(() => undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    reply(sent[1], snapshot('ops'))
    await resumed
    expect(shown).toEqual([])
    expect(named).toEqual([])
    const current = prompt('approval')
    event({ type: 'approval.request', session_id: SID, replay_epoch: 'epoch-ops', payload: current })
    await flush()
    expect(shown.map(request => request.id)).toEqual([current.prompt_id])
    expect(shown.map(canonicalOwnerProfile)).toEqual(['ops'])
    shown[0].respond({ choice: 'once' })
    await vi.waitFor(() => expect(sent).toHaveLength(3))
    expect(sent[2]).toMatchObject({ method: 'approval.respond', params: { profile: 'ops', prompt_id: current.prompt_id } })
    reply(sent[2], { status: 'resolved' })
  })
})
