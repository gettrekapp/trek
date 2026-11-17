// A project's screens (its worktree list, a worktree, a session, Changes, a branch's history, adding a
// worktree, automations) in their own stack. On a wide window (tablets) the stack is the detail pane
// beside the project's sidebar.
import { Stack, useLocalSearchParams } from 'expo-router'
import { ProjectProvider } from '../../../../src/ui/projectContext.tsx'
import { colors } from '../../../../src/ui/theme.ts'

// A project's screen opened from outside (Needs you, a notification) has the project's list beneath it.
export const unstable_settings = { initialRouteName: 'index' }

export default function ProjectLayout(): React.JSX.Element {
  const { serverId, projectId } = useLocalSearchParams<{ serverId: string; projectId: string }>()
  return (
    <ProjectProvider value={{ serverId, projectId }}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerShadowVisible: false,
          headerBackButtonDisplayMode: 'minimal',
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg }
        }}
      />
    </ProjectProvider>
  )
}
