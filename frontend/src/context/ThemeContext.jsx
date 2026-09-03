import { createContext, useCallback, useContext, useEffect, useState } from 'react';

// DOC-77 - "Theme Switcher / Appearance Customization".
//
// SEPARATE FROM AuthContext ON PURPOSE (task spec section 6: "Do not mix
// theme state into AuthContext. Authentication and appearance are
// separate concerns."). This context owns exactly one piece of state
// (`theme`) and has zero knowledge of `token`/`user`/login/logout - it
// works identically whether or not anyone is signed in, which is exactly
// what task spec section 28 requires ("Theme preference is device/browser
// preference, not account data... do not require authentication to load
// saved theme").
//
// STORAGE KEY / ALLOWED VALUES (task spec sections 4/42): exactly one
// centralized `localStorage` key, `doc_theme`, whose only legal values are
// the literal strings `'dark'` or `'light'`. Never stores userId,
// organizationId, role, a JWT, or anything else - just the theme name.
// Any other stored value (missing key, corrupted value, a value from a
// future version of this app) safely falls back to `'dark'` (task spec
// section 3 - "Preserve the existing Dark Theme as the default for
// existing users... do NOT unexpectedly switch existing users to light").
export const THEME_STORAGE_KEY = 'doc_theme';
// Exported (in addition to being used internally below) purely so this
// module's own test harness can exercise the real, unmodified validation/
// persistence logic directly, the same way frontend/src/data/helpGuides.js
// (DOC-76) exports its own pure helpers for the identical reason - none of
// this changes any behavior, it just makes the existing behavior testable.
export const VALID_THEMES = ['dark', 'light'];
export const DEFAULT_THEME = 'dark';

export function isValidTheme(value) {
  return VALID_THEMES.includes(value);
}

export function readStoredTheme() {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isValidTheme(stored) ? stored : DEFAULT_THEME;
  } catch (error) {
    // Best-effort - a browser with localStorage disabled/unavailable
    // (private browsing edge cases, storage quota errors) should never
    // crash theme selection; it just falls back to the safe default,
    // exactly like an invalid stored value would.
    return DEFAULT_THEME;
  }
}

// The one place `data-theme` is ever written to the document - both this
// module's own effect below AND the tiny inline flash-prevention script in
// index.html apply the SAME attribute the SAME way, so there is only one
// mechanism to reason about, never two competing ones.
export function applyThemeToDocument(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  // Lazy initializer - reads localStorage exactly once, on first render,
  // rather than starting from a hardcoded default and then correcting
  // itself in an effect (which would still be safe here because index.html's
  // own inline script already applied the right attribute before React
  // even mounted - see that file's own comment - but reading it into React
  // state up front means this component's own re-render never disagrees
  // with what the page is already showing).
  const [theme, setThemeState] = useState(readStoredTheme);

  // Keeps `data-theme` in sync with state. Redundant on first render
  // (index.html's inline script already set it correctly before paint),
  // but this is what makes every SUBSEQUENT change (setTheme/toggleTheme)
  // actually take effect - task spec section 7: "no page reload required".
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  const setTheme = useCallback((nextTheme) => {
    const safeTheme = isValidTheme(nextTheme) ? nextTheme : DEFAULT_THEME;
    setThemeState(safeTheme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, safeTheme);
    } catch (error) {
      // Best-effort persistence, same reasoning as readStoredTheme above -
      // a storage failure should never block the in-memory theme change
      // from applying for the rest of this session.
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, setTheme]);

  // DOC-77 task spec section 31 - "Optional but low-cost: listen for
  // browser `storage` event so changing theme in one tab updates another
  // tab." The native `storage` event only fires in OTHER tabs/windows on
  // the same origin (never the tab that made the change), so this can
  // never fight with `setTheme`'s own state update above - it only ever
  // reacts to a change made elsewhere.
  useEffect(() => {
    function handleStorageEvent(event) {
      if (event.key === THEME_STORAGE_KEY && isValidTheme(event.newValue)) {
        setThemeState(event.newValue);
      }
    }
    window.addEventListener('storage', handleStorageEvent);
    return () => window.removeEventListener('storage', handleStorageEvent);
  }, []);

  const value = { theme, setTheme, toggleTheme };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
