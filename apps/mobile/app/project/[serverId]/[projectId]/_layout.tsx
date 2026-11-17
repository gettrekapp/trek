// A project's screens (its worktree list, a worktree, a session, Changes, a branch's history, adding a
// worktree, automations) in their own stack. On a wide window (tablets) the stack is the detail pane
// beside the project's sidebar, and the list is a placeholder under the screen the sidebar opened.
import { useState } from 'react'
import { View, useWindowDimensions } from 'react-native'
import { Stack, useLocalSearchParams, useNavigation, useRootNavigationState, useRoute } from 'expo-router'
import { aboveIndex, childRoutes, isWide } from '../../../../src/logic/layout.ts'
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
  const [paneWidth, setPaneWidth] = useState<number | null>(null)
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
        <View style={{ flex: 1 }} onLayout={(e) => setPaneWidth(Math.round(e.nativeEvent.layout.width))}>
          <PaneWidthProvider value={paneWidth}>
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
          </PaneWidthProvider>
        </View>
      </View>
    </ProjectProvider>
  )
}
