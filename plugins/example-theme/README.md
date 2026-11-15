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

## Build and install

    npm run build:example-theme
    trek-server plugin add plugins/example-theme/dist/example-theme.trekplugin

Add `--local` to install it on the Trek app's Local server. A running server notices the change.
Then, in a project window: Settings → General → Appearance → Theme.

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
