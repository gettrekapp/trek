// scripts/importRules.test.mjs — importing a .trekproj: where each piece goes, migrated.json,
// and the recents and open-windows rewrites.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  capPieces,
  declineKey,
  MAX_REMOTE_PIECES,
  OVER_CAP_REASON,
  runScope,
  dropWorktree,
  importSummary,
  isAgentSessionId,
  localFirst,
  markPrompted,
  migratedFile,
  movedSessions,
  parseMigrated,
  profileKeyFor,
  promptCandidates,
  recordImport,
  rekeyStoredOrder,
  restoreEntries,
  splitRestore,
  rewriteOpenWindows,
  rewriteRecents,
  routePiece,
  serializeMigrated,
  withProfileKeys,
  worktreeInError
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

test('splitRestore: server windows come back; a window still on a .trekproj is not one, and its file is kept (4e)', () => {
  const entries = [
    { target: { kind: 'server', serverEntryId: 'local', projectId: 'p1' }, bounds },
    { target: { kind: 'file', path: '/never-imported.trekproj' } },
    { target: { kind: 'server', serverEntryId: 'e9', projectId: 'q' } }
  ]
  assert.deepEqual(splitRestore(entries), {
    windows: [entries[0], entries[2]],
    files: ['/never-imported.trekproj']
  })
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

// ---- Paths: the env profile key, sessions whose cwd moved, a worktree the server refused ----

const session = (id, agentSessionId, provider = 'claude') => ({ id, title: id, llm: { provider }, queue: [], status: 'idle', ...(agentSessionId ? { agentSessionId } : {}) })
const UUID1 = '11111111-1111-4111-8111-111111111111'
const UUID2 = '22222222-2222-4222-8222-222222222222'
const UUID3 = '33333333-3333-4333-8333-333333333333'
const project = (paths, extra = {}) => ({
  id: 'p',
  name: 'P',
  settings: {},
  globalSessions: extra.global ?? [],
  repositories: [
    {
      id: 'r1',
      name: 'app',
      path: paths.repo,
      branchData: {},
      ...(extra.environments ? { environments: extra.environments } : {}),
      worktrees: [
        { id: 'w1', name: 'app', path: paths.repo, isMain: true, loaded: false, sessions: [session('s1', UUID1)] },
        { id: 'w2', name: 'x', path: paths.x, isMain: false, loaded: false, sessions: [session('s2', UUID2), session('s3', 'codex-id', 'codex'), session('s4')] }
      ]
    }
  ]
})

test('isAgentSessionId takes only a UUID, so a file cannot name a path', () => {
  assert.equal(isAgentSessionId(UUID1), true)
  assert.equal(isAgentSessionId('../../.ssh/id_rsa'), false)
  assert.equal(isAgentSessionId(''), false)
  assert.equal(isAgentSessionId(undefined), false)
})

test('profileKeyFor: the path as the file had it, only when the server stores another', () => {
  assert.equal(profileKeyFor('/var/x/app', '/private/var/x/app'), '/var/x/app')
  assert.equal(profileKeyFor('/Users/me/app/', '/Users/me/app'), '/Users/me/app/')
  assert.equal(profileKeyFor('/Users/me/app', '/Users/me/app'), undefined)
})

test('withProfileKeys sets the key on repositories with environments, and keeps one already there', () => {
  const p = project({ repo: '/l/app', x: '/l/app-x' }, { environments: { enabled: true, cpu: 4 } })
  const keyed = withProfileKeys(p, new Map([['r1', '/l/app']]))
  assert.deepEqual(keyed.repositories[0].environments, { enabled: true, cpu: 4, profileKey: '/l/app' })
  assert.equal(p.repositories[0].environments.profileKey, undefined, 'the input is not changed')
  assert.deepEqual(withProfileKeys(keyed, new Map([['r1', '/other']])).repositories[0].environments.profileKey, '/l/app')
  // No environments: there are no VMs to keep, and none are made up.
  const plain = project({ repo: '/l/app', x: '/l/app-x' })
  assert.equal(withProfileKeys(plain, new Map([['r1', '/l/app']])).repositories[0].environments, undefined)
})

test("movedSessions: the sessions whose worktree the server stores at another path, Claude's kind only", () => {
  const sent = project({ repo: '/var/t/app', x: '/var/t/app-x' })
  const stored = project({ repo: '/private/var/t/app', x: '/private/var/t/app-x' })
  assert.deepEqual(movedSessions(sent, stored), [
    { worktree: 'app', from: '/var/t/app', to: '/private/var/t/app', agentSessionIds: [UUID1] },
    { worktree: 'x', from: '/var/t/app-x', to: '/private/var/t/app-x', agentSessionIds: [UUID2] }
  ])
  assert.deepEqual(movedSessions(sent, sent), [])
})

test("movedSessions: the Global panel's sessions run in the first repository's main worktree", () => {
  const sent = project({ repo: '/var/t/app', x: '/l/app-x' }, { global: [session('g', UUID3)] })
  const stored = project({ repo: '/private/var/t/app', x: '/l/app-x' }, { global: [session('g', UUID3)] })
  assert.deepEqual(movedSessions(sent, stored), [
    { worktree: 'app', from: '/var/t/app', to: '/private/var/t/app', agentSessionIds: [UUID1] },
    { worktree: 'Global', from: '/var/t/app', to: '/private/var/t/app', agentSessionIds: [UUID3] }
  ])
})

test('rekeyStoredOrder: every moved worktree keeps its place, whether or not it has sessions', () => {
  const order = ['r1 /var/t/app-x', 'r9 /elsewhere', 'r1 /var/t/app']
  const sent = { ...project({ repo: '/var/t/app', x: '/var/t/app-x' }), settings: { worktreeOrder: order } }
  // No sessions on the moved worktree: movedSessions would not list it, the order still follows it.
  sent.repositories[0].worktrees[1].sessions = []
  const stored = { ...project({ repo: '/private/var/t/app', x: '/private/var/t/app-x' }), settings: { worktreeOrder: order } }
  assert.deepEqual(movedSessions(sent, stored).map((m) => m.worktree), ['app'])
  assert.deepEqual(rekeyStoredOrder(sent, stored), ['r1 /private/var/t/app-x', 'r9 /elsewhere', 'r1 /private/var/t/app'])
})

test('rekeyStoredOrder: null when nothing moved, or there is no order to keep', () => {
  const order = ['r1 /l/app-x', 'r1 /l/app']
  const same = { ...project({ repo: '/l/app', x: '/l/app-x' }), settings: { worktreeOrder: order } }
  assert.equal(rekeyStoredOrder(same, same), null)
  const sent = project({ repo: '/var/t/app', x: '/var/t/app-x' })
  const stored = project({ repo: '/private/var/t/app', x: '/private/var/t/app-x' })
  assert.equal(rekeyStoredOrder(sent, stored), null)
  // Moved worktrees the order does not name: nothing to write.
  assert.equal(rekeyStoredOrder(sent, { ...stored, settings: { worktreeOrder: ['r9 /elsewhere'] } }), null)
})

test("rekeyStoredOrder: a sent path with a trailing or doubled slash matches the order's normalized key", () => {
  // The order's keys are normalized (rekeyOrder); the file's worktree paths may not be.
  const sent = project({ repo: '/var/t//app/', x: '/var/t/app-x/' })
  const stored = { ...project({ repo: '/private/var/t/app', x: '/private/var/t/app-x' }), settings: { worktreeOrder: ['r1 /var/t/app-x', 'r1 /var/t/app'] } }
  assert.deepEqual(rekeyStoredOrder(sent, stored), ['r1 /private/var/t/app-x', 'r1 /private/var/t/app'])
  // Stored at the normalized sent path: nothing moved.
  const same = { ...project({ repo: '/var/t/app', x: '/var/t/app-x' }), settings: { worktreeOrder: ['r1 /var/t/app-x', 'r1 /var/t/app'] } }
  assert.equal(rekeyStoredOrder(sent, same), null)
})

test('rekeyStoredOrder: a key two worktrees would now share is kept once, in its first place', () => {
  const sent = project({ repo: '/var/t/app', x: '/var/t/app-x' })
  const stored = { ...project({ repo: '/private/var/t/app', x: '/private/var/t/app-x' }), settings: { worktreeOrder: ['r1 /var/t/app-x', 'r1 /private/var/t/app-x', 'r1 /var/t/app'] } }
  assert.deepEqual(rekeyStoredOrder(sent, stored), ['r1 /private/var/t/app-x', 'r1 /private/var/t/app'])
})

test('worktreeInError finds the worktree a refusal names, never the main one, and the longest path wins', () => {
  const p = project({ repo: '/r/app', x: '/r/app-x' })
  p.repositories[0].worktrees.push({ id: 'w3', name: 'y', path: '/r/app-x2', isMain: false, loaded: false, sessions: [session('s5', UUID3)] })
  assert.deepEqual(worktreeInError(p, 'Path not under a configured root: /r/app-x'), { repoId: 'r1', worktreeId: 'w2' })
  assert.deepEqual(worktreeInError(p, 'project.repositories[0].worktrees[2]: worktree path /r/app-x2 is another repository (/r/z) or contains one'), { repoId: 'r1', worktreeId: 'w3' })
  assert.equal(worktreeInError(p, 'Path not under a configured root: /r/app'), null)
  assert.equal(worktreeInError(p, 'something else'), null)
})

test('dropWorktree takes the worktree out and says how many sessions went with it', () => {
  const p = project({ repo: '/r/app', x: '/r/app-x' })
  const { project: out, path, sessions } = dropWorktree(p, { repoId: 'r1', worktreeId: 'w2' })
  assert.deepEqual(out.repositories[0].worktrees.map((w) => w.id), ['w1'])
  assert.deepEqual([path, sessions], ['/r/app-x', 3])
  assert.equal(p.repositories[0].worktrees.length, 2, 'the input is not changed')
})

// ---- The result dialog ----------------------------------------------------------------------

const report = (extra = {}) => ({
  path: '/p/Proj.trekproj',
  key: '/p/Proj.trekproj',
  name: 'Proj',
  pieces: [],
  left: [],
  warnings: [],
  carried: 0,
  ...extra
})

test('importSummary: every piece landed', () => {
  const s = importSummary([report({ pieces: [piece('local', 'p1'), piece('srv', 'p2')], carried: 2 })])
  assert.equal(s.type, 'info')
  assert.equal(s.message, 'Imported “Proj”')
  assert.match(s.detail, /^“Proj” is now 2 projects: on Local and on Build\./)
  assert.match(s.detail, /2 sessions' history was copied to the path the server runs them in\./)
  assert.match(s.detail, /Not carried over: /)
  assert.match(s.detail, /The \.trekproj file was not changed\./)
})

test('importSummary: a part left, with its reason, and the warnings', () => {
  const s = importSummary([report({ pieces: [piece('local', 'p1')], left: [{ target: 'srv', label: 'build-box', reason: 'not added' }], warnings: ['w1'] })])
  assert.equal(s.type, 'warning')
  assert.equal(s.message, '“Proj” was imported in part')
  assert.match(s.detail, /“Proj” is now a project on Local\./)
  assert.match(s.detail, /Not imported: build-box — not added\. Open the file again to retry\./)
  assert.match(s.detail, /• w1/)
})

test('importSummary: nothing landed', () => {
  const s = importSummary([report({ left: [{ target: 'local', label: 'Local', reason: 'off' }] })])
  assert.deepEqual([s.type, s.message], ['error', '“Proj” could not be imported'])
  assert.doesNotMatch(s.detail, /Not carried over/)
})

test('importSummary: nothing landed says the file opens nowhere else, and that opening it again retries (4e)', () => {
  const s = importSummary([report({ left: [{ target: 'local', label: 'Local', reason: 'off' }] })])
  assert.match(s.detail, /Nothing was imported, and the file does not open on its own: fix what is listed, then open it again to try every part again\./)
})

test('importSummary: nothing landed, no part over the cap: no cap line', () => {
  const s = importSummary([report({ left: [{ target: 'local', label: 'Local', reason: 'off' }, { target: 's1', label: 'one', reason: 'down' }] })])
  assert.doesNotMatch(s.detail, /Opening it again tries/)
})

test('importSummary: nothing landed, with parts over the cap: a retry tries the same parts again (4d Note 12)', () => {
  const s = importSummary([report({ left: [{ target: 's1', label: 'one', reason: 'down' }, { target: 's21', label: 'twenty-one', reason: OVER_CAP_REASON }] })])
  assert.match(s.detail, /then open it again to try again\./)
  assert.doesNotMatch(s.detail, /try every part again/)
  // The file has no Local part: the line names none.
  assert.match(s.detail, new RegExp(`^Opening it again tries the first ${MAX_REMOTE_PIECES} servers' parts again; the others only once one of those has landed\\.$`, 'm'))
})

test("importSummary: nothing landed, over the cap, with a Local part: the cap line names Local's part", () => {
  const s = importSummary([report({ left: [{ target: 'local', label: 'Local', reason: 'off' }, { target: 's21', label: 'twenty-one', reason: OVER_CAP_REASON }] })])
  assert.match(s.detail, new RegExp(`^Opening it again tries Local's part and the first ${MAX_REMOTE_PIECES} servers' parts again; the others only once one of those has landed\\.$`, 'm'))
})

test('importSummary: a part landed: neither the nothing-imported line nor the cap line, even with a part over the cap', () => {
  const s = importSummary([report({ pieces: [piece('local', 'p1')], left: [{ target: 's21', label: 'twenty-one', reason: OVER_CAP_REASON }] })])
  assert.doesNotMatch(s.detail, /Nothing was imported/)
  assert.doesNotMatch(s.detail, /Opening it again tries/)
})

test('importSummary: several files, and one that could not be read', () => {
  const s = importSummary([report({ pieces: [piece('local', 'p1')] }), { path: '/p/Bad.trekproj', error: 'Unexpected token' }])
  assert.deepEqual([s.type, s.message], ['warning', 'Imported 1 of 2 projects'])
  assert.match(s.detail, /“Bad\.trekproj” could not be read: Unexpected token/)
})

// ---- Review fixes (Tasks 1–3) -------------------------------------------------------------

test('routePiece: an entry on the same origin under another path is another server, so the file\'s is offered', () => {
  const srv = { id: 'srv', name: 'build-box', url: 'wss://build.example:7777/a' }
  // The file's server has a path; the entry has another one, or none.
  assert.deepEqual(routePiece('srv', [srv], [{ id: 'e', name: 'B', url: 'wss://build.example:7777/b' }]), { kind: 'add', server: srv })
  assert.deepEqual(routePiece('srv', [srv], [{ id: 'e', name: 'Root', url: 'wss://build.example:7777' }]), { kind: 'add', server: srv })
  // The entry has a path; the file's server has none.
  const bare = { id: 'srv', name: 'build-box', url: 'wss://build.example:7777' }
  assert.deepEqual(routePiece('srv', [bare], [{ id: 'e', name: 'Sub', url: 'wss://build.example:7777/sub' }]), { kind: 'add', server: bare })
  // The same path (a trailing slash aside) is the same server.
  assert.deepEqual(routePiece('srv', [srv], [{ id: 'e', name: 'A', url: 'wss://build.example:7777/a/' }]), { kind: 'entry', entryId: 'e', name: 'A' })
  // Both bare, or "/": the origin is the server.
  const slash = { id: 'srv', name: 'build-box', url: 'wss://build.example:7777/' }
  assert.deepEqual(routePiece('srv', [slash], [{ id: 'e', name: 'B', url: 'wss://BUILD.example:7777' }]), { kind: 'entry', entryId: 'e', name: 'B' })
  assert.deepEqual(routePiece('srv', [bare], [{ id: 'e', name: 'B', url: 'wss://build.example:7777/' }]), { kind: 'entry', entryId: 'e', name: 'B' })
  // A default port is the same origin.
  assert.deepEqual(routePiece('srv', [{ id: 'srv', name: 'x', url: 'wss://build.example:443' }], [{ id: 'e', name: 'B', url: 'wss://build.example' }]), { kind: 'entry', entryId: 'e', name: 'B' })
})

test("routePiece: of two servers with the file's id, the first is the one (as a lookup by id finds it)", () => {
  const twice = [
    { id: 'srv', name: 'first', url: 'wss://one.example' },
    { id: 'srv', name: 'second', url: 'wss://two.example' }
  ]
  assert.deepEqual(routePiece('srv', twice, []), { kind: 'add', server: twice[0] })
  assert.deepEqual(routePiece('srv', twice, [{ id: 'e2', name: 'Two', url: 'wss://two.example' }]), { kind: 'add', server: twice[0] })
  assert.deepEqual(routePiece('srv', twice, [{ id: 'e1', name: 'One', url: 'wss://one.example' }]), { kind: 'entry', entryId: 'e1', name: 'One' })
})

test('routePiece: a user name or password in the file\'s URL matches the entry for that server, and is never added', () => {
  const creds = { id: 'srv', name: 'build-box', url: 'wss://me:secret@build.example:7777' }
  assert.deepEqual(routePiece('srv', [creds], [{ id: 'e', name: 'B', url: 'wss://build.example:7777' }]), { kind: 'entry', entryId: 'e', name: 'B' })
  const route = routePiece('srv', [creds], [])
  assert.equal(route.kind, 'unknown')
  assert.match(route.why, /user name or password/)
  assert.equal(route.label, 'build-box')
})

test('declineKey: a declined server is its origin and path', () => {
  assert.equal(declineKey({ id: 's', name: 'n', url: 'wss://b.example:7777/' }), 'wss://b.example:7777')
  assert.equal(declineKey({ id: 's', name: 'n', url: 'wss://b.example:7777/a' }), 'wss://b.example:7777/a')
  assert.equal(declineKey({ id: 's', name: 'n', url: 'nope' }), 'nope')
})

test('recordImport: a target that still has a piece is never left, and a target is left once', () => {
  let m = recordImport(parseMigrated(null), '/a', { attempted: ['local', 'srv'], pieces: [piece('local', 'p1'), piece('srv', 'p2')], left: [] })
  // Import Again: Local fails this time. Its earlier project stays, and it is not left.
  m = recordImport(m, '/a', { attempted: ['local', 'srv'], pieces: [piece('srv', 'p3')], left: [{ target: 'local', label: 'Local', reason: 'off' }] })
  assert.deepEqual(migratedFile(m, '/a'), { pieces: [piece('local', 'p1'), piece('srv', 'p3')], left: [] })
  // The same target twice in a run, and once from before: left once, the first reason kept.
  m = recordImport(parseMigrated(null), '/b', {
    attempted: ['local', 'srv'],
    pieces: [piece('local', 'p1')],
    left: [
      { target: 'srv', label: 'build-box', reason: 'one' },
      { target: 'srv', label: 'build-box', reason: 'two' }
    ]
  })
  assert.deepEqual(migratedFile(m, '/b').left, [{ target: 'srv', label: 'build-box', reason: 'one' }])
  m = recordImport(m, '/b', { attempted: ['other'], pieces: [], left: [{ target: 'other', label: 'o', reason: 'x' }, { target: 'srv', label: 'build-box', reason: 'three' }] })
  assert.deepEqual(migratedFile(m, '/b').left, [{ target: 'srv', label: 'build-box', reason: 'one' }, { target: 'other', label: 'o', reason: 'x' }])
})

test("movedSessions: Global sessions move from the file's first repository's path, which Local may not have kept", () => {
  // The file's first repository was refused on Local: the piece's first is another one.
  const sent = project({ repo: '/var/t/web', x: '/l/web-x' }, { global: [session('g', UUID3)] })
  const stored = project({ repo: '/private/var/t/web', x: '/l/web-x' }, { global: [session('g', UUID3)] })
  const global = movedSessions(sent, stored, '/var/t/gone-api').find((m) => m.worktree === 'Global')
  assert.deepEqual(global, { worktree: 'Global', from: '/var/t/gone-api', to: '/private/var/t/web', agentSessionIds: [UUID3] })
  // The raw path, a trailing slash and all: Claude filed the history under it.
  assert.equal(movedSessions(sent, stored, '/var/t/web/').find((m) => m.worktree === 'Global').from, '/var/t/web/')
  // Already where the server runs them: nothing to move.
  assert.equal(movedSessions(sent, stored, '/private/var/t/web').find((m) => m.worktree === 'Global'), undefined)
})

test("worktreeInError: only the path the server's message is about counts, not the repository it names", () => {
  const p = project({ repo: '/r/app', x: '/r/app-x' })
  // A worktree at another registered repository's path: the clash names /r/app-x/sub, which is longer.
  p.repositories[0].worktrees.push({ id: 'w3', name: 'sub', path: '/r/app-x/sub', isMain: false, loaded: false, sessions: [] })
  // As server/src/projects/model.ts words it.
  const clash = 'project.repositories[0].worktrees[1]: worktree path /r/app-x is another repository (/r/app-x/sub) or contains one'
  assert.deepEqual(worktreeInError(p, clash), { repoId: 'r1', worktreeId: 'w2' })
  // As server/src/paths.ts words it.
  assert.deepEqual(worktreeInError(p, 'Path not under a configured root: /r/app-x/sub'), { repoId: 'r1', worktreeId: 'w3' })
  assert.deepEqual(worktreeInError(p, 'Path not under a configured root: /r/app-x'), { repoId: 'r1', worktreeId: 'w2' })
  // A path the message is about that no worktree has: nothing is dropped.
  assert.equal(worktreeInError(p, 'Path not under a configured root: /r/app-x/s'), null)
  assert.equal(worktreeInError(p, 'project.repositories[0].worktrees[1]: worktree path /elsewhere is another repository (/r/app-x) or contains one'), null)
  // Paths with spaces.
  const q = project({ repo: '/r/my app', x: '/r/my app x' })
  assert.deepEqual(worktreeInError(q, 'x: worktree path /r/my app x is another repository (/r/my app) or contains one'), { repoId: 'r1', worktreeId: 'w2' })
})

test("a profileKey in the file is dropped; only the importer sets one, from the file's path and the realpath", async () => {
  const { importProjectFile } = await import('../src/shared/model/importProject.ts')
  let n = 0
  const newId = () => `id${++n}`
  const crafted = {
    version: 3,
    name: 'Crafted',
    repositories: [{ id: 'a', name: 'a', path: '/var/t/app', environments: { enabled: true, cpu: 2, profileKey: '/Users/victim/other' }, worktrees: [] }]
  }
  const [piece] = importProjectFile(crafted, newId).projects
  const repo = piece.project.repositories[0]
  assert.deepEqual(repo.environments, { enabled: true, cpu: 2 })
  assert.equal(crafted.repositories[0].environments.profileKey, '/Users/victim/other', 'the file is not changed')
  // The importer: the path as the file had it, since the server stores its realpath.
  const key = profileKeyFor(piece.sourcePaths[repo.id], '/private/var/t/app')
  const keyed = withProfileKeys(piece.project, new Map([[repo.id, key]]))
  assert.deepEqual(keyed.repositories[0].environments, { enabled: true, cpu: 2, profileKey: '/var/t/app' })
  // A realpath file: no key at all, whatever the file said.
  const [real] = importProjectFile({ ...crafted, repositories: [{ ...crafted.repositories[0], path: '/l/app' }] }, newId).projects
  assert.equal(profileKeyFor(real.sourcePaths[real.project.repositories[0].id], '/l/app'), undefined)
  assert.deepEqual(real.project.repositories[0].environments, { enabled: true, cpu: 2 })
})

test('capPieces: Local and the first 20 remote pieces are imported, the rest are over, in order', () => {
  assert.equal(MAX_REMOTE_PIECES, 20)
  const remote = Array.from({ length: 23 }, (_, i) => ({ target: `s${i + 1}` }))
  const { kept, over } = capPieces([...remote.slice(0, 5), { target: 'local' }, ...remote.slice(5)])
  assert.equal(kept.length, 21)
  assert.equal(kept[5].target, 'local', 'Local is never counted, wherever it is')
  assert.deepEqual(kept.filter((p) => p.target !== 'local').map((p) => p.target), remote.slice(0, 20).map((p) => p.target))
  assert.deepEqual(over.map((p) => p.target), ['s21', 's22', 's23'])
  assert.deepEqual(capPieces(remote.slice(0, 20)).over, [])
  assert.deepEqual(capPieces([{ target: 'local' }, { target: 'a' }, { target: 'b' }], 1), { kept: [{ target: 'local' }, { target: 'a' }], over: [{ target: 'b' }] })
  assert.match(OVER_CAP_REASON, /only 20 /)
})

test('runScope: a fresh scope per run unless the caller shares one; one address under many ids is one decline', () => {
  const a = runScope()
  const b = runScope({})
  assert.ok(a.declined instanceof Set && a.unreachable instanceof Map)
  assert.notEqual(a.declined, b.declined)
  assert.notEqual(a.unreachable, b.unreachable)
  const declined = new Set(['x'])
  const unreachable = new Map([['e1', 'down']])
  const shared = runScope({ declined, unreachable })
  assert.equal(shared.declined, declined)
  assert.equal(shared.unreachable, unreachable)
  assert.equal(runScope({ declined }).declined, declined)
  // Three server ids on one unsaved address: each routes to `add` with the same decline key.
  const servers = [
    { id: 's1', name: 'one', url: 'wss://box.example:7000' },
    { id: 's2', name: 'two', url: 'wss://box.example:7000/' },
    { id: 's3', name: 'three', url: 'wss://box.example:7000' }
  ]
  const keys = servers.map((s) => {
    const route = routePiece(s.id, servers, [])
    assert.equal(route.kind, 'add')
    return declineKey(route.server)
  })
  assert.equal(new Set(keys).size, 1)
})
