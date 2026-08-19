import { createContext, useContext, useEffect, useState } from 'react';
import { authApi, setUnauthorizedHandler } from '../services/api';

const AuthContext = createContext(null);
const TOKEN_STORAGE_KEY = 'doc_auth_token';
// DOC-69 - "Error & UX Hardening" (task spec section 14). Set right before
// clearing auth state whenever services/api.js detects a session-invalid/
// deactivated response mid-session (see that file's own
// SESSION_INVALID_MESSAGES comment) - Login.jsx reads and immediately
// clears this once, so the person understands WHY they landed back on
// Login instead of just silently losing their place. A plain
// sessionStorage flag (not React state) on purpose: the redirect itself
// is a full route change (ProtectedRoute reacting to isAuthenticated
// becoming false), so this needs to survive that navigation without
// threading a new prop/context value through it.
export const SESSION_EXPIRED_FLAG_KEY = 'doc_session_expired';

// Provides authentication state (user, token) and actions (login, register,
// logout) to the whole application. Persists the session via localStorage so
// a page refresh does not log the user out.
export function AuthProvider({ children }) {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const restoreSession = async () => {
      const storedToken = localStorage.getItem(TOKEN_STORAGE_KEY);

      if (!storedToken) {
        setIsLoading(false);
        return;
      }

      try {
        const response = await authApi.getMe(storedToken);
        setUser(response.data);
        setToken(storedToken);
      } catch (error) {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        setToken(null);
        setUser(null);
      } finally {
        setIsLoading(false);
      }
    };

    restoreSession();
  }, []);

  const login = async (credentials) => {
    const response = await authApi.login(credentials);
    localStorage.setItem(TOKEN_STORAGE_KEY, response.data.token);
    setToken(response.data.token);
    setUser(response.data.user);
    return response.data.user;
  };

  const register = async (payload) => authApi.register(payload);

  const logout = () => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setToken(null);
    setUser(null);
  };

  // DOC-69 - registers the ONE handler services/api.js calls when it
  // detects a session-invalid/deactivated response on an authenticated
  // call made mid-session (see that file's own top comment). Sets the
  // one-time "why am I back on Login" flag, then reuses `logout()`
  // completely unchanged - `isAuthenticated` becoming false is what makes
  // ProtectedRoute.jsx redirect to /login on its own (no separate
  // navigate() call needed here, and no risk of an infinite redirect loop:
  // this only ever runs in reaction to a REJECTED API call, never in
  // reaction to the redirect itself, which makes no API call of its own).
  // Registered once per AuthProvider mount (there is exactly one, for the
  // lifetime of this app - see main.jsx), never re-registered on every
  // render.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      sessionStorage.setItem(SESSION_EXPIRED_FLAG_KEY, '1');
      logout();
    });
    return () => setUnauthorizedHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // DOC-57 - lets a page that just received a fresh, real sanitized user
  // object back from the backend (e.g. the Change Password page's own
  // PATCH /api/auth/change-password response) update the shared auth
  // state directly, without a second round trip to GET /api/auth/me.
  // Never accepts a partial/locally-guessed object - every existing
  // caller of this context already follows the same "only ever set
  // `user` from a real backend response" discipline (see `login` above),
  // this just exposes that same capability to components other than this
  // provider itself.
  const updateUser = (nextUser) => {
    setUser(nextUser);
  };

  const value = {
    user,
    token,
    isAuthenticated: Boolean(token && user),
    isLoading,
    login,
    register,
    logout,
    updateUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// Convenience hook for consuming the auth context.
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
