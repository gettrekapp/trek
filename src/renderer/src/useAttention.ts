// The sessions that need the user on every app-wide server, for components:
// one feed per window, following main's `attention:changed` broadcast.
import { useSyncExternalStore } from 'react'
import { createAttentionFeed, type AttentionFeed } from './v2/attentionFeed'
import type { AttentionItem } from '../../shared/types'

let feed: AttentionFeed | null = null

function attention(): AttentionFeed {
  feed ??= createAttentionFeed(window.api.attention)
  return feed
}

export function useAttention(): AttentionItem[] {
  const f = attention()
  return useSyncExternalStore(f.subscribe, f.get)
}
