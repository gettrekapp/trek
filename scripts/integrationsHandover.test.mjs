// scripts/integrationsHandover.test.mjs — handing the app's Linear and ElevenLabs keys and voice
// settings to the Local server once (phase 5b), against a fake server's set-if-absent methods.
import test from 'node:test'
import assert from 'node:assert/strict'
import { handOver, handoverParts, legacyVoiceConfig, nothingToHandOver, parseHandoverState, readHandoverState } from '../src/main/integrationsHandoverRules.ts'

/** A fake Local server: `keys` it already has; `fail` methods that throw (a server older than 5b, a dropped link). */
function fakeServer({ keys = {}, reject = {}, fail = [] } = {}) {
  const calls = []
  const request = async (method, params) => {
    calls.push([method, params])
    if (fail.includes(method)) throw new Error(`Unknown method: ${method}`)
    if (method === 'voice.setConfig') return params
    const name = method.split('.')[0]
    if (reject[name]) return { ok: false, error: reject[name] }
    if (params.ifAbsent && keys[name]) return { ok: false, error: 'kept', present: true }
    keys[name] = params.apiKey
    return method === 'linear.setKey' ? { ok: true, user: 'Ada' } : { ok: true, voices: [] }
  }
  return { calls, keys, request }
}

const legacy = { linearKey: 'lin_app', voiceKey: 'sk_app', voice: { voiceId: 'v9', modelId: 'eleven_turbo_v2_5', promptSessions: true, active: false } }

test('both keys and the voice settings go over once, set-if-absent', async () => {
  const server = fakeServer()
  assert.deepEqual(await handOver(server.request, legacy, {}), { linear: true, voice: true })
  assert.deepEqual(server.calls, [
    ['linear.setKey', { apiKey: 'lin_app', ifAbsent: true }],
    ['voice.setKey', { apiKey: 'sk_app', ifAbsent: true }],
    ['voice.setConfig', { voiceId: 'v9', modelId: 'eleven_turbo_v2_5', promptSessions: true }]
  ])
  // Done parts are not asked again.
  const again = fakeServer()
  assert.deepEqual(await handOver(again.request, legacy, { linear: true, voice: true }), { linear: true, voice: true })
  assert.deepEqual(again.calls, [])
})

test("each part goes over on its own plugin's capability: one the server lacks waits, the other goes (plugin system phase 2)", async () => {
  assert.deepEqual(handoverParts(['linear', 'voice', 'skills']), { linear: true, voice: true })
  assert.deepEqual(handoverParts(['linear']), { linear: true, voice: false })
  assert.deepEqual(handoverParts([]), { linear: false, voice: false })
  // The voice plugin failed to start there: Linear goes over all the same; voice is left for a later start.
  const noVoice = fakeServer()
  assert.deepEqual(await handOver(noVoice.request, legacy, {}, { linear: true, voice: false }), { linear: true })
  assert.deepEqual(noVoice.calls, [['linear.setKey', { apiKey: 'lin_app', ifAbsent: true }]])
  // And the other way round; a pending voice config waits too.
  const noLinear = fakeServer()
  assert.deepEqual(await handOver(noLinear.request, legacy, {}, { linear: false, voice: true }), { voice: true })
  assert.deepEqual(noLinear.calls.map(([m]) => m), ['voice.setKey', 'voice.setConfig'])
  const pending = fakeServer()
  assert.deepEqual(await handOver(pending.request, legacy, { linear: true, voice: true, voiceConfigPending: true }, { linear: true, voice: false }), { linear: true, voice: true, voiceConfigPending: true })
  assert.deepEqual(pending.calls, [])
})

test('a part with no key stored is done whatever the server lacks: nothing to send', async () => {
  const server = fakeServer()
  const onlyLinear = { linearKey: 'lin_app', voiceKey: null, voice: legacy.voice }
  assert.deepEqual(await handOver(server.request, onlyLinear, {}, { linear: true, voice: false }), { linear: true, voice: true })
  assert.deepEqual(server.calls, [['linear.setKey', { apiKey: 'lin_app', ifAbsent: true }]], 'no voice call')
  const onlyVoice = fakeServer()
  assert.deepEqual(await handOver(onlyVoice.request, { ...legacy, linearKey: null }, {}, { linear: false, voice: false }), { linear: true })
  assert.deepEqual(onlyVoice.calls, [])
})

test("a server with its own key keeps it, and its own voice: that part is done", async () => {
  const server = fakeServer({ keys: { linear: 'lin_srv', voice: 'sk_srv' } })
  assert.deepEqual(await handOver(server.request, legacy, {}), { linear: true, voice: true })
  assert.deepEqual(server.keys, { linear: 'lin_srv', voice: 'sk_srv' })
  assert.equal(server.calls.some(([m]) => m === 'voice.setConfig'), false)
})

test('nothing to hand over is done at once; a refused key or an older server is left for the next start', async () => {
  const none = fakeServer()
  assert.deepEqual(await handOver(none.request, { linearKey: null, voiceKey: null, voice: {} }, {}), { linear: true, voice: true })
  assert.deepEqual(none.calls, [])
  const refused = fakeServer({ reject: { linear: 'Linear rejected the API key' } })
  assert.deepEqual(await handOver(refused.request, legacy, {}), { voice: true })
  const older = fakeServer({ fail: ['linear.setKey', 'voice.setKey'] })
  assert.deepEqual(await handOver(older.request, legacy, {}), {})
  // The key went but the voice settings did not: they are pending, and sent next time (only they).
  const half = fakeServer({ fail: ['voice.setConfig'] })
  const pending = await handOver(half.request, legacy, { linear: true })
  assert.deepEqual(pending, { linear: true, voice: true, voiceConfigPending: true })
  const next = fakeServer({ keys: { voice: 'sk_app' } })
  assert.deepEqual(await handOver(next.request, legacy, pending), { linear: true, voice: true })
  assert.deepEqual(next.calls, [['voice.setConfig', { voiceId: 'v9', modelId: 'eleven_turbo_v2_5', promptSessions: true }]])
})

test('a key stored but unreadable here (safeStorage cannot decrypt it) is not done: tried again next start', async () => {
  const unreadable = { linearKey: null, voiceKey: null, voice: legacy.voice, unreadable: { linear: true, voice: true } }
  assert.equal(nothingToHandOver(unreadable), false)
  assert.equal(nothingToHandOver({ linearKey: null, voiceKey: null, voice: {} }), true)
  const server = fakeServer()
  assert.deepEqual(await handOver(server.request, unreadable, {}), {})
  assert.deepEqual(server.calls, [])
  // One part unreadable, the other handed over.
  const half = fakeServer()
  assert.deepEqual(await handOver(half.request, { ...legacy, linearKey: null, unreadable: { linear: true } }, {}), { voice: true })
  assert.deepEqual(half.calls.map(([m]) => m), ['voice.setKey', 'voice.setConfig'])
})

test('only well-formed voice settings are sent; the state file reads strictly', () => {
  assert.deepEqual(legacyVoiceConfig({ voiceId: '', modelId: 'a b', promptSessions: 'yes', active: true }), {})
  assert.deepEqual(legacyVoiceConfig({ voiceId: 'v1', promptSessions: false }), { voiceId: 'v1', promptSessions: false })
  assert.deepEqual(parseHandoverState(undefined), { profiles: {} })
  assert.deepEqual(parseHandoverState({ profiles: { local: { linear: true, voice: 'x', voiceConfigPending: true }, 'local-dev': null }, voiceActive: true }), { profiles: { local: { linear: true } }, voiceActive: true })
  assert.deepEqual(parseHandoverState({ profiles: { local: { voice: true, voiceConfigPending: true } } }), { profiles: { local: { voice: true, voiceConfigPending: true } } })
  const proto = parseHandoverState(JSON.parse('{"profiles":{"__proto__":{"linear":true}}}'))
  assert.equal(Object.hasOwn(proto.profiles, '__proto__'), true)
  assert.equal(Object.getPrototypeOf(proto.profiles), Object.prototype)
})

test('the state file: missing is the empty state; unreadable or unparsable is null (that start does nothing)', () => {
  const missing = () => {
    throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
  }
  assert.deepEqual(readHandoverState(missing), { state: { profiles: {} } })
  assert.deepEqual(readHandoverState(() => JSON.stringify({ profiles: { local: { linear: true } }, voiceActive: true })), {
    state: { profiles: { local: { linear: true } }, voiceActive: true }
  })
  for (const read of [
    () => '{"profiles": {"local": {"linear": tr',
    () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    },
    () => {
      throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' })
    }
  ]) {
    const res = readHandoverState(read)
    assert.equal(res.state, null)
    assert.ok(res.error instanceof Error)
  }
})
