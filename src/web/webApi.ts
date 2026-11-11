// The web client's `window.api` (5c-3): what the Electron window's preload
// gives the renderer, made in the page. The renderer's v2 window code runs
// unchanged on top of it:
//   - v2Socket: the browser's own WebSocket to this page's server (browserRelay.ts);
//     the session cookie signs it in, so no token is ever in the page;
//   - appServers: one entry, the page's server (WEB_ENTRY_ID), never editable;
//   - attention: main's aggregator (src/main/attention.ts, pure) over the page's
//     one connection; opening an entry selects it in the page;
//   - dialogs: in-page modals (dialogs.tsx);
//   - app settings: kept in this browser (localStorage), nothing secret;
//   - everything that needs this machine (folders, Finder, VS Code, the Local
//     server, .trekproj files, the bot) is refused: its features are off for a
//     non-Local entry, so the UI does not offer it.
import { createAttention, type AttentionSource } from '../main/attention.ts'
import { dismissRequest } from '../main/attentionRules.ts'
import { DEFAULT_APP_SETTINGS, parseAppSettings, type AppSettings } from '../shared/appSettings.ts'
import { mergeLlmSettings } from '../shared/providers/settings.ts'
import { DEFAULT_LLM_SETTINGS, type LlmSettings } from '../shared/providers/types.ts'
import type { AppServerLink, AppServersChanged, AttentionChanged, AttentionItem } from '../shared/types.ts'
import type { RendererApi } from '../preload/index'
import { browserRelay, socketUrl, type BrowserSocketClass } from './browserRelay.ts'
import { cancelDialogById, webDialogs } from './dialogQueue.ts'

/** The page's one server entry: the server that served it. */
export const WEB_ENTRY_ID = 'web'

const APP_SETTINGS_KEY = 'trek.appSettings'
const NOT_HERE = 'Not available in the browser'

/** What the page shell (WebApp.tsx) does for the api: it knows the store and the routes. */
export interface WebHooks {
  /** Show an attention entry: its project in this page, then its session */
  openAttention(item: AttentionItem): void
  /** Back to the projects list */
  leaveProject(): void
  /** Open a project of this server in the page */
  openProject(projectId: string): void
  /** The project's name for the tab title, or null */
  title(name: string | null): void
}

/** What the shell gives the api once its connection exists. */
export interface WebConnection extends AttentionSource {
  connection: AttentionSource['connection'] & {
    request(method: string, params: unknown): Promise<unknown>
  }
}

export interface WebApi {
  api: RendererApi
  /** The shell's callbacks (set once it mounts) */
  hooks: Partial<WebHooks>
  /** The page's connection: attention follows it, dismissals go through it */
  link(connection: WebConnection, serverName: () => string): void
  /** The server's name changed (its welcome): the entry and attention relabel */
  relabel(): void
}

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function readAppSettings(): AppSettings {
  try {
    const raw = storage()?.getItem(APP_SETTINGS_KEY)
    return raw ? parseAppSettings(JSON.parse(raw)) : { ...DEFAULT_APP_SETTINGS }
  } catch {
    return { ...DEFAULT_APP_SETTINGS }
  }
}

const refuse = (): Promise<never> => Promise.reject(new Error(NOT_HERE))
const none = (): (() => void) => () => {}

export function createWebApi(Socket: BrowserSocketClass = WebSocket as unknown as BrowserSocketClass): WebApi {
  const hooks: Partial<WebHooks> = {}

  // ---- The page's server, as the one app-server entry ----
  let serverName = (): string => ''
  let linkSeq = 0
  const linkListeners = new Set<(s: AppServersChanged) => void>()
  const entry = (): AppServerLink => ({
    id: WEB_ENTRY_ID,
    name: serverName() || 'This server',
    url: '',
    hasToken: true,
    // No main here to keep a second connection: the window's own one is the only status.
    status: null,
    message: ''
  })
  const links = (): AppServersChanged => ({ seq: linkSeq, servers: [entry()] })

  // ---- Attention, over the page's connection ----
  let attentionSeq = 0
  const attentionListeners = new Set<(s: AttentionChanged) => void>()
  let latest: AttentionChanged = { seq: 0, items: [] }
  let connection: WebConnection | null = null
  const attention = createAttention({
    serverName: () => entry().name,
    changed: (snapshot) => {
      latest = { ...snapshot, seq: ++attentionSeq }
      for (const l of [...attentionListeners]) l(latest)
    },
    // No OS notifications from a page: the bell lists what came up.
    raised: () => {}
  })

  // ---- This browser's app settings (voice Active/Busy, the notification switch) ----
  let appSettings = readAppSettings()
  const appSettingsListeners = new Set<(s: AppSettings) => void>()

  let llm: LlmSettings = DEFAULT_LLM_SETTINGS

  const api: RendererApi = {
    openProjectPath: refuse,
    importTrekproj: refuse,
    getRecentProjects: async () => [],
    removeRecentProject: async () => [],
    openServerProject: async (_entryId, projectId) => {
      hooks.openProject?.(projectId)
      return { opened: false }
    },
    onShowServer: none,
    reportTitle: (name) => hooks.title?.(name),
    releaseTarget: async () => hooks.leaveProject?.(),
    takeInitialWindowState: async () => ({ menu: null, server: null, select: null }),
    onWindowCloseRequest: none,
    windowCloseReady: () => {},
    windowCloseBusy: () => {},
    selectDirectory: async () => null,
    openInVSCode: refuse,
    revealInFinder: refuse,
    getAlertSound: async () => null,
    // A pull request's head branch: the worktree falls back to pr/<n> (no gh in the browser).
    githubPrHeadBranch: async () => null,
    llmGetSettings: async () => llm,
    llmUpdateSettings: async (patch) => (llm = mergeLlmSettings(llm, patch)),
    onLlmSettingsChanged: none,
    llmFetchModels: refuse,
    appServers: {
      list: async () => [{ id: WEB_ENTRY_ID, name: entry().name, url: '', hasToken: true }],
      save: refuse,
      setToken: refuse,
      remove: refuse,
      test: refuse,
      links: async () => links(),
      onChanged: (cb) => {
        linkListeners.add(cb)
        return () => linkListeners.delete(cb)
      }
    },
    localServer: { start: refuse, restart: refuse, reset: refuse },
    appSettings: {
      get: async () => appSettings,
      update: async (patch) => {
        appSettings = parseAppSettings(patch, appSettings)
        try {
          storage()?.setItem(APP_SETTINGS_KEY, JSON.stringify(appSettings))
        } catch {
          // a private window: kept for this page only
        }
        for (const l of [...appSettingsListeners]) l(appSettings)
        return appSettings
      },
      onChanged: (cb) => {
        appSettingsListeners.add(cb)
        return () => appSettingsListeners.delete(cb)
      }
    },
    attention: {
      list: async () => latest,
      onChanged: (cb) => {
        attentionListeners.add(cb)
        return () => attentionListeners.delete(cb)
      },
      open: async (key) => {
        const item = attention.find(key)
        if (!item) return false
        hooks.openAttention?.(item)
        return true
      },
      // The page selects for itself (open, above): nothing comes from outside.
      onSelect: none,
      dismiss: async (key) => {
        const item = attention.find(key)
        if (!item || !connection) throw new Error('That entry is no longer listed')
        const { method, params } = dismissRequest(item)
        await connection.connection.request(method, params)
      },
      viewing: () => {},
      onAlert: none
    },
    v2Socket: browserRelay(() => socketUrl(window.location), Socket),
    confirm: (opts) => webDialogs.confirm(opts),
    confirmWithCheckbox: (opts) => webDialogs.confirmWithCheckbox(opts),
    showError: (title, message) => webDialogs.showError(title, message),
    cancelDialog: async (dialogId) => cancelDialogById(dialogId),
    onMenu: none
  }

  const relabel = (): void => {
    linkSeq++
    const snapshot = links()
    for (const l of [...linkListeners]) l(snapshot)
    attention.relabel()
  }

  return {
    api,
    hooks,
    link: (c, name) => {
      connection = c
      serverName = name
      attention.linked(WEB_ENTRY_ID, c)
      relabel()
    },
    relabel
  }
}
