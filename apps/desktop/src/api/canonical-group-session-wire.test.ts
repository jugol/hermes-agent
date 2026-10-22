// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test, vi } from 'vitest'

import type { GroupMember } from '@/plugins/hermes-bots/types'

import { HermesGateway } from './client'

const { host } = vi.hoisted(() => ({ host: {} as Record<string, unknown> }))
vi.mock('@hermes/plugin-sdk', async () => {
  const { pluginSdkMock } = await import('@/plugins/hermes-bots/group-test-utils')

  return pluginSdkMock(host)
})

const doc = JSON.parse(readFileSync(join(process.cwd(), '..', 'shared', 'src', 'gateway-contract.openrpc.json'), 'utf8'))
const schemas = doc.components.schemas

const contracts = new Map<string, { properties: Record<string, unknown>; required?: string[] }>(
  doc['x-canonical-methods'].map((method: { name: string; params: Array<{ schema: { $ref: string } }> }) => [
    method.name, schemas[method.params[0].schema.$ref.split('/').at(-1)!]
  ])
)

// These are the group-turns producer's session frames, exercised through the real
// Desktop adapter and JSON-RPC socket rather than the scripted group gateway.
const GROUP_TITLE = 'Group: retained-room · retained-thread'

const SNAPSHOT = {
  session_id: 'retained-session',
  stored_session_id: 'retained-session',
  revision: 4,
  execution_generation: 2,
  running: false,
  messages: [{ role: 'assistant', content: 'retained history', row_id: 7 }],
  prompts: [],
  info: { profile_name: 'ops', desktop_protocol: 'hermes-gateway-v1' }
}

interface Frame {
  id: number
  method: string
  params: Record<string, unknown>
}

async function withGateway(
  answer: (frame: Frame) => { result: unknown } | { error: unknown },
  run: (client: HermesGateway, sent: Frame[]) => Promise<void>,
  canonical = true
): Promise<void> {
  const wsPackage = 'ws'
  const { WebSocketServer } = await import(wsPackage)
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => server.once('listening', resolve))
  const sent: Frame[] = []
  server.on('connection', (socket: any) => {
    socket.on('message', (bytes: Buffer) => {
      const frame: Frame = JSON.parse(bytes.toString())
      sent.push(frame)
      const contract = canonical ? contracts.get(frame.method) : undefined

      const fields = contract ? [
        ...Object.keys(frame.params).filter(key => !(key in contract.properties)),
        ...(contract.required ?? []).filter(key => !(key in frame.params))
      ] : []

      const response = fields.length
        ? { error: { code: 4001, message: 'invalid_params', data: { reason: 'invalid_params', fields } } }
        : answer(frame)

      socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...response }))
    })
  })
  const client = new HermesGateway()

  try {
    const address = server.address() as { port: number }
    await client.connect(`ws://127.0.0.1:${address.port}/api/ws${canonical ? '?native_dial=fixture&ticket=one-use' : ''}`)
    await run(client, sent)
  } finally {
    client.close()

    for (const socket of server.clients) { socket.terminate() }
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

test.each([false, true])('a legacy group title resumes by the canonical title field (lazy=%s)', async lazy => {
  await withGateway(() => ({ result: SNAPSHOT }), async (client, sent) => {
    const resumed = await client.request('session.resume', {
      session_id: GROUP_TITLE, profile: 'ops', omit_messages: true, ...(lazy ? { lazy: true } : {})
    })

    expect(sent.map(frame => [frame.method, frame.params])).toEqual([[
      'session.resume', { title: GROUP_TITLE, profile: 'ops', omit_messages: !lazy }
    ]])
    expect(resumed).toMatchObject({ session_id: SNAPSHOT.session_id, session_key: SNAPSHOT.stored_session_id })
  })
})

test.each([false, true])('the real retained-group producer persists the owner ID without replay (stored pointer=%s)', async pinned => {
  await withGateway(() => ({ result: SNAPSHOT }), async (client, sent) => {
    const route = { connectionId: 'fixture-owner', mode: 'local' as const, profile: 'ops-alias', targetProfile: 'ops' }
    const member: GroupMember = { name: 'ops-alias', sourceScoped: true, route }
    const routed: unknown[] = []
    Object.assign(host, {
      activeConnectionId: () => 'unrelated-active-source',
      state: {
        connectionId: { get: () => 'unrelated-active-source', listen: () => () => undefined },
        profile: { get: () => 'default', listen: () => () => undefined }
      },
      request: () => { throw new Error('Implicit source fallback is forbidden') },
      requestProfile: (owner: unknown, method: string, params: Record<string, unknown>, timeoutMs?: number) => {
        routed.push(owner)

        return client.request(method, params, timeoutMs)
      }
    })

    const [chat, turns, membership] = await Promise.all([
      import('@/plugins/hermes-bots/group-chat'), import('@/plugins/hermes-bots/group-turns'),
      import('@/plugins/hermes-bots/group-membership')
    ])

    chat.stopGroupChatServerSync()
    const key = membership.groupSessionKey('retained-thread', member)
    const log = [{ at: 1, from: { kind: 'user' as const, name: 'user' }, text: 'keep the room history' }]
    chat.$groupChats.set({ Retained: {
      roomId: 'retained-room', members: [member], log, watermarks: { [key]: 1 },
      sessions: pinned ? { [key]: SNAPSHOT.stored_session_id } : {}
    } })

    try {
      const handle = await turns.ensureGroupChatSession('Retained', member, 'retained-thread')

      expect(handle).toMatchObject({ runtime: SNAPSHOT.session_id, stored: SNAPSHOT.stored_session_id, fresh: false })
      expect(chat.$groupChats.get().Retained).toMatchObject({
        roomId: 'retained-room', members: [member], log, watermarks: { [key]: 1 },
        sessions: { [key]: SNAPSHOT.stored_session_id },
        sessionOwners: { [key]: membership.groupSessionOwner(member) }
      })
      expect(routed).toEqual([route])
      expect(sent.map(frame => [frame.method, frame.params])).toEqual([[
        'session.resume', { profile: 'ops', omit_messages: true, ...(pinned ? { session_id: SNAPSHOT.stored_session_id } : { title: GROUP_TITLE }) }
      ]])
    } finally {
      chat.stopGroupChatServerSync()
      chat.$groupChats.set({})
    }
  })
})

test.each([
  { code: 4001, message: 'not_found', data: { reason: 'not_found' } },
  { code: 4001, message: 'permission_denied', data: { reason: 'permission_denied' } },
  { code: 4001, message: 'profile_mismatch', data: { reason: 'profile_mismatch' } },
  { code: 4001, message: 'invalid_params', data: { reason: 'invalid_params' } },
  { code: 4001, message: 'runtime_draining', data: { reason: 'runtime_draining' } },
  { code: 5001, message: 'storage_unavailable', data: { reason: 'storage_unavailable' } },
  { code: 4001, message: 'session not found' }
])('canonical resume preserves the exact refusal without create or retry: $message', async error => {
  await withGateway(() => ({ error }), async (client, sent) => {
    await expect(client.request('session.resume', { session_id: GROUP_TITLE, profile: 'ops', omit_messages: true }))
      .rejects.toMatchObject(error)
    expect(sent.map(frame => [frame.method, frame.params])).toEqual([[
      'session.resume', { title: GROUP_TITLE, profile: 'ops', omit_messages: true }
    ]])
  })
})

test('canonical stored IDs and explicit title operands are not inferred or normalized', async () => {
  await withGateway(() => ({ result: SNAPSHOT }), async (client, sent) => {
    const frames = [
      { session_id: SNAPSHOT.stored_session_id, profile: 'ops', omit_messages: true },
      { title: 'Group:  exact   title', profile: 'ops', omit_messages: true },
      { session_id: 'Group: literal ID', title: 'Explicit name', profile: 'ops' }
    ]

    for (const params of frames) { await client.request('session.resume', params) }
    expect(sent.map(frame => frame.params)).toEqual(frames)
  })
})

test('legacy connections keep the room flags, title operands and durable result shape', async () => {
  const legacy = { session_id: 'legacy-runtime', session_key: 'legacy-stored', messages: SNAPSHOT.messages }
  await withGateway(() => ({ result: legacy }), async (client, sent) => {
    const create = { profile: 'ops', title: GROUP_TITLE, hidden: true, room_plumbing: true, follow_profile_config: true }
    const resume = { session_id: GROUP_TITLE, profile: 'ops', omit_messages: true }

    expect(await client.request('session.create', create)).toEqual(legacy)
    expect(await client.request('session.resume', resume)).toEqual(legacy)
    expect(sent.map(frame => [frame.method, frame.params])).toEqual([
      ['session.create', create], ['session.resume', resume]
    ])
  }, false)
})

test.each(['session.resume', 'session.create', 'session.activate'])('%s exposes the authoritative stored ID to legacy group consumers without replay', async method => {
  await withGateway(() => ({ result: SNAPSHOT }), async (client, sent) => {
    const params = method === 'session.create'
      ? { profile: 'ops', title: GROUP_TITLE, hidden: true, room_plumbing: true, follow_profile_config: true }
      : { session_id: 'retained-session', profile: 'ops', omit_messages: true }

    const resumed = await client.request(method, params)

    expect(resumed).toMatchObject({
      session_id: SNAPSHOT.session_id,
      stored_session_id: SNAPSHOT.stored_session_id,
      session_key: SNAPSHOT.stored_session_id,
      messages: SNAPSHOT.messages
    })
    expect(sent.map(frame => frame.method)).toEqual([method === 'session.activate' ? 'session.resume' : method])
    expect(sent[0].params.profile).toBe('ops')
  })
})
