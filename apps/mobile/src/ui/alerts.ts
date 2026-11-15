// Alert.alert as a promise that settles when the alert closes: a button, or the alert going away
// without one (Android: the back button or a tap outside it; an iOS alert only closes by a button).
// It never settles when Android has no Activity attached: React Native then shows nothing and only warns.
import { Alert } from 'react-native'

/** A question with Cancel and one confirming button; true only when that button is tapped. */
export function confirmAlert(title: string, message: string, confirmLabel: string, destructive = false): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      Alert.alert(
        title,
        message,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) }
        ],
        { cancelable: true, onDismiss: () => resolve(false) }
      )
    } catch {
      resolve(false)
    }
  })
}

/** Something to read, with OK; settles when it is closed either way. */
export function noticeAlert(title: string, message: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      Alert.alert(title, message, [{ text: 'OK', onPress: () => resolve() }], { cancelable: true, onDismiss: () => resolve() })
    } catch {
      resolve()
    }
  })
}
