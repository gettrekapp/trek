# Example theme

The reference theme plugin, and the fixture Trek's tests install. It is not built into Trek: it is
installed on a server like any other theme.

## What a theme is

A theme is a client plugin whose manifest says `"type": "theme"`. Its bundle's default export is a
`ClientPlugin` (`src/shared/plugins/client.ts`) with:

- `theme.styles`: CSS the window injects after its own stylesheet while the theme is active. The
  window also sets `<html data-theme="<id>">`, so scope every rule with
  `:root[data-theme='<id>']`.
- optionally `Runtime` and `slots.overlay`: React components mounted while the theme is active,
  inside the plugin's host. A theme's other slots are ignored. Its host has no server half:
  `request` rejects and `onEvent` never fires; `prefs` works.

**The supported styling surface is the CSS variables on `:root`:** `--bg`, `--bg-darker`,
`--bg-lighter`, `--panel`, `--surface`, `--border`, `--border-strong`, `--text`, `--text-muted`,
`--accent`, `--attention`, `--decision`, `--done`, `--done-soft`, `--danger`, `--mono`. Trek's class
names may change between releases; a theme that targets them may break.

A project's own appearance (title bar color, logo, banner) still applies on top of a theme. The
native title bar is not recolored.

## Rules for a theme's code

- Keep side effects inside `Runtime`'s effects, and undo them in the effect's cleanup. Anything a bundle
  does at its top level (timers, listeners, globals) is never undone when the theme stops being
  active.
- The bundle's module may not export `then`: such a bundle is refused.
- The bundle must finish loading within 15 seconds, top-level `await`s included.
- The build refuses an import by a bare name (a package, a Node built-in, a path alias) other
  than `react` and `react/jsx-runtime`. An import by a path, relative (`./`, `../`) or absolute
  (`/…`), is not refused: the file is bundled into the theme, whatever it is, except the plugin
  contract (`…/shared/plugins/client`), which like React is shared with the window.
- `theme.styles` must be a string, and `Runtime` and `slots.overlay` React components, where
  present: a function, or a component wrapped in `React.memo`, `React.forwardRef` or `React.lazy`.
  The window reads them once, when the bundle loads.
- In the web client, themes need a secure context (https or localhost): the page must be able to
  compute SHA-256 to check a bundle.

## Build and install

    npm run build:example-theme
    trek-server plugin add plugins/example-theme/dist/example-theme.trekplugin

Add `--local` to install it on the Trek app's Local server. A running server notices the change.
Then, in a project window: Settings → General → Appearance → Theme.

Or install the built file from the app: Settings → General → Appearance → Installed themes →
Install from file…, and pick `plugins/example-theme/dist/example-theme.trekplugin`.

The choice is this app's, per server and project: other clients of the project are unaffected. If
the theme's bundle later changes on the server, the window returns to the default look until you
click Apply in Settings.

## How the build works

`build.mjs` bundles `client/index.ts` with esbuild into one ES module with no imports. `react`,
`react/jsx-runtime` and the plugin contract are not bundled: they are read from
`globalThis.__trekPlugin`, which the window sets before importing a bundle. A plugin that bundled
its own React or its own copy of the contract would not see the window's plugin host. Importing
any other package (`react-dom`, say) fails the build, and the bundle is the same text whatever
directory the build is run from.

A package (`.trekplugin`) is `{ "manifest": {...}, "client": "<the bundle's text>" }`. The
manifest's `id` and `version` must equal those of the plugin the bundle exports; `manifest.ts` is
the one source for both. The limits and the manifest's rules are in `PROTOCOL.md` → Installed
plugins.
