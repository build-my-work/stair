import { createContext, useContext } from 'react'

// The real provider resolves system/scenic/preset settings to this display value.
export const NotionTestThemeContext = createContext({ isDark: false })
export function useTheme() { return useContext(NotionTestThemeContext) }
