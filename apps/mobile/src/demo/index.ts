// Try the demo (apps/mobile/src/demo): the phone's demo entry and the socket factory that sends
// its URL to the in-app demo server.
import type { SocketFactory } from '../shared.ts'
import { DemoServer, DEMO_SERVER_NAME } from './demoServer.ts'
import { DemoSocket } from './demoSocket.ts'

export { DemoServer, DEMO_SERVER_NAME } from './demoServer.ts'
export { DEMO_PROJECT_ID } from './demoData.ts'

export const DEMO_URL = 'demo:'
/** The phone's entry id for the demo (a SavedServer id; never saved) */
export const DEMO_SERVER_ID = 'demo'
export const DEMO_TOKEN = 'demo'
/** The demo's row in the server list (a SavedServer) */
export const DEMO_ENTRY = { id: DEMO_SERVER_ID, name: DEMO_SERVER_NAME, url: DEMO_URL }

export const isDemoUrl = (url: string): boolean => url === DEMO_URL

/** `demo:` to the demo server `demo()` answers, any other URL to `fallback` */
export function createDemoSocketFactory(fallback: SocketFactory, demo: () => DemoServer): SocketFactory {
  return (url) => {
    if (!isDemoUrl(url)) return fallback(url)
    const server = demo()
    return new DemoSocket(server, server.clock)
  }
}
