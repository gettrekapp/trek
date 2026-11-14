// scripts/windowRules.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_LABEL_LENGTH, MAX_TARGET_ID, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, arrangeTiles, boundsOnScreen, gridRows, isTargetId, capLabel, decideOpen, initialFromTarget, parseOpenWindows, routeSelect, sameTarget, serializeOpenWindow } from '../src/main/windowRules.ts'

test('an open project is focused, whatever the sender holds', () => {
  assert.equal(decideOpen(true, true), 'focus-existing')
  assert.equal(decideOpen(false, true), 'focus-existing')
})

test('a project opens in the sender only when the sender is empty', () => {
  assert.equal(decideOpen(false, false), 'use-sender')
  assert.equal(decideOpen(true, false), 'new-window')
})

test('parseOpenWindows drops bad entries and duplicates', () => {
  const bounds = { x: 1, y: 2, width: 3, height: 4 }
  assert.deepEqual(
    parseOpenWindows([
      { filePath: '/a', bounds },
      { filePath: '/a' },
      { filePath: '/b', bounds: { x: 'no' } },
      { filePath: 7 },
      null
    ]),
    [{ target: { kind: 'file', path: '/a' }, bounds }, { target: { kind: 'file', path: '/b' } }]
  )
})

test('parseOpenWindows treats a non-array as nothing to restore', () => {
  assert.deepEqual(parseOpenWindows({ filePath: '/a' }), [])
  assert.deepEqual(parseOpenWindows(null), [])
})

test('boundsOnScreen needs an overlap with some display', () => {
  const displays = [
    { x: 0, y: 0, width: 1000, height: 800 },
    { x: 1000, y: 0, width: 500, height: 500 }
  ]
  assert.equal(boundsOnScreen({ x: 1200, y: 100, width: 100, height: 100 }, displays), true)
  assert.equal(boundsOnScreen({ x: 3000, y: 0, width: 100, height: 100 }, displays), false)
  assert.equal(boundsOnScreen({ x: 1000, y: 0, width: 100, height: 100 }, [displays[0]]), false)
})

test('sameTarget compares file paths and server ids', () => {
  assert.equal(sameTarget({ kind: 'file', path: '/a.trekproj' }, { kind: 'file', path: '/a.trekproj' }), true)
  assert.equal(sameTarget({ kind: 'file', path: '/a.trekproj' }, { kind: 'file', path: '/b.trekproj' }), false)
  assert.equal(sameTarget({ kind: 'server', serverEntryId: 's', projectId: 'p' }, { kind: 'server', serverEntryId: 's', projectId: 'p' }), true)
  assert.equal(sameTarget({ kind: 'server', serverEntryId: 's', projectId: 'p' }, { kind: 'server', serverEntryId: 's', projectId: 'q' }), false)
  assert.equal(sameTarget({ kind: 'file', path: 'p' }, { kind: 'server', serverEntryId: 's', projectId: 'p' }), false)
})

test('parseOpenWindows reads legacy file entries and server entries', () => {
  assert.deepEqual(parseOpenWindows([
    { filePath: '/a.trekproj', bounds: { x: 1, y: 2, width: 3, height: 4 } },
    { kind: 'server', serverEntryId: 's1', projectId: 'p1' },
    { kind: 'server', serverEntryId: 's1', projectId: 'p1' },
    { kind: 'server', serverEntryId: '', projectId: 'p2' },
    { kind: 'server', serverEntryId: 's1' },
    { kind: 'file', path: '/b.trekproj' }
  ]), [
    { target: { kind: 'file', path: '/a.trekproj' }, bounds: { x: 1, y: 2, width: 3, height: 4 } },
    { target: { kind: 'server', serverEntryId: 's1', projectId: 'p1' } },
    { target: { kind: 'file', path: '/b.trekproj' } }
  ])
})

test('serializeOpenWindow writes a server window, with its bounds', () => {
  assert.deepEqual(serializeOpenWindow({ target: { kind: 'server', serverEntryId: 's', projectId: 'p' }, bounds: { x: 0, y: 0, width: 1, height: 1 } }), { kind: 'server', serverEntryId: 's', projectId: 'p', bounds: { x: 0, y: 0, width: 1, height: 1 } })
  assert.deepEqual(serializeOpenWindow({ target: { kind: 'server', serverEntryId: 's', projectId: 'p' } }), { kind: 'server', serverEntryId: 's', projectId: 'p' })
})

test('initialFromTarget hands the server ids, or null for an empty window', () => {
  assert.equal(initialFromTarget(null), null)
  assert.deepEqual(initialFromTarget({ kind: 'server', serverEntryId: 's', projectId: 'p' }), { serverEntryId: 's', projectId: 'p' })
})

test('capLabel coerces to a string and caps its length', () => {
  assert.equal(capLabel('box'), 'box')
  assert.equal(capLabel(''), '')
  assert.equal(capLabel(undefined), '')
  assert.equal(capLabel(null), '')
  assert.equal(capLabel(42), '42')
  assert.equal(capLabel('x'.repeat(500)).length, MAX_LABEL_LENGTH)
})

test('isTargetId takes non-empty strings up to MAX_TARGET_ID characters', () => {
  assert.equal(MAX_TARGET_ID, 200)
  assert.equal(isTargetId('s'), true)
  assert.equal(isTargetId('x'.repeat(200)), true)
  assert.equal(isTargetId('x'.repeat(201)), false)
  assert.equal(isTargetId(''), false)
  assert.equal(isTargetId(5), false)
})

test('parseOpenWindows drops server entries with over-long ids', () => {
  const long = 'x'.repeat(201)
  assert.deepEqual(parseOpenWindows([
    { kind: 'server', serverEntryId: long, projectId: 'p' },
    { kind: 'server', serverEntryId: 's', projectId: long },
    { kind: 'server', serverEntryId: 'x'.repeat(200), projectId: 'p' }
  ]), [{ target: { kind: 'server', serverEntryId: 'x'.repeat(200), projectId: 'p' } }])
})

test('a session select goes to a listening window, waits for a loading one, or opens one', () => {
  assert.equal(routeSelect({ rendererReady: true }), 'send')
  assert.equal(routeSelect({ rendererReady: false }), 'queue')
  assert.equal(routeSelect(undefined), 'open')
})

// ---- Arrange Windows ---------------------------------------------------------------------------

/** `count` windows stacked on one spot: ids 1..count, each a little lower so their order is defined. */
const pile = (count) => Array.from({ length: count }, (_, i) => ({ id: i + 1, bounds: { x: 10, y: 10 + i, width: 900, height: 600 } }))
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
const area = (b) => b.width * b.height

test('gridRows: rows and columns as equal as possible, more columns on a landscape display', () => {
  const landscape = [[1], [2], [2, 1], [2, 2], [3, 2], [3, 3], [3, 2, 2], [3, 3, 2], [3, 3, 3]]
  const portrait = [[1], [1, 1], [2, 1], [2, 2], [2, 2, 1], [2, 2, 2], [3, 2, 2], [3, 3, 2], [3, 3, 3]]
  landscape.forEach((rows, i) => assert.deepEqual(gridRows(i + 1, true), rows, `landscape ${i + 1}`))
  portrait.forEach((rows, i) => assert.deepEqual(gridRows(i + 1, false), rows, `portrait ${i + 1}`))
  assert.deepEqual(gridRows(0, true), [])
  assert.deepEqual(gridRows(10, true), [4, 3, 3])
})

test('arrangeTiles: four windows make a 2x2 grid', () => {
  const tiles = arrangeTiles({ x: 0, y: 25, width: 1440, height: 875 }, [
    { id: 1, bounds: { x: 900, y: 500, width: 900, height: 600 } }, // bottom right
    { id: 2, bounds: { x: 0, y: 30, width: 900, height: 600 } }, // top left
    { id: 3, bounds: { x: 500, y: 40, width: 900, height: 600 } }, // top right
    { id: 4, bounds: { x: 20, y: 400, width: 900, height: 600 } } // bottom left
  ])
  assert.deepEqual(Object.fromEntries(tiles), {
    2: { x: 0, y: 25, width: 720, height: 438 },
    3: { x: 720, y: 25, width: 720, height: 438 },
    4: { x: 0, y: 463, width: 720, height: 437 },
    1: { x: 720, y: 463, width: 720, height: 437 }
  })
})

test('arrangeTiles: the tiles cover the work area exactly, with no overlap, for 1 to 9 windows', () => {
  for (const work of [{ x: 0, y: 0, width: 2560, height: 1415 }, { x: -1440, y: 0, width: 1440, height: 2535 }]) {
    for (let n = 1; n <= 9; n++) {
      const tiles = [...arrangeTiles(work, pile(n)).values()]
      assert.equal(tiles.length, n)
      assert.equal(tiles.reduce((sum, t) => sum + area(t), 0), area(work), `${n} windows cover ${work.width}x${work.height}`)
      for (const t of tiles) {
        assert.ok(t.x >= work.x && t.y >= work.y && t.x + t.width <= work.x + work.width && t.y + t.height <= work.y + work.height, 'inside the work area')
        assert.ok(t.width >= MIN_WINDOW_WIDTH && t.height >= MIN_WINDOW_HEIGHT, 'no smaller than the minimum')
      }
      tiles.forEach((a, i) => tiles.slice(i + 1).forEach((b) => assert.equal(overlaps(a, b), false, `${n} windows do not overlap`)))
    }
  }
})

test('arrangeTiles: a work area off the origin whose size does not divide evenly', () => {
  const tiles = arrangeTiles({ x: 1440, y: -200, width: 1001, height: 701 }, pile(3))
  assert.deepEqual([...tiles.values()], [
    { x: 1440, y: -200, width: 501, height: 351 },
    { x: 1941, y: -200, width: 500, height: 351 },
    { x: 1440, y: 151, width: 1001, height: 350 }
  ])
})

test('arrangeTiles: tiles that would be under the minimum overlap evenly at the minimum', () => {
  const work = { x: 0, y: 0, width: 1440, height: 900 }
  const tiles = [...arrangeTiles(work, pile(10)).values()]
  // Rows of 4 + 3 + 3; rows would be 300 high, the first row's tiles 360 wide.
  assert.deepEqual(tiles.map((t) => [t.x, t.y, t.width, t.height]), [
    [0, 0, 480, 320], [320, 0, 480, 320], [640, 0, 480, 320], [960, 0, 480, 320],
    [0, 290, 480, 320], [480, 290, 480, 320], [960, 290, 480, 320],
    [0, 580, 480, 320], [480, 580, 480, 320], [960, 580, 480, 320]
  ])
})

test('arrangeTiles: arranging what it returned changes nothing', () => {
  for (const work of [{ x: 0, y: 25, width: 1440, height: 875 }, { x: 0, y: 0, width: 1080, height: 1920 }]) {
    for (const n of [2, 3, 5, 7, 10]) {
      const once = arrangeTiles(work, pile(n))
      const twice = arrangeTiles(work, [...once].map(([id, bounds]) => ({ id, bounds })))
      assert.deepEqual(Object.fromEntries(twice), Object.fromEntries(once), `${n} windows`)
    }
  }
})

test('arrangeTiles: no windows, no tiles', () => {
  assert.equal(arrangeTiles({ x: 0, y: 0, width: 1440, height: 900 }, []).size, 0)
})

test('a hidden sidebar is recorded with its window, and only when hidden', () => {
  const target = { kind: 'server', serverEntryId: 's', projectId: 'p' }
  assert.deepEqual(serializeOpenWindow({ target, sidebarHidden: true }), { kind: 'server', serverEntryId: 's', projectId: 'p', sidebarHidden: true })
  assert.deepEqual(serializeOpenWindow({ target }), { kind: 'server', serverEntryId: 's', projectId: 'p' })
  const bounds = { x: 0, y: 0, width: 1, height: 1 }
  assert.deepEqual(parseOpenWindows([serializeOpenWindow({ target, bounds, sidebarHidden: true })]), [{ target, bounds, sidebarHidden: true }])
})

test('parseOpenWindows takes only a literal true as a hidden sidebar', () => {
  // A project each: parseOpenWindows keeps one entry per target.
  const entry = (sidebarHidden, i) => ({ kind: 'server', serverEntryId: 's', projectId: `p${i}`, sidebarHidden })
  const parsed = parseOpenWindows([true, false, 'true', 1, null].map(entry))
  assert.deepEqual(parsed.map((e) => e.sidebarHidden), [true, undefined, undefined, undefined, undefined])
  assert.deepEqual(parsed.slice(1).map((e) => 'sidebarHidden' in e), [false, false, false, false])
})

test('arrangeTiles: a row is filled left to right by where its windows’ centres are', () => {
  const tiles = arrangeTiles({ x: 0, y: 0, width: 1440, height: 900 }, [
    // Wide, so its left edge is the leftmost but its centre is to the right of the next window's.
    { id: 1, bounds: { x: 50, y: 0, width: 1900, height: 200 } },
    { id: 2, bounds: { x: 100, y: 50, width: 200, height: 200 } },
    { id: 3, bounds: { x: 600, y: 700, width: 200, height: 200 } }
  ])
  assert.deepEqual(Object.fromEntries(tiles), {
    2: { x: 0, y: 0, width: 720, height: 450 },
    1: { x: 720, y: 0, width: 720, height: 450 },
    3: { x: 0, y: 450, width: 1440, height: 450 }
  })
})

test('arrangeTiles: windows level with each other fill the rows left to right', () => {
  const at = (x) => ({ x, y: 100, width: 200, height: 200 })
  const tiles = arrangeTiles({ x: 0, y: 0, width: 1440, height: 900 }, [{ id: 1, bounds: at(700) }, { id: 2, bounds: at(1100) }, { id: 3, bounds: at(0) }])
  assert.deepEqual(Object.fromEntries(tiles), {
    3: { x: 0, y: 0, width: 720, height: 450 },
    1: { x: 720, y: 0, width: 720, height: 450 },
    2: { x: 0, y: 450, width: 1440, height: 450 }
  })
})

test('arrangeTiles: two windows are stacked on a portrait display, side by side on a square or landscape one', () => {
  assert.deepEqual([...arrangeTiles({ x: 0, y: 0, width: 1080, height: 1920 }, pile(2)).values()], [
    { x: 0, y: 0, width: 1080, height: 960 },
    { x: 0, y: 960, width: 1080, height: 960 }
  ])
  assert.deepEqual([...arrangeTiles({ x: 0, y: 0, width: 1000, height: 1000 }, pile(2)).values()], [
    { x: 0, y: 0, width: 500, height: 1000 },
    { x: 500, y: 0, width: 500, height: 1000 }
  ])
})

test('arrangeTiles: tiles of exactly the minimum size abut', () => {
  const tiles = [...arrangeTiles({ x: 0, y: 0, width: 1440, height: 640 }, pile(6)).values()]
  assert.deepEqual(tiles.map((t) => [t.x, t.y, t.width, t.height]), [
    [0, 0, 480, 320], [480, 0, 480, 320], [960, 0, 480, 320],
    [0, 320, 480, 320], [480, 320, 480, 320], [960, 320, 480, 320]
  ])
})

test('arrangeTiles: on a work area smaller than the minimum, tiles start at its corner', () => {
  const work = { x: 0, y: 0, width: 400, height: 300 }
  assert.deepEqual([...arrangeTiles(work, pile(1)).values()], [work])
  // Two windows: each is the minimum width (the window would not go narrower), neither starts off the display.
  assert.deepEqual([...arrangeTiles(work, pile(2)).values()].map((t) => [t.x, t.y, t.width]), [[0, 0, 480], [0, 0, 480]])
})
