import type * as HermesSdk from '@hermes/plugin-sdk'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $canonicalGroupBindings } from './canonical-group-registry'
import { $botMeta } from './data'
import { $groupChats } from './group-chat'
import type * as GroupChatParts from './group-chat-parts'
import { GroupChatWorkspace } from './group-chat-view'
import { groupSessionKey } from './group-membership'
import { clearGroupComposerDraft, groupComposerDraftKey, groupComposerDraftSnapshot } from './group-panes'
import { runGroupChatRounds, sendToGroupChat } from './group-rounds'
import { createGroupGateway, drain, runTimersInline } from './group-test-utils'
import type { ScriptedGateway } from './group-test-utils'
import { ensureGroupChatSession } from './group-turns'
import { translateBots } from './i18n-test-helper'
import type { GroupMember, ProfileRoute } from './types'

const { request, retain } = vi.hoisted(() => ({ request: vi.fn(), retain: vi.fn() }))
vi.mock('@hermes/plugin-sdk', async importOriginal => {
  const sdk = await importOriginal<typeof HermesSdk>()
  const { en } = await import('@/i18n/en')

  return {
    ...sdk,
    gatewayActivationEpoch: () => 1,
    host: {
      ...sdk.host,
      requestProfile: request,
      retainProfile: retain,
      request: (method: string, params?: Record<string, unknown>) => request(null, method, params),
      connections: vi.fn(async () => []),
      state: {
        ...sdk.host.state,
        connectionId: sdk.atom<string | null>('local'),
        profile: sdk.atom('default'),
        gateway: sdk.atom('open')
      }
    },
    useI18n: () => ({ locale: 'en', t: en }),
    usePluginI18n: () => translateBots
  }
})
vi.mock('./group-chat-parts', async importOriginal => ({
  ...await importOriginal<typeof GroupChatParts>(),
  GroupImageControls: () => null
}))

const group = 'canonical:local:default:not-a-key'

const members: GroupMember[] = [
  { name: 'default', connectionId: 'local', sourceScoped: true },
  { name: 'default', connectionId: 'remote', remoteSource: true, sourceScoped: true }
]

let gateways: Record<string, ScriptedGateway>

beforeEach(() => {
  gateways = { local: createGroupGateway(), remote: createGroupGateway() }
  request.mockReset().mockImplementation(async (route: ProfileRoute | null, method: string, params = {}) => {
    if (method === 'groups.capabilities') {return { driver: true, persistent_process: true }}
    const gateway = gateways[route?.connectionId ?? 'local']

    return (gateway.host.requestProfile as typeof HermesSdk.host.requestProfile)(route!, method, params)
  })
  retain.mockReset().mockImplementation(async (route: ProfileRoute) =>
    (gateways[route.connectionId].host.retainProfile as typeof HermesSdk.host.retainProfile)(route))
  $canonicalGroupBindings.set({})
  $botMeta.set({})
  $groupChats.set({ [group]: {
    roomId: 'desktop-prefixed', members, watermarks: {},
    log: [{ id: 'original', at: 1, from: { kind: 'user', name: 'You' }, text: 'Original Desktop conversation', thread: 'saved-thread' }]
  } })
  clearGroupComposerDraft(groupComposerDraftKey(group, $groupChats.get()[group]))
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  clearGroupComposerDraft(groupComposerDraftKey(group, $groupChats.get()[group]))
  $groupChats.set({})
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('sends a canonical-shaped ordinary name through its stored Desktop sessions and keeps refused drafts', async () => {
  // Seed through the actual session resolver: the test must prove reuse, not a
  // successful-looking submit into newly invented sessions or another source.
  const stored = await Promise.all(members.map(async member =>
    (await ensureGroupChatSession(group, member, 'saved-thread')).stored))

  const original = $groupChats.get()[group]
  request.mockClear()
  await act(async () => { render(<GroupChatWorkspace group={group} members={members} origin="name" />) })
  runTimersInline()
  fireEvent.click(screen.getByRole('button', { name: 'Reply in thread' }))
  const reply = screen.getByRole('textbox', { name: 'Reply in thread' }) as HTMLTextAreaElement
  const errors: string[] = []

  const onError = (event: ErrorEvent) => { errors.push(event.message); event.preventDefault() }
  window.addEventListener('error', onError)

  try {
    fireEvent.change(reply, { target: { value: '/help' } })
    fireEvent.submit(reply.closest('form')!)
    expect(reply.value).toBe('/help')
    expect($groupChats.get()[group].log).toEqual(original.log)

    fireEvent.change(reply, { target: { value: 'Continue the saved thread' } })
    await act(async () => {
      fireEvent.submit(reply.closest('form')!)
      await drain(() => Boolean($groupChats.get()[group].running))
    })
    expect(errors).toEqual([])
    expect(reply.value).toBe('')
    expect($groupChats.get()[group].log?.map(entry => entry.text)).toEqual([
      'Original Desktop conversation', 'Continue the saved thread'
    ])
    expect(request.mock.calls.filter(call => call[1] === 'prompt.submit').map(call => call[0])).toEqual([
      expect.objectContaining({ connectionId: 'local', profile: 'default', targetProfile: 'default' }),
      expect.objectContaining({ connectionId: 'remote', profile: 'default', targetProfile: 'default' })
    ])
    members.forEach((member, index) => {
      const gateway = gateways[member.connectionId!]
      expect(gateway.calls.map(call => call.stored)).toEqual([stored[index]])
      expect($groupChats.get()[group].sessions?.[groupSessionKey('saved-thread', member)]).toBe(stored[index])
    })
    expect($groupChats.get()[group].sessionOwners).toEqual(original.sessionOwners)
    expect(request.mock.calls.filter(call => call[1] === 'session.create')).toHaveLength(0)

    const main = screen.getByRole('textbox', { name: `Message ${group}` }) as HTMLTextAreaElement
    fireEvent.change(main, { target: { value: '/help' } })
    fireEvent.submit(main.closest('form')!)
    expect(main.value).toBe('/help')
    fireEvent.change(main, { target: { value: 'A genuinely new thread' } })
    await act(async () => {
      fireEvent.submit(main.closest('form')!)
      await drain(() => Boolean($groupChats.get()[group].running))
    })
    expect(errors).toEqual([])
    expect(main.value).toBe('')
    expect($groupChats.get()[group].log?.at(-1)).toMatchObject({ text: 'A genuinely new thread' })
    expect($groupChats.get()[group].log?.at(-1)?.thread).not.toBe('saved-thread')
    expect($groupChats.get()[group].roomId).toBe('desktop-prefixed')
    expect($canonicalGroupBindings.get()).toEqual({})
    expect(request.mock.calls.map(call => call[1])).not.toContain('groups.send')
    expect(request.mock.calls.map(call => call[1])).not.toContain('groups.list')
  } finally {
    window.removeEventListener('error', onError)
  }
})

it.each(['main', 'reply'] as const)('preserves the %s draft if the stored room disappears before submission', async composer => {
  const key = groupComposerDraftKey(group, $groupChats.get()[group])
  await act(async () => { render(<GroupChatWorkspace group={group} members={members} origin="name" />) })

  if (composer === 'reply') {fireEvent.click(screen.getByRole('button', { name: 'Reply in thread' }))}
  const input = screen.getByRole('textbox', { name: composer === 'reply' ? 'Reply in thread' : `Message ${group}` })
  fireEvent.change(input, { target: { value: 'Do not lose this unsent message' } })
  request.mockClear()
  // The gate has not repainted yet: a retired canonical-shaped name must fail
  // closed, but that synchronous refusal must not erase the parked draft.
  const onError = (event: ErrorEvent) => event.preventDefault()
  window.addEventListener('error', onError)

  try {
    await act(async () => {
      $groupChats.set({})
      fireEvent.submit(input.closest('form')!)
    })
    const draft = groupComposerDraftSnapshot(key)
    expect(composer === 'reply' ? draft.replies['saved-thread'] : draft.main).toBe('Do not lose this unsent message')
    expect(request.mock.calls.map(call => call[1])).not.toContain('prompt.submit')
  } finally {
    window.removeEventListener('error', onError)
    clearGroupComposerDraft(key)
  }
})

it.each(['explicit-key', 'missing', 'tombstoned'] as const)('refuses %s identity in both Desktop send and round entry points', async kind => {
  if (kind === 'missing') {$groupChats.set({})}

  if (kind === 'tombstoned') {$groupChats.set({ [group]: { ...$groupChats.get()[group], tombstone: true } })}
  const before = $groupChats.get()
  const origin = kind === 'explicit-key' ? 'key' : 'name'
  expect(() => sendToGroupChat(group, members, 'Do not dispatch', 'saved-thread', [], origin))
    .toThrow('Canonical rooms are driven by the gateway')
  await expect(runGroupChatRounds(group, members, 'saved-thread', new Set(), origin))
    .rejects.toThrow('Canonical rooms are driven by the gateway')
  expect($groupChats.get()).toEqual(before)
  expect(request).not.toHaveBeenCalled()
})
