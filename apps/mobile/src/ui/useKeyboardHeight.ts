// The software keyboard's height in points, 0 while it is down. iOS says so as the keyboard starts
// to move (Will), Android only once it has (Did). On Android the app is edge to edge, so the window
// does not shrink for the keyboard: a view at the bottom has to move itself.
import { useEffect, useState } from 'react'
import { Keyboard, Platform } from 'react-native'

export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const ios = Platform.OS === 'ios'
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', (e) => setHeight(e.endCoordinates.height))
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setHeight(0))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])
  return height
}
