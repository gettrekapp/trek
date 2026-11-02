import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { addConsent, hasConsent, parseConsent, type ConsentEntry } from '../host/bot/consent.ts'

/** Per machine, so that it can't arrive inside a shared project or bot folder. */
function consentFile(): string {
  return join(app.getPath('userData'), 'bot-consent.json')
}

async function readEntries(): Promise<ConsentEntry[]> {
  try {
    return parseConsent(await readFile(consentFile(), 'utf8'))
  } catch {
    return []
  }
}

let last: Promise<unknown> = Promise.resolve()

/** One at a time, so that two windows can't lose each other's entries or read half a file. */
function inOrder<T>(step: () => Promise<T>): Promise<T> {
  const result = last.then(step, step)
  last = result
  return result
}

export const isConsented = (entry: ConsentEntry): Promise<boolean> =>
  inOrder(async () => hasConsent(await readEntries(), entry))

export const recordConsent = (entry: ConsentEntry): Promise<void> =>
  inOrder(async () => {
    await writeFile(consentFile(), JSON.stringify(addConsent(await readEntries(), entry), null, 2), 'utf8')
  })
