import { useEffect, useRef, useState } from 'react'
import { getBackend } from '../backend'
import { otherTools, type McpToolCatalog, type McpToolInfo } from '../../../shared/mcpTools'

/**
 * The quick button editor's reference list of the MCP tools a session can call: Trek's, then
 * every other server's configured for Claude Code on the server's machine, each sorted by name.
 * A name copies on click. The server keeps the other servers' list until Refresh asks again.
 */
export function McpToolList(): React.JSX.Element {
  const [trek, setTrek] = useState<McpToolInfo[] | null>(null)
  const [catalog, setCatalog] = useState<McpToolCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const generation = useRef(0)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const load = (refresh: boolean): void => {
    const mine = ++generation.current
    const backend = getBackend()
    setLoading(true)
    setError(null)
    // Trek's own at once; the other servers can take seconds each to start and answer.
    if (!refresh) {
      backend.mcpTools.trek().then(
        (result) => {
          if (generation.current === mine) setTrek((current) => current ?? result.trek)
        },
        () => {}
      )
    }
    backend.mcpTools
      .list(refresh)
      .then(
        (result) => {
          if (generation.current !== mine) return
          setCatalog(result)
          setTrek(result.trek)
        },
        (err: unknown) => {
          if (generation.current === mine) setError(backend.errors.inline(err) ?? 'Could not list the MCP tools')
        }
      )
      .finally(() => {
        if (generation.current === mine) setLoading(false)
      })
  }

  useEffect(() => {
    load(false)
    return () => {
      generation.current++
      clearTimeout(copiedTimer.current)
    }
  }, [])

  const copy = (name: string): void => {
    void navigator.clipboard.writeText(name).then(() => {
      setCopied(name)
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(null), 1200)
    })
  }

  const others = catalog ? otherTools(catalog) : []
  const failed = catalog?.servers.filter((s) => s.error) ?? []

  const list = (tools: McpToolInfo[], wide = false): React.JSX.Element => (
    <ul className={wide ? 'mcp-tool-names wide' : 'mcp-tool-names'}>
      {tools.map((t) => (
        <li key={t.name}>
          <button type="button" title={t.description ? `${t.name}\n\n${t.description}` : t.name} onClick={() => copy(t.name)}>
            {copied === t.name ? 'Copied' : t.name}
          </button>
        </li>
      ))}
    </ul>
  )

  return (
    <div className="mcp-tool-list">
      <div className="mcp-tool-list-head">
        <span>MCP tools</span>
        <span className="muted mcp-tool-list-hint">click a name to copy it</span>
        <span className="spacer" />
        <button type="button" className="panel-btn" disabled={loading} onClick={() => load(true)}>
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>
      <div className="mcp-tool-list-body">
        {error && (
          <div className="mcp-tool-list-error" role="alert">
            {error}
          </div>
        )}
        {trek && (
          <>
            <h3>Trek</h3>
            {list(trek)}
          </>
        )}
        {(trek || catalog) && <h3>Other tools</h3>}
        {others.length > 0 && list(others, true)}
        {others.length === 0 && !error && (
          <div className="muted mcp-tool-list-empty">{catalog && !loading ? 'No other MCP tools found.' : 'Asking the configured MCP servers…'}</div>
        )}
        {failed.length > 0 && (
          <ul className="mcp-tool-list-failed">
            {failed.map((s) => (
              <li key={s.name}>
                <span className="mcp-tool-server">{s.name}</span> ({s.scope}): {s.error}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
