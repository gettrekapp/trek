import { useAppStore } from '../store'
import { DEFAULT_TITLE_BAR_COLOR, resolveProjectName } from '../../../shared/appearance'
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

/** Per-project name, title bar color, logo and banner, stored in the project file. */
export function AppearanceSettings(): React.JSX.Element {
  const projectName = useAppStore((s) => s.project?.name ?? '')
  const setProjectName = useAppStore((s) => s.setProjectName)
  const titleBarColor = useAppStore((s) => s.project?.titleBarColor)
  const logoImage = useAppStore((s) => s.project?.logoImage)
  const bannerImage = useAppStore((s) => s.project?.bannerImage)
  const setTitleBarColor = useAppStore((s) => s.setTitleBarColor)
  const setLogoImage = useAppStore((s) => s.setLogoImage)
  const setBannerImage = useAppStore((s) => s.setBannerImage)
  const serverWindow = useAppStore((s) => s.serverWindow !== null)

  return (
    <>
      <h3>Appearance</h3>
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-name">Project name</span>
          <span className="settings-desc">
            {serverWindow
              ? 'Shown in the title bar. Renames the project on the server.'
              : 'Shown in the title bar. The project file keeps its own name.'}
          </span>
        </span>
        <input
          className="settings-select"
          type="text"
          key={projectName}
          defaultValue={projectName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              e.currentTarget.value = projectName
              e.currentTarget.blur()
            }
          }}
          onBlur={(e) => {
            const name = resolveProjectName(e.target.value, projectName)
            e.target.value = name
            if (name !== projectName) {
              setProjectName(name)
            }
          }}
        />
      </div>
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
            }}
          />
          {titleBarColor && (
            <button
              className="btn btn-ghost"
              onClick={() => {
                setTitleBarColor(undefined)
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
          }}
          limits={BANNER_LIMITS}
          title="Choose a banner image"
          wide
        />
      </div>
    </>
  )
}
