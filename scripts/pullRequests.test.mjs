// scripts/pullRequests.test.mjs — the PR provider contract's helpers (plugins P3): parsing, owning,
// labels and bare-number resolution through the providers on for a project; a provider that throws
// counts as no match.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePrWith, prLabel, prOwner, resolvePrInput } from '../src/shared/plugins/pullRequests.ts'

/** A made-up host: https://code.example/<repo>/pr/<n>. */
const example = {
  id: 'example',
  hint: 'an Example pull request link',
  signInName: 'example-cli',
  parse: (input) => {
    const m = input.match(/^https:\/\/code\.example\/([\w-]+)\/pr\/(\d+)$/)
    return m ? { url: `https://code.example/${m[1]}/pr/${m[2]}`, number: Number(m[2]), label: `!${m[2]}` } : null
  },
  owns: (url) => /^https:\/\/code\.example\//.test(url),
  fromNumber: (n, linked) => {
    const repo = linked.map((u) => u.match(/^https:\/\/code\.example\/([\w-]+)\//)?.[1]).find(Boolean)
    return repo ? { url: `https://code.example/${repo}/pr/${n}`, number: n, label: `!${n}` } : null
  }
}
const broken = { id: 'broken', hint: 'nothing', signInName: 'x', parse: () => { throw new Error('boom') }, owns: () => { throw new Error('boom') } }

test('parsePrWith: the first provider that parses and owns the input; a throwing one is skipped', () => {
  assert.deepEqual(parsePrWith([broken, example], ' https://code.example/app/pr/7 '), { url: 'https://code.example/app/pr/7', number: 7, label: '!7', providerId: 'example' })
  assert.equal(parsePrWith([example], 'https://elsewhere/app/pr/7'), null)
  assert.equal(parsePrWith([example], '   '), null)
})

test('prOwner and prLabel: the owner of a stored link; with none, the generic #n / PR label', () => {
  assert.equal(prOwner([broken, example], 'https://code.example/app/pr/7')?.id, 'example')
  assert.equal(prOwner([example], 'https://other/x/pull/3'), undefined)
  assert.equal(prLabel([example], 'https://other/x/pull/3'), '#3')
  assert.equal(prLabel([example], 'https://other/x'), 'PR')
  // An owned link's label is its provider's (parse(url).label), not the generic one.
  assert.equal(prLabel([example], 'https://code.example/app/pr/7'), '!7')
})

test('resolvePrInput: a link, a bare number through fromNumber, and the providers\' hints when nothing takes it', () => {
  assert.deepEqual(resolvePrInput([example], 'https://code.example/app/pr/7', []), { ok: true, pr: { url: 'https://code.example/app/pr/7', number: 7, label: '!7', providerId: 'example' } })
  assert.deepEqual(resolvePrInput([example], '#9', ['https://code.example/app/pr/7']), { ok: true, pr: { url: 'https://code.example/app/pr/9', number: 9, label: '!9', providerId: 'example' } })
  assert.deepEqual(resolvePrInput([example], '9', []), { ok: false, problem: 'Enter an Example pull request link, or a number once another pull request is linked in this repository.' })
  assert.deepEqual(resolvePrInput([], 'https://code.example/app/pr/7', []), { ok: false, problem: 'No pull request provider is on in this project (Settings → Plugins).' })
})
