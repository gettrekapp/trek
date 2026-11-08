// scripts/importRules.test.mjs — importing a .trekproj: where each piece goes, migrated.json,
// and the recents and open-windows rewrites.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  localFirst,
  markPrompted,
  migratedFile,
  parseMigrated,
  promptCandidates,
  recordImport,
  restoreEntries,
  rewriteOpenWindows,
  rewriteRecents,
  routePiece,
  serializeMigrated
} from '../src/main/importRules.ts'
import { MAX_RECENTS } from '../src/main/recentsRules.ts'

const fileServers = [
  { id: 'srv', name: 'build-box', url: 'wss://build.example:7777' },
  { id: 'old', name: 'old-box', url: 'https://old.example' },
  { id: 'bad', name: 'bad', url: 'not a url' }
]
const entries = [
  { id: 'local', name: 'Local', url: 'ws://127.0.0.1:5000' },
  { id: 'e1', name: 'Build', url: 'wss://build.example:7777/' },
  { id: 'e2', name: 'Other', url: 'wss://other.example' }
]

test('routePiece: the local target goes to Local', () => {
  assert.deepEqual(routePiece('local', fileServers, entries), { kind: 'local' })
})

test('routePiece: a remote target matches a saved entry by origin, never the Local entry', () => {
  assert.deepEqual(routePiece('srv', fileServers, entries), { kind: 'entry', entryId: 'e1', name: 'Build' })
  // Another port is another origin.
  assert.deepEqual(routePiece('srv', fileServers, [{ id: 'e3', name: 'Port', url: 'wss://build.example:7778' }]), {
    kind: 'add',
    server: fileServers[0]
  })
  // A Local entry on the same origin is not a match: Local is this machine, not the file's server.
  assert.deepEqual(routePiece('srv', fileServers, [{ id: 'local', name: 'Local', url: 'wss://build.example:7777' }]), {
    kind: 'add',
    server: fileServers[0]
  })
})

test('routePiece: an exact URL wins over another entry with the same origin', () => {
  const two = [
    { id: 'a', name: 'A', url: 'wss://build.example:7777/sub' },
    { id: 'b', name: 'B', url: 'wss://build.example:7777' }
  ]
  assert.deepEqual(routePiece('srv', fileServers, two), { kind: 'entry', entryId: 'b', name: 'B' })
})

test('routePiece: a server the file names with no entry is offered to add; one it cannot be added as is unknown', () => {
  assert.deepEqual(routePiece('srv', fileServers, []), { kind: 'add', server: fileServers[0] })
  assert.deepEqual(routePiece('old', fileServers, []), { kind: 'unknown', label: 'old-box', why: 'its address is not a ws:// or wss:// URL' })
  assert.deepEqual(routePiece('bad', fileServers, []), { kind: 'unknown', label: 'bad', why: 'its address is not a ws:// or wss:// URL' })
  assert.deepEqual(routePiece('gone', fileServers, entries), { kind: 'unknown', label: 'server gone', why: "the file's server list does not name it" })
})

const piece = (target, projectId, serverEntryId = target === 'local' ? 'local' : `e-${target}`) => ({
  target,
  serverEntryId,
  projectId,
  name: 'Proj',
  serverName: target === 'local' ? 'Local' : 'Build'
})

test('localFirst keeps the order otherwise', () => {
  assert.deepEqual(localFirst([piece('a', 'p1'), piece('local', 'p2'), piece('b', 'p3')]).map((p) => p.target), ['local', 'a', 'b'])
})

test('parseMigrated tolerates anything and keeps well-formed files', () => {
  assert.deepEqual(parseMigrated(null), { prompted: false, files: {} })
  assert.deepEqual(parseMigrated({ prompted: 'yes', files: [] }), { prompted: false, files: {} })
  const good = { prompted: true, files: { '/a.trekproj': { pieces: [piece('local', 'p1')], left: [{ target: 'srv', label: 'build-box', reason: 'not added' }] } } }
  assert.deepEqual(parseMigrated(good), good)
  const mixed = {
    prompted: true,
    files: {
      '/a.trekproj': { pieces: [piece('local', 'p1'), { target: 'x' }, piece('srv', '')], left: [{ target: 1 }] },
      '/b.trekproj': 'nope',
      '': { pieces: [], left: [] }
    }
  }
  assert.deepEqual(parseMigrated(mixed), { prompted: true, files: { '/a.trekproj': { pieces: [piece('local', 'p1')], left: [] } } })
  // A prototype key never becomes a file.
  assert.deepEqual(parseMigrated(JSON.parse('{"files":{"__proto__":{"pieces":[],"left":[]}}}')).files, {})
  assert.deepEqual(parseMigrated(serializeMigrated(good)), good)
})

test('recordImport adds pieces, replaces a re-imported target and keeps the left ones not attempted', () => {
  let m = parseMigrated(null)
  m = recordImport(m, '/a', { attempted: ['local', 'srv'], pieces: [piece('local', 'p1')], left: [{ target: 'srv', label: 'build-box', reason: 'not added' }] })
  assert.deepEqual(migratedFile(m, '/a'), { pieces: [piece('local', 'p1')], left: [{ target: 'srv', label: 'build-box', reason: 'not added' }] })
  // A retry of the left piece: it lands, and Local's stays.
  m = recordImport(m, '/a', { attempted: ['srv'], pieces: [piece('srv', 'p2')], left: [] })
  assert.deepEqual(migratedFile(m, '/a'), { pieces: [piece('local', 'p1'), piece('srv', 'p2')], left: [] })
  // Import again: Local's piece is replaced by the new project.
  m = recordImport(m, '/a', { attempted: ['local'], pieces: [piece('local', 'p3')], left: [] })
  assert.deepEqual(migratedFile(m, '/a').pieces.map((p) => p.projectId), ['p3', 'p2'])
  // Nothing landed and nothing was there: no entry, so the next open imports again.
  m = recordImport(m, '/b', { attempted: ['local'], pieces: [], left: [{ target: 'local', label: 'Local', reason: 'off' }] })
  assert.equal(migratedFile(m, '/b'), undefined)
  assert.equal(migratedFile(m, '/c'), undefined)
  assert.equal(markPrompted(m).prompted, true)
  assert.equal(m.prompted, false)
})

const file = (path) => ({ kind: 'file', path })
const server = (serverEntryId, projectId) => ({ kind: 'server', serverEntryId, projectId, name: 'Proj', serverName: serverEntryId === 'local' ? 'Local' : 'Build' })
const isA = (path) => path === '/a.trekproj' || path === '/link/a.trekproj'

test("rewriteRecents puts the pieces where the file was, Local's first, and drops the file's other entries", () => {
  const list = [file('/x.trekproj'), file('/a.trekproj'), server('e9', 'q'), file('/link/a.trekproj')]
  assert.deepEqual(rewriteRecents(list, isA, [piece('srv', 'p2'), piece('local', 'p1')]), [
    file('/x.trekproj'),
    server('local', 'p1'),
    server('e-srv', 'p2'),
    server('e9', 'q')
  ])
})

test('rewriteRecents moves a server entry already listed instead of doubling it, and prepends when the file was not listed', () => {
  const list = [server('local', 'p1'), file('/x.trekproj'), file('/a.trekproj')]
  assert.deepEqual(rewriteRecents(list, isA, [piece('local', 'p1')]), [file('/x.trekproj'), server('local', 'p1')])
  assert.deepEqual(rewriteRecents([file('/x.trekproj')], isA, [piece('local', 'p1')]), [server('local', 'p1'), file('/x.trekproj')])
  assert.deepEqual(rewriteRecents([file('/a.trekproj')], isA, []), [file('/a.trekproj')])
})

test('rewriteRecents keeps the cap', () => {
  const list = Array.from({ length: MAX_RECENTS }, (_, i) => file(i === 0 ? '/a.trekproj' : `/f${i}.trekproj`))
  const out = rewriteRecents(list, isA, [piece('local', 'p1'), piece('srv', 'p2')])
  assert.equal(out.length, MAX_RECENTS)
  assert.deepEqual(out.slice(0, 2), [server('local', 'p1'), server('e-srv', 'p2')])
})

const bounds = { x: 1, y: 2, width: 900, height: 700 }

test("rewriteOpenWindows gives the file's window to Local's piece and keeps its bounds", () => {
  const windows = [
    { target: { kind: 'file', path: '/x.trekproj' } },
    { target: { kind: 'file', path: '/a.trekproj' }, bounds },
    { target: { kind: 'file', path: '/link/a.trekproj' } }
  ]
  assert.deepEqual(rewriteOpenWindows(windows, isA, [piece('srv', 'p2'), piece('local', 'p1')]), [
    { target: { kind: 'file', path: '/x.trekproj' } },
    { target: { kind: 'server', serverEntryId: 'local', projectId: 'p1' }, bounds }
  ])
})

test('rewriteOpenWindows: no Local piece means the first one; a window already on it stays the only one', () => {
  const windows = [{ target: { kind: 'file', path: '/a.trekproj' } }]
  assert.deepEqual(rewriteOpenWindows(windows, isA, [piece('srv', 'p2')]), [{ target: { kind: 'server', serverEntryId: 'e-srv', projectId: 'p2' } }])
  const already = [{ target: { kind: 'server', serverEntryId: 'local', projectId: 'p1' } }, { target: { kind: 'file', path: '/a.trekproj' }, bounds }]
  assert.deepEqual(rewriteOpenWindows(already, isA, [piece('local', 'p1')]), [{ target: { kind: 'server', serverEntryId: 'local', projectId: 'p1' } }])
  assert.deepEqual(rewriteOpenWindows(windows, isA, []), windows)
})

test('restoreEntries: each window on an imported file comes back on its Local piece; other windows stay', () => {
  const key = (path) => (path === '/link/a.trekproj' ? '/a.trekproj' : path)
  const m = recordImport(parseMigrated(null), '/a.trekproj', { attempted: ['local', 'srv'], pieces: [piece('srv', 'p2'), piece('local', 'p1')], left: [] })
  const windows = [
    { target: { kind: 'file', path: '/link/a.trekproj' }, bounds },
    { target: { kind: 'file', path: '/fallback.trekproj' } },
    { target: { kind: 'file', path: '/a.trekproj' } },
    { target: { kind: 'server', serverEntryId: 'e9', projectId: 'q' } }
  ]
  assert.deepEqual(restoreEntries(windows, m, key), [
    { target: { kind: 'server', serverEntryId: 'local', projectId: 'p1' }, bounds },
    { target: { kind: 'file', path: '/fallback.trekproj' } },
    { target: { kind: 'server', serverEntryId: 'e9', projectId: 'q' } }
  ])
  assert.deepEqual(restoreEntries(windows, parseMigrated(null), key), windows)
})

test('promptCandidates: open windows first, then recents, once per file, none already imported', () => {
  const key = (path) => (path === '/link/a.trekproj' ? '/a.trekproj' : path)
  const recents = [file('/b.trekproj'), server('local', 'p'), file('/link/a.trekproj'), file('/done.trekproj')]
  const windows = [{ target: { kind: 'server', serverEntryId: 'local', projectId: 'p' } }, { target: { kind: 'file', path: '/a.trekproj' } }]
  const migrated = recordImport(parseMigrated(null), '/done.trekproj', { attempted: ['local'], pieces: [piece('local', 'd')], left: [] })
  assert.deepEqual(promptCandidates(recents, windows, migrated, key), [
    { path: '/a.trekproj', key: '/a.trekproj' },
    { path: '/b.trekproj', key: '/b.trekproj' }
  ])
})
