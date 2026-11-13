// `server.stop` from the CLI (`trek-server stop --local`): a WebSocket hello with the local token
// from local.json, then the request. stop --local is synchronous (it blocks while it waits for the
// server's files to go), so the socket runs on a worker thread and the CLI's thread waits on a
// shared slot (Atomics.wait) for the outcome.
import { Worker } from 'node:worker_threads'
import { PROTOCOL_VERSION_V2 } from '../../src/shared/protocolV2.ts'

/** accepted: the server answered ok and is shutting down; refused: it answered with an error; unreachable: no answer in time */
export type StopRequestResult = 'accepted' | 'refused' | 'unreachable'

export const STOP_REQUEST_TIMEOUT_MS = 3000

const RESULTS: readonly StopRequestResult[] = ['accepted', 'refused', 'unreachable']

// CommonJS, run with `eval: true`. Global WebSocket: Node >= 22 (and Electron's Node).
const WORKER = `
const { workerData } = require('node:worker_threads')
const { url, token, protocolVersion, slot } = workerData
const view = new Int32Array(slot)
const done = (code) => {
  if (Atomics.compareExchange(view, 0, 0, code) === 0) Atomics.notify(view, 0)
  try { socket && socket.close() } catch {}
}
let socket
if (typeof WebSocket !== 'function') done(3)
else {
  try {
    socket = new WebSocket(url)
  } catch {
    done(3)
  }
  if (socket) {
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'hello', protocolVersion, token, client: 'trek-server-cli', clientVersion: '0' }))
    })
    socket.addEventListener('message', (event) => {
      let frame
      try { frame = JSON.parse(String(event.data)) } catch { return }
      if (frame.type === 'welcome') socket.send(JSON.stringify({ type: 'req', id: 1, method: 'server.stop', params: {} }))
      else if (frame.type === 'res' && frame.id === 1) done(frame.ok ? 1 : 2)
    })
    socket.addEventListener('close', () => done(3))
    socket.addEventListener('error', () => done(3))
  }
}
`

/** Asks the local server on 127.0.0.1:`port` to stop; blocks until it answers, or `timeoutMs`. */
export function requestStopSync(port: number, token: string, timeoutMs = STOP_REQUEST_TIMEOUT_MS): StopRequestResult {
  const slot = new SharedArrayBuffer(4)
  const view = new Int32Array(slot)
  let worker: Worker
  try {
    worker = new Worker(WORKER, { eval: true, workerData: { url: `ws://127.0.0.1:${port}`, token, protocolVersion: PROTOCOL_VERSION_V2, slot } })
  } catch {
    return 'unreachable'
  }
  worker.unref()
  // A worker that throws leaves the slot at 0: the wait runs out and the answer is unreachable.
  // The listener only keeps that error from being an uncaught one.
  worker.on('error', () => {})
  Atomics.wait(view, 0, 0, timeoutMs)
  void worker.terminate()
  const code = Atomics.load(view, 0)
  return code === 0 ? 'unreachable' : RESULTS[code - 1]
}
