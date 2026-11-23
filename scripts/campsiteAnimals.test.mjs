// scripts/campsiteAnimals.test.mjs — the wildlife's sprites (campsite part 3d-2): one for every
// species, two frames of one size, on their grids.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ANIMAL_IDS, ANIMAL_SCALE, animalPixels, animalRows, animalSize, hasArt } from '../plugins/campsite/shared/animalPixels.ts'
import { SPECIES } from '../plugins/campsite/shared/wildlife.ts'

test('a sprite for every species and none other; two frames of one size, every row as wide, every rect on the grid in a #rrggbb colour', () => {
  assert.deepEqual([...ANIMAL_IDS].sort(), SPECIES.map((s) => s.id).sort())
  assert.equal(ANIMAL_SCALE, 3)
  for (const { id } of SPECIES) {
    assert.ok(hasArt(id))
    const { w, h } = animalSize(id)
    for (const frame of [0, 1]) {
      const rows = animalRows(id, frame)
      assert.equal(rows.length, h, `${id} ${frame}: ${h} rows`)
      assert.ok(rows.every((r) => r.length === w), `${id} ${frame}: every row ${w} wide`)
      const rects = animalPixels(id, frame)
      assert.ok(rects.length > 0)
      assert.ok(rects.every((r) => r.x >= 0 && r.y >= 0 && r.w > 0 && r.h === 1 && r.x + r.w <= w && r.y < h && /^#[0-9a-f]{6}$/.test(r.fill)), `${id} ${frame} on its grid`)
    }
    assert.notDeepEqual(animalRows(id, 1), animalRows(id, 0), `${id}: the two frames differ`)
  }
  assert.equal(hasArt('dragon'), false)
})

test('sizes: small animals about 10×8, deer and elk about 20×16, moose and bear about 24×18 (none over 24×18)', () => {
  const size = (id) => [animalSize(id).w, animalSize(id).h]
  assert.deepEqual(size('deer'), [20, 16])
  assert.deepEqual(size('elk'), [22, 17])
  assert.deepEqual(size('moose'), [24, 18])
  assert.deepEqual(size('bear'), [22, 14])
  for (const id of ['fox', 'rabbit', 'squirrel', 'chipmunk', 'raccoon', 'skunk', 'porcupine', 'marmot', 'duck', 'frog']) {
    const [w, h] = size(id)
    assert.ok(w <= 15 && h <= 10, `${id} ${w}×${h}`)
  }
  for (const { id } of SPECIES) {
    const [w, h] = size(id)
    assert.ok(w <= 24 && h <= 18, `${id} ${w}×${h}`)
  }
})

test('animalPixels: a row\'s runs of one letter are one rect; "." is nothing', () => {
  const rects = animalPixels('frog', 0)
  // '..KF.KF.' on row 0
  assert.deepEqual(rects.filter((r) => r.y === 0).map((r) => [r.x, r.w]), [[2, 1], [3, 1], [5, 1], [6, 1]])
  // 'FFFYYFFF' on row 2: three runs
  assert.deepEqual(rects.filter((r) => r.y === 2).map((r) => [r.x, r.w]), [[0, 3], [3, 2], [5, 3]])
})
