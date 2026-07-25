/**
 * Configurable stub for @supabase/ssr createServerClient used by patient-login.
 * Tests set behaviour via __setAuthMock / __resetAuthMock.
 */

let authMock = {
  signInWithPassword: async () => ({
    data: { user: null },
    error: { message: "Invalid login credentials" },
  }),
  signOut: async () => ({ error: null }),
  getClaims: null,
  userId: null,
  profile: null,
  profileError: null,
};

export function __setAuthMock(next) {
  authMock = { ...authMock, ...next };
}

export function __resetAuthMock() {
  authMock = {
    signInWithPassword: async () => ({
      data: { user: null },
      error: { message: "Invalid login credentials" },
    }),
    signOut: async () => ({ error: null }),
    getClaims: null,
    userId: null,
    profile: null,
    profileError: null,
  };
}

export function createServerClient() {
  return {
    auth: {
      signInWithPassword: (...args) => authMock.signInWithPassword(...args),
      signOut: (...args) => authMock.signOut(...args),
      async getClaims() {
        if (typeof authMock.getClaims === "function") {
          return authMock.getClaims();
        }
        if (authMock.userId) {
          return {
            data: { claims: { sub: authMock.userId } },
            error: null,
          };
        }
        return { data: { claims: null }, error: null };
      },
    },
    from(table) {
      if (table !== "profiles") {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return {
                    data: authMock.profile,
                    error: authMock.profileError,
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}
