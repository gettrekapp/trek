import { useEffect, useRef } from 'react'
import { router, Stack, useGlobalSearchParams, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as Device from 'expo-device'
import * as ScreenOrientation from 'expo-screen-orientation'
import * as Notifications from 'expo-notifications'
import { notificationRoute } from '../src/logic/attention.ts'
import { routeTap } from '../src/logic/push.ts'
import { shouldLockPortrait } from '../src/logic/layout.ts'
import { leavesProject } from '../src/logic/routes.ts'
import { ServersProvider } from '../src/state/ServersProvider.tsx'
import { PushProvider, usePush } from '../src/state/PushProvider.tsx'
import { colors } from '../src/ui/theme.ts'

// A notification that arrives while the app is open is shown as a banner, without sound.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false })
})

// Attention is under every other screen, also when the app is started by a link (trek://pair)
// or a notification: Back from there leads home.
export const unstable_settings = { initialRouteName: 'index' }

/**
 * Tapping a notification opens its session (or worktree): while running, and on a cold start. A
 * tap is held until the saved servers and their push records are loaded (a push names the
 * server's own id, mapped to the phone's entry), and marked handled only once routed or found to
 * have no route.
 */
function NotificationRouting(): null {
  const { ready, routeData } = usePush()
  const pending = useRef<Notifications.NotificationResponse[]>([])
  const handled = useRef(new Set<string>())
  const cold = useRef<Notifications.NotificationResponse | null>(null)
  // Where the phone is now, for the flush closure below to read.
  const segments = useSegments()
  const params = useGlobalSearchParams()
  const where = useRef({ segments: segments as readonly string[], params: params as Record<string, string | string[] | undefined> })
  where.current = { segments, params }
  const flushRef = useRef<() => void>(() => {})
  flushRef.current = () => {
    const still: Notifications.NotificationResponse[] = []
    for (const response of pending.current) {
      const route = routeTap(response.notification.request.content.data, ready, routeData, notificationRoute)
      if (route === 'wait') {
        still.push(response)
        continue
      }
      handled.current.add(response.notification.request.identifier)
      if (response === cold.current) {
        cold.current = null
        try {
          Notifications.clearLastNotificationResponse()
        } catch {
          // Not available (no native module).
        }
      }
      if (route) {
        // From another project's screen, go home first: a project's stack is shared by every project.
        if (leavesProject(where.current.segments, where.current.params, route)) router.dismissTo('/')
        router.push(route, { withAnchor: true })
      }
    }
    pending.current = still
  }
  useEffect(() => {
    const open = (response: Notifications.NotificationResponse | null): void => {
      if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return
      const id = response.notification.request.identifier
      if (handled.current.has(id) || pending.current.some((r) => r.notification.request.identifier === id)) return
      pending.current.push(response)
      flushRef.current()
    }
    // The tap that started the app, once navigation is up.
    const timer = setTimeout(() => {
      try {
        const last = Notifications.getLastNotificationResponse()
        cold.current = last
        open(last)
      } catch {
        // Not available (no native module): nothing to route.
      }
    }, 0)
    const sub = Notifications.addNotificationResponseReceivedListener(open)
    return () => {
      clearTimeout(timer)
      sub.remove()
    }
  }, [])
  // Held taps, again once the phone can map them.
  useEffect(() => {
    flushRef.current()
  }, [ready, routeData])
  return null
}

// Phones stay portrait; tablets turn (app.json allows every orientation, which iPad multitasking needs).
function useOrientationLock(): void {
  useEffect(() => {
    if (!shouldLockPortrait(Device.deviceType as number | null)) return
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {
      // No native module (an old dev build): the phone turns with the device.
    })
  }, [])
}

export default function RootLayout(): React.JSX.Element {
  useOrientationLock()
  return (
    <ServersProvider>
      <PushProvider>
      <StatusBar style="light" />
      <NotificationRouting />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerShadowVisible: false,
          // Only the chevron: a long branch name as the back label pushes the title aside.
          headerBackButtonDisplayMode: 'minimal',
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg }
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Needs you' }} />
        {/* The tab bar's other two screens: they change without a slide, and the bar is their way back. */}
        <Stack.Screen name="servers" options={{ title: 'Servers', animation: 'none', headerBackVisible: false }} />
        <Stack.Screen name="add-server" options={{ title: 'Add server', presentation: 'modal' }} />
        <Stack.Screen name="pair" options={{ title: 'Add server' }} />
        <Stack.Screen name="projects" options={{ title: 'Projects', animation: 'none', headerBackVisible: false }} />
        <Stack.Screen name="push/[serverId]" options={{ title: 'Push notifications' }} />
        {/* The project's own stack draws its headers (app/project/[serverId]/[projectId]/_layout.tsx). */}
        <Stack.Screen name="project/[serverId]/[projectId]" options={{ headerShown: false }} />
      </Stack>
      </PushProvider>
    </ServersProvider>
  )
}
