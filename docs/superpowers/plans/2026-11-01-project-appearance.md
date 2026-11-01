# Per-project Appearance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project set its top bar color, a logo beside its name in the title, and a banner above the sidebar's filter input.

**Architecture:** Three optional fields on `ProjectFile`, saved in the `.trekproj`. Pure validation and contrast helpers live in `src/shared/appearance.ts`, and `migrateProject` validates on every load. The renderer reads the fields directly in `App.tsx` and `Sidebar.tsx`; a new settings section edits them.

**Tech Stack:** Electron, React, TypeScript, zustand, plain CSS, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-01-project-appearance-design.md`

## No commits in this plan

The working tree holds uncommitted multi-window work in files this plan edits (`App.tsx`, `store.ts`, `types.ts`, and others). Staging those files would sweep that work into a commit about appearance, so tasks have no commit steps. Leave all changes uncommitted unless the user asks otherwise.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/shared/appearance.ts` | Create | Validation, contrast choice, default color |
| `scripts/appearance.test.mjs` | Create | Unit tests for the above |
| `src/shared/types.ts` | Modify | New `ProjectFile` fields |
| `src/renderer/src/store.ts` | Modify | Validate on load; three setters |
| `src/renderer/src/components/ImagePicker.tsx` | Create | Pick, downscale and clear an image (moved out of `SettingsPanel.tsx`) |
| `src/renderer/src/components/AppearanceSettings.tsx` | Create | The Appearance settings section |
| `src/renderer/src/components/SettingsPanel.tsx` | Modify | Use the two components above |
| `src/renderer/src/App.tsx` | Modify | Title bar color and logo |
| `src/renderer/src/components/Sidebar.tsx` | Modify | Banner row |
| `src/renderer/src/styles.css` | Modify | Styles for all of the above |

---

### Task 1: Appearance helpers

**Files:**
- Modify: `src/shared/types.ts` (inside `ProjectFile`, after `audioAlerts`)
- Create: `src/shared/appearance.ts`
- Test: `scripts/appearance.test.mjs`

- [ ] **Step 1: Add the fields to `ProjectFile`**

In `src/shared/types.ts`, directly after `audioAlerts?: boolean`:

```ts
  /** Background of the window's top bar, #rrggbb (undefined = default) */
  titleBarColor?: string
  /** Shown beside the project name in the top bar, as a data:image/ URL */
  logoImage?: string
  /** Shown at the top of the sidebar, as a data:image/ URL */
  bannerImage?: string
```

- [ ] **Step 2: Write the failing tests**

Create `scripts/appearance.test.mjs`:

```js
// scripts/appearance.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeAppearance, titleBarForeground } from '../src/shared/appearance.ts'

const PNG = 'data:image/png;base64,AAAA'

test('valid appearance values and other fields are kept', () => {
  const project = { name: 'p', titleBarColor: '#1E3a8a', logoImage: PNG, bannerImage: PNG }
  assert.deepEqual(sanitizeAppearance(project), project)
})

test('a project without appearance values is unchanged', () => {
  assert.deepEqual(sanitizeAppearance({ name: 'p' }), { name: 'p' })
})

test('colors that are not #rrggbb are removed', () => {
  for (const titleBarColor of ['red', '#fff', '#12345g', '#1234567', 'url(x)', 5]) {
    assert.deepEqual(sanitizeAppearance({ name: 'p', titleBarColor }), { name: 'p' })
  }
})

test('images that are not embedded data:image/ URLs are removed', () => {
  const bad = ['https://example.com/a.png', 'file:///a.png', 'data:text/html,x', '', 5]
  for (const value of bad) {
    assert.deepEqual(sanitizeAppearance({ name: 'p', logoImage: value }), { name: 'p' })
    assert.deepEqual(sanitizeAppearance({ name: 'p', bannerImage: value }), { name: 'p' })
  }
})

test('sanitizing does not change the input', () => {
  const project = { name: 'p', titleBarColor: 'red' }
  sanitizeAppearance(project)
  assert.equal(project.titleBarColor, 'red')
})

test('dark colors get light text', () => {
  for (const color of ['#000000', '#161618', '#1e3a8a']) {
    assert.equal(titleBarForeground(color), 'light')
  }
})

test('light colors get dark text', () => {
  for (const color of ['#ffffff', '#ffeb3b', '#a7f3d0']) {
    assert.equal(titleBarForeground(color), 'dark')
  }
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test scripts/appearance.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `appearance.ts`

- [ ] **Step 4: Implement the helpers**

Create `src/shared/appearance.ts`:

```ts
import type { ProjectFile } from './types'

type AppearanceFields = Pick<ProjectFile, 'titleBarColor' | 'logoImage' | 'bannerImage'>

/** The top bar's background when a project hasn't set a color (matches .title-bar). */
export const DEFAULT_TITLE_BAR_COLOR = '#161618'

function isHexColor(value: unknown): boolean {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}

function isEmbeddedImage(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('data:image/')
}

/**
 * Drops invalid appearance values from a loaded project. Project files can be shared or
 * hand-edited, and a remote image URL would make Trek fetch it on open.
 */
export function sanitizeAppearance<T extends AppearanceFields>(project: T): T {
  const clean = { ...project }
  if (!isHexColor(clean.titleBarColor)) delete clean.titleBarColor
  if (!isEmbeddedImage(clean.logoImage)) delete clean.logoImage
  if (!isEmbeddedImage(clean.bannerImage)) delete clean.bannerImage
  return clean
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Which text is more readable on a #rrggbb color, by WCAG contrast ratio. */
export function titleBarForeground(color: string): 'light' | 'dark' {
  const luminance = relativeLuminance(color)
  const contrastWithWhite = 1.05 / (luminance + 0.05)
  const contrastWithBlack = (luminance + 0.05) / 0.05
  return contrastWithWhite >= contrastWithBlack ? 'light' : 'dark'
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test scripts/appearance.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exits 0

---

### Task 2: Store

**Files:**
- Modify: `src/renderer/src/store.ts`

- [ ] **Step 1: Validate on load**

Add to the imports, after the `migration` import:

```ts
import { sanitizeAppearance } from '../../shared/appearance'
```

Replace the body of `migrateProject`:

```ts
export function migrateProject(raw: RawProjectFile): ProjectFile {
  const project = migrateToV3(raw, () => crypto.randomUUID())
  return sanitizeAppearance({
    ...project,
    worktreeTags: project.worktreeTags ?? DEFAULT_WORKTREE_TAGS
  })
}
```

- [ ] **Step 2: Declare the setters**

In the `AppState` interface, after `setAudioAlerts: (enabled: boolean) => void`:

```ts
  setTitleBarColor: (color: string | undefined) => void
  setLogoImage: (image: string | undefined) => void
  setBannerImage: (image: string | undefined) => void
```

- [ ] **Step 3: Implement the setters**

After the `setAudioAlerts` implementation:

```ts
  setTitleBarColor: (color) =>
    set((state) => {
      if (!state.project) return state
      return { project: { ...state.project, titleBarColor: color }, dirty: true }
    }),

  setLogoImage: (image) =>
    set((state) => {
      if (!state.project) return state
      return { project: { ...state.project, logoImage: image }, dirty: true }
    }),

  setBannerImage: (image) =>
    set((state) => {
      if (!state.project) return state
      return { project: { ...state.project, bannerImage: image }, dirty: true }
    }),
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: exits 0

---

### Task 3: Image picker

Moves the session type icon picker into its own file and makes its limits configurable. It reuses the `session-type-icon*` CSS classes.

**Files:**
- Create: `src/renderer/src/components/ImagePicker.tsx`
- Modify: `src/renderer/src/components/SettingsPanel.tsx`
- Modify: `src/renderer/src/styles.css`

- [ ] **Step 1: Create the picker**

Create `src/renderer/src/components/ImagePicker.tsx`:

```tsx
import { useRef } from 'react'

export interface ImageLimits {
  maxWidth: number
  maxHeight: number
  mimeType: 'image/png' | 'image/webp'
  /** File types offered by the file dialog */
  accept: string
}

export const SESSION_ICON_LIMITS: ImageLimits = {
  maxWidth: 64,
  maxHeight: 64,
  mimeType: 'image/png',
  accept: 'image/png'
}

/** Reads an image and downscales it so the data URL stays small in the project file. */
async function loadImage(file: File, limits: ImageLimits): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, limits.maxWidth / bitmap.width, limits.maxHeight / bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.toDataURL(limits.mimeType)
}

export function ImagePicker({
  image,
  onChange,
  limits,
  title,
  wide = false
}: {
  image?: string
  onChange: (image: string | undefined) => void
  limits: ImageLimits
  /** Tooltip while no image is set */
  title: string
  /** Use a wider thumbnail, for banners */
  wide?: boolean
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className={`session-type-icon ${wide ? 'image-picker-wide' : ''}`}>
      <button
        className="session-type-icon-btn"
        title={image ? 'Change image' : title}
        onClick={() => inputRef.current?.click()}
      >
        {image ? <img src={image} alt="" /> : '+'}
      </button>
      {image && (
        <button className="session-type-icon-clear" onClick={() => onChange(undefined)}>
          Clear
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={limits.accept}
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          try {
            onChange(await loadImage(file, limits))
          } catch (err) {
            void window.api.showError('Could not load image', String(err))
          }
        }}
      />
    </div>
  )
}
```

- [ ] **Step 2: Switch `SettingsPanel.tsx` to it**

Delete `ICON_SIZE`, `loadIcon` and `SessionTypeIconPicker` (lines 31-80). Change the first line to `import { useState } from 'react'`, and add this import after the `VoiceSettings` import:

```ts
import { ImagePicker, SESSION_ICON_LIMITS } from './ImagePicker'
```

Replace the `<SessionTypeIconPicker ... />` element with:

```tsx
            <ImagePicker
              image={type.icon}
              onChange={(icon) => patchSessionType(type.id, { icon })}
              limits={SESSION_ICON_LIMITS}
              title="Choose a PNG icon"
            />
```

- [ ] **Step 3: Add the wide thumbnail style**

In `styles.css`, after the `.session-type-icon-btn img` rule:

```css
.image-picker-wide .session-type-icon-btn {
  width: 112px;
  height: 42px;
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: exits 0

---

### Task 4: Appearance settings section

**Files:**
- Create: `src/renderer/src/components/AppearanceSettings.tsx`
- Modify: `src/renderer/src/components/SettingsPanel.tsx`
- Modify: `src/renderer/src/styles.css`

- [ ] **Step 1: Create the section**

Create `src/renderer/src/components/AppearanceSettings.tsx`:

```tsx
import { scheduleAutoSave } from '../persistence'
import { useAppStore } from '../store'
import { DEFAULT_TITLE_BAR_COLOR } from '../../../shared/appearance'
import { ImagePicker, type ImageLimits } from './ImagePicker'

const ACCEPTED_IMAGES = 'image/png,image/jpeg,image/webp'

const LOGO_LIMITS: ImageLimits = {
  maxWidth: 64,
  maxHeight: 64,
  mimeType: 'image/png',
  accept: ACCEPTED_IMAGES
}

// WebP so a photo doesn't bloat the project file; it keeps transparency.
const BANNER_LIMITS: ImageLimits = {
  maxWidth: 640,
  maxHeight: 240,
  mimeType: 'image/webp',
  accept: ACCEPTED_IMAGES
}

export function AppearanceSettings(): React.JSX.Element {
  const titleBarColor = useAppStore((s) => s.project?.titleBarColor)
  const logoImage = useAppStore((s) => s.project?.logoImage)
  const bannerImage = useAppStore((s) => s.project?.bannerImage)
  const setTitleBarColor = useAppStore((s) => s.setTitleBarColor)
  const setLogoImage = useAppStore((s) => s.setLogoImage)
  const setBannerImage = useAppStore((s) => s.setBannerImage)

  return (
    <>
      <h3>Appearance</h3>
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-name">Title bar color</span>
          <span className="settings-desc">
            Background of the bar at the very top of this project&apos;s window.
          </span>
        </span>
        <span className="appearance-color">
          <input
            className="tag-color-input"
            type="color"
            title="Title bar color"
            value={titleBarColor ?? DEFAULT_TITLE_BAR_COLOR}
            onChange={(e) => {
              setTitleBarColor(e.target.value)
              scheduleAutoSave()
            }}
          />
          {titleBarColor && (
            <button
              className="btn btn-ghost"
              onClick={() => {
                setTitleBarColor(undefined)
                scheduleAutoSave()
              }}
            >
              Reset
            </button>
          )}
        </span>
      </div>
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-name">Logo</span>
          <span className="settings-desc">Shown beside the project name in the title bar.</span>
        </span>
        <ImagePicker
          image={logoImage}
          onChange={(image) => {
            setLogoImage(image)
            scheduleAutoSave()
          }}
          limits={LOGO_LIMITS}
          title="Choose a logo image"
        />
      </div>
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-name">Banner</span>
          <span className="settings-desc">
            Shown at the top of the left panel, above the worktree filter.
          </span>
        </span>
        <ImagePicker
          image={bannerImage}
          onChange={(image) => {
            setBannerImage(image)
            scheduleAutoSave()
          }}
          limits={BANNER_LIMITS}
          title="Choose a banner image"
          wide
        />
      </div>
    </>
  )
}
```

- [ ] **Step 2: Add it to the settings panel**

In `SettingsPanel.tsx`, add this import after the `ImagePicker` import:

```ts
import { AppearanceSettings } from './AppearanceSettings'
```

Insert the section directly before `<LinearSettings />`:

```tsx
        <AppearanceSettings />
        <LinearSettings />
```

- [ ] **Step 3: Add the control style**

In `styles.css`, after the `.image-picker-wide .session-type-icon-btn` rule:

```css
.appearance-color {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: exits 0

---

### Task 5: Title bar

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles.css`

- [ ] **Step 1: Apply the color and logo**

In `App.tsx`, add after the `SummaryBubble` import:

```ts
import { titleBarForeground } from '../../shared/appearance'
```

Directly before `return (` in `App`, add:

```tsx
  const titleBarColor = project?.titleBarColor
```

Replace the opening `<header className="title-bar">` with:

```tsx
      <header
        className={`title-bar ${titleBarColor ? `title-bar-${titleBarForeground(titleBarColor)}` : ''}`}
        style={titleBarColor ? { background: titleBarColor } : undefined}
      >
```

Directly before `{project.name}`, add:

```tsx
              {project.logoImage && <img className="title-logo" src={project.logoImage} alt="" />}
```

- [ ] **Step 2: Add the styles**

In `styles.css`, after the `.title-path` rule:

```css
.title-bar-light {
  color: #ededf0;
}

.title-bar-light .title-path {
  color: rgba(255, 255, 255, 0.65);
}

.title-bar-dark {
  color: #161618;
}

.title-bar-dark .title-path {
  color: rgba(0, 0, 0, 0.6);
}

/* Ignores the pointer so dragging on the logo still moves the window */
.title-logo {
  flex: 0 0 auto;
  height: 22px;
  max-width: 120px;
  object-fit: contain;
  pointer-events: none;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exits 0

---

### Task 6: Sidebar banner

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx`
- Modify: `src/renderer/src/styles.css`

- [ ] **Step 1: Render the banner**

In `Sidebar.tsx`, directly after `<aside className="sidebar">`:

```tsx
      {project.bannerImage && (
        <div className="sidebar-banner">
          <img src={project.bannerImage} alt="" />
        </div>
      )}
```

- [ ] **Step 2: Add the styles**

In `styles.css`, directly before the `.sidebar-top` rule:

```css
.sidebar-banner {
  flex: 0 0 auto;
  padding: 12px 12px 0;
}

.sidebar-banner img {
  display: block;
  max-width: 100%;
  max-height: 72px;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exits 0

---

### Task 7: Verify the whole feature

**Files:** none, unless a check fails.

- [ ] **Step 1: Run all unit tests**

Run: `npm test`
Expected: all pass, including the 7 appearance tests

- [ ] **Step 2: Run the existing smoke tests**

Run: `npm run smoke && npm run smoke:windows`
Expected: both pass

- [ ] **Step 3: Check the feature in the running app**

Run: `npm run dev`, then confirm each:

- Set a color, logo and banner: each displays, and the Appearance controls line up in their rows.
- Reset the color and clear both images: the default look returns, with no empty banner row.
- Session type icons can still be picked and cleared.
- Very light (`#ffffff`) and very dark (`#000000`) colors both leave the name and path readable.
- A tall banner stops at about 72px and a wide one fits the sidebar, neither cropped nor distorted.
- Pick a file that isn't an image: an error shows and the current image stays.
- Close and reopen the project: all three persist.
- Open two projects in separate windows: each shows its own appearance.
- Dragging from the logo moves the window.
- In a copy of a `.trekproj`, set `logoImage` to an `https://` URL and open it: no logo shows and no request is made.
