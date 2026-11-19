// A project's screens (its worktree list, a worktree, a session, Changes, a branch's history, adding a
// worktree, its Global sessions, automations) in their own stack. On a wide window (tablets) the stack is the detail pane
// beside the project's sidebar, and the list is a placeholder under the screen the sidebar opened.
// Under the stack, on every width, the project's Global tray (ui/GlobalTray.tsx).
import { useState } from 'react'
import { View, useWindowDimensions } from 'react-native'
import { Stack, useLocalSearchParams, useNavigation, useRootNavigationState, useRoute } from 'expo-router'
import { aboveIndex, childRoutes, isWide } from '../../../../src/logic/layout.ts'
import { GlobalTray } from '../../../../src/ui/GlobalTray.tsx'
import { GlobalTrayProvider } from '../../../../src/ui/globalTrayContext.tsx'
import { PaneWidthProvider } from '../../../../src/ui/paneWidth.tsx'
import { ProjectProvider } from '../../../../src/ui/projectContext.tsx'
import { ProjectSidebar } from '../../../../src/ui/ProjectSidebar.tsx'
import { colors } from '../../../../src/ui/theme.ts'

// A project's screen opened from outside (Needs you, a notification) has the project's list beneath it.
export const unstable_settings = { anchor: 'index' }

export default function ProjectLayout(): React.JSX.Element {
  const { serverId, projectId } = useLocalSearchParams<{ serverId: string; projectId: string }>()
  const wide = isWide(useWindowDimensions().width)
  // The root stack's navigation (this layout is the root stack's screen): the sidebar's Back leaves the project.
  const navigation = useNavigation()
  const [pane, setPane] = useState<{ width: number; height: number } | null>(null)
  // On a wide window the screen right above the index (the placeholder) has no Back: the sidebar
  // leads everywhere else. Narrow, Back leads to the list as ever. Read from the root state, which
  // is the one this stack renders from in the same render (a screen's navigation.getState() is
  // only updated after it, so a just-picked screen would be missed).
  const route = useRoute()
  const rootState = useRootNavigationState()
  const noBack = wide ? aboveIndex(childRoutes(rootState, route.key)) : null
  // One tree whatever the width, so crossing the breakpoint (iPad Split View, rotating) keeps the
  // stack and its screen; only the sidebar comes and goes.
  return (
    <ProjectProvider value={{ serverId, projectId }}>
      <View style={{ flex: 1, flexDirection: 'row', backgroundColor: colors.bg }}>
        {wide ? <ProjectSidebar onBack={() => navigation.goBack()} /> : null}
        <View
          style={{ flex: 1 }}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout
            const next = { width: Math.round(width), height: Math.round(height) }
            setPane((prev) => (prev && prev.width === next.width && prev.height === next.height ? prev : next))
          }}
        >
          <PaneWidthProvider value={pane?.width ?? null}>
            <GlobalTrayProvider serverId={serverId} projectId={projectId}>
              <View style={{ flex: 1 }}>
                <Stack
                  screenOptions={({ route: screen }) => ({
                    headerStyle: { backgroundColor: colors.bg },
                    headerShadowVisible: false,
                    headerBackButtonDisplayMode: 'minimal',
                    headerTintColor: colors.text,
                    contentStyle: { backgroundColor: colors.bg },
                    ...(screen.key !== undefined && noBack?.has(screen.key) ? { headerBackVisible: false, gestureEnabled: false } : null)
                  })}
                />
              </View>
              {pane ? <GlobalTray serverId={serverId} projectId={projectId} paneHeight={pane.height} /> : null}
            </GlobalTrayProvider>
          </PaneWidthProvider>
        </View>
      </View>
    </ProjectProvider>
  )
}
