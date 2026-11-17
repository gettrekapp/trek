// A project's screens (its worktree list, a worktree, a session, Changes, a branch's history, adding a
// worktree, automations) in their own stack. On a wide window (tablets) the stack is the detail pane
// beside the project's sidebar.
import { Stack } from 'expo-router'
import { colors } from '../../../../src/ui/theme.ts'

// A project's screen opened from outside (Needs you, a notification) has the project's list beneath it.
export const unstable_settings = { initialRouteName: 'index' }

export default function ProjectLayout(): React.JSX.Element {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg }
      }}
    />
  )
}
