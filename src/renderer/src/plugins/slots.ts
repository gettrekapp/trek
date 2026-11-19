// Which plugins fill a slot (campsite): the active ones that have it, in built-in order. Pure.
import type { ClientPlugin, PluginSlotName } from '../../../shared/plugins/client.ts'
import { pluginActive, type PluginStatus } from './presence.ts'

interface SlotEntry {
  plugin: Pick<ClientPlugin, 'slots'>
  status: PluginStatus
}

export function activeSlotEntries<E extends SlotEntry>(entries: readonly E[], name: PluginSlotName): E[] {
  return entries.filter((e) => pluginActive(e.status) && e.plugin.slots?.[name])
}

/** For a slot only one plugin may fill (sessionIndicator) */
export function firstActiveSlot<E extends SlotEntry>(entries: readonly E[], name: PluginSlotName): E | undefined {
  return activeSlotEntries(entries, name)[0]
}
