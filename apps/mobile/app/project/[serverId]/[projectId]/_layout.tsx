// A project's screens (its worktree list, a worktree, a session, Changes, a branch's history, adding a
// worktree, automations) in their own stack. On a wide window (tablets) the stack is the detail pane
// beside the project's sidebar, and the list is a placeholder under the screen the sidebar opened.
import { useState } from 'react'
import { View, useWindowDimensions } from 'react-native'
import { Stack, useLocalSearchParams, useNavigation } from 'expo-router'
import { isWide } from '../../../../src/logic/layout.ts'
import { PaneWidthProvider } from '../../../../src/ui/paneWidth.tsx'
import { ProjectProvider } from '../../../../src/ui/projectContext.tsx'
import { ProjectSidebar } from '../../../../src/ui/ProjectSidebar.tsx'
import { colors } from '../../../../src/ui/theme.ts'

// A project's screen opened from outside (Needs you, a notification) has the project's list beneath it.
export const unstable_settings = { initialRouteName: 'index' }

export default function ProjectLayout(): React.JSX.Element {
  const { serverId, projectId } = useLocalSearchParams<{ serverId: string; projectId: string }>()
  const wide = isWide(useWindowDimensions().width)
  // The root stack's navigation (this layout is the root stack's screen): the sidebar's Back leaves the project.
  const navigation = useNavigation()
  const [paneWidth, setPaneWidth] = useState<number | null>(null)
  // One tree whatever the width, so crossing the breakpoint (iPad Split View, rotating) keeps the
  // stack and its screen; only the sidebar comes and goes.
  return (
    <ProjectProvider value={{ serverId, projectId }}>
      <View style={{ flex: 1, flexDirection: 'row', backgroundColor: colors.bg }}>
        {wide ? <ProjectSidebar onBack={() => navigation.goBack()} /> : null}
        <View style={{ flex: 1 }} onLayout={(e) => setPaneWidth(Math.round(e.nativeEvent.layout.width))}>
          <PaneWidthProvider value={paneWidth}>
            <Stack
              screenOptions={({ route, navigation: screen }) => {
                // On a wide window the screen right above the index (the placeholder) has no Back:
                // the sidebar leads everywhere else. Narrow, Back leads to the list as ever.
                const routes: readonly { key: string; name: string }[] = screen.getState().routes
                const at = routes.findIndex((r) => r.key === route.key)
                const top = wide && at > 0 && routes[at - 1].name === 'index'
                return {
                  headerStyle: { backgroundColor: colors.bg },
                  headerShadowVisible: false,
                  headerBackButtonDisplayMode: 'minimal',
                  headerTintColor: colors.text,
                  contentStyle: { backgroundColor: colors.bg },
                  ...(top ? { headerBackVisible: false, gestureEnabled: false } : null)
                }
              }}
            />
          </PaneWidthProvider>
        </View>
      </View>
    </ProjectProvider>
  )
}
