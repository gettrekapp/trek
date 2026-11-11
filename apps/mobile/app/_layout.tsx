import { useEffect } from 'react'
import { router, Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as Notifications from 'expo-notifications'
import { notificationRoute } from '../src/logic/attention.ts'
import { ServersProvider } from '../src/state/ServersProvider.tsx'
import { colors } from '../src/ui/theme.ts'

// A notification that arrives while the app is open is shown as a banner, without sound.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false })
})

// Attention is under every other screen, also when the app is started by a link (trek://pair)
// or a notification: Back from there leads home.
export const unstable_settings = { initialRouteName: 'index' }

/** Tapping a notification opens its session (or worktree): while running, and on a cold start. */
function NotificationRouting(): null {
  useEffect(() => {
    const handled = new Set<string>()
    const open = (response: Notifications.NotificationResponse | null): void => {
      if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return
      const id = response.notification.request.identifier
      if (handled.has(id)) return
      handled.add(id)
      const route = notificationRoute(response.notification.request.content.data)
      if (route) router.push(route)
    }
    // The tap that started the app, once navigation is up.
    const cold = setTimeout(() => {
      try {
        open(Notifications.getLastNotificationResponse())
        Notifications.clearLastNotificationResponse()
      } catch {
        // Not available (no native module): nothing to route.
      }
    }, 0)
    const sub = Notifications.addNotificationResponseReceivedListener(open)
    return () => {
      clearTimeout(cold)
      sub.remove()
    }
  }, [])
  return null
}

export default function RootLayout(): React.JSX.Element {
  return (
    <ServersProvider>
      <StatusBar style="light" />
      <NotificationRouting />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.panel },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg }
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Attention' }} />
        <Stack.Screen name="servers" options={{ title: 'Servers' }} />
        <Stack.Screen name="add-server" options={{ title: 'Add server', presentation: 'modal' }} />
        <Stack.Screen name="pair" options={{ title: 'Add server' }} />
        <Stack.Screen name="projects" options={{ title: 'Projects' }} />
      </Stack>
    </ServersProvider>
  )
}
