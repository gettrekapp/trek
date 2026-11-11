import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as Notifications from 'expo-notifications'
import { ServersProvider } from '../src/state/ServersProvider.tsx'
import { colors } from '../src/ui/theme.ts'

// A notification that arrives while the app is open is shown as a banner, without sound.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false })
})

export default function RootLayout(): React.JSX.Element {
  return (
    <ServersProvider>
      <StatusBar style="light" />
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
