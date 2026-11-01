# Per-project appearance

## Goal

Make project windows easy to tell apart. A project can set the background color of
Trek's top bar, a logo shown in the title, and a banner shown at the top of the left
panel. All three are optional; a project that sets none looks the same as today.

## Decisions

- **Settings belong to the project,** not to a repository or the machine. They save in
  the `.trekproj`, so they travel with the file and each window shows its own project's
  look.
- **Images are stored as data URLs in the `.trekproj`,** downscaled when picked. This
  matches session type icons and needs no new IPC or file access. File paths would break
  on other machines, and machine-local storage wouldn't travel with the project.
- **The logo sits beside the project name.** It doesn't replace the name or the file path.
- **Trek only renders embedded images.** A value from a project file that isn't a
  `data:image/` URL is dropped, so a shared or hand-edited project can't make Trek fetch
  a remote image.
- **Windows and Linux keep their native OS title bar.** The color applies to Trek's own
  bar beneath it. Recoloring the native bar is out of scope.

## Data

Three optional fields on `ProjectFile` in `src/shared/types.ts`:

| Field | Value |
|---|---|
| `titleBarColor` | Hex color, `#rrggbb` |
| `logoImage` | `data:image/` URL |
| `bannerImage` | `data:image/` URL |

Leaving a field unset, or clearing it, means the default look. No project file version
change is needed.

A new pure module, `src/shared/appearance.ts`, holds:

- `sanitizeAppearance(project)`: removes a `titleBarColor` that isn't `#rrggbb`, and a
  `logoImage` or `bannerImage` that isn't a `data:image/` URL. Other fields are untouched.
- `titleBarForeground(color)`: returns whether light or dark text is more readable on
  the color, by comparing WCAG contrast ratios.

`migrateProject` in `store.ts` calls `sanitizeAppearance`, so every load path is covered.
A removed value is not reported to the user; it stays gone at the next save.

## Store

One setter per field in `store.ts`, following `setAudioAlerts`: `setTitleBarColor`,
`setLogoImage` and `setBannerImage`. Each takes the value or `undefined`, updates the
project and marks it dirty. The settings UI calls `scheduleAutoSave()` after each change,
as the other settings do.

## Settings UI

A new "Appearance" section in `SettingsPanel.tsx`, placed directly after the general
settings under the "Settings" heading and before `LinearSettings`.

- **Title bar color:** a color input and a Reset button. Reset is shown only when a color
  is set. The input's value is the current color, or the default `#161618` when unset.
- **Logo:** an image picker with a thumbnail and a Clear button.
- **Banner:** the same, with a wider thumbnail.

`SessionTypeIconPicker` and `loadIcon` generalize into one picker that takes the image
limits below; session type icons keep their current behavior (PNG only, 64px). Appearance
pickers accept PNG, JPEG and WebP.

| Image | Max size | Stored as |
|---|---|---|
| Logo | Fits within 64×64px | PNG |
| Banner | Fits within 640×240px | WebP (keeps transparency) |

Images are only ever scaled down, keeping their proportions. If a file can't be decoded,
the existing value stays and the user sees an error through `window.api.showError`.

## Title bar

In `App.tsx`:

- When `titleBarColor` is set, it applies as an inline background on `.title-bar`.
- `titleBarForeground` selects a light or dark modifier class. It sets the title text,
  the file path and nothing else, keeping the path visibly secondary in both variants.
- When `logoImage` is set, an `<img>` about 22px tall sits immediately left of the
  project name inside `.title-text`. It has an empty `alt` because the name is beside it,
  and it can't be dragged, so the bar still moves the window.

With no project open, the title bar keeps its default look.

## Sidebar banner

In `Sidebar.tsx`, when `bannerImage` is set, a new row renders above `.sidebar-top`. The
image is left-aligned, no wider than the sidebar and at most about 72px tall. It keeps its
proportions and is never cropped. With no banner, no row renders and the layout is
unchanged.

## Testing

- **Unit tests** in `scripts/appearance.test.mjs`, run by `npm test`:
  - `sanitizeAppearance` keeps valid values, removes invalid ones (including remote image
    URLs and `data:` URLs that aren't images) and leaves other fields alone.
  - `titleBarForeground` picks dark text on light colors, light text on dark colors, and
    handles black and white.
- **Typecheck:** `npm run typecheck` passes.
- **Manual run of the app:**
  - Set a color, logo and banner, and confirm each displays and that clearing each
    restores the default look.
  - Check that text stays readable on a very light and a very dark color.
  - Reopen the project and confirm all three persist.
  - Open two projects in separate windows and confirm each shows its own appearance.
  - Confirm the title bar still drags the window when clicking on the logo.
