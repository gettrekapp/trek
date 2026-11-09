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

/** Reads an image and downscales it so the data URL stays small in the project. */
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
