/**
 * Configurable stub for @supabase/ssr createServerClient used by route tests.
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
  /** Optional list results for .from().select().eq().order() chains (staff GET). */
  listByRole: null,
  listError: null,
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
    listByRole: null,
    listError: null,
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
    async rpc(fn, args) {
      if (typeof authMock.rpc === "function") {
        return authMock.rpc(fn, args);
      }
      // Default: empty durable SMS issues / benign no-op RPCs for route tests.
      if (fn === "list_recent_sms_delivery_issues") {
        return { data: [], error: null };
      }
      return { data: null, error: null };
    },
    from(table) {
      if (table !== "profiles") {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        select() {
          let roleFilter = null;
          const chain = {
            eq(col, val) {
              if (col === "role") roleFilter = val;
              return chain;
            },
            order() {
              return chain;
            },
            then(resolve, reject) {
              const run = async () => {
                if (authMock.listError) {
                  return { data: null, error: authMock.listError };
                }
                if (authMock.listByRole && roleFilter != null) {
                  const rows = authMock.listByRole[roleFilter] || [];
                  return { data: rows, error: null };
                }
                return { data: [], error: null };
              };
              return run().then(resolve, reject);
            },
            async maybeSingle() {
              return {
                data: authMock.profile,
                error: authMock.profileError,
              };
            },
          };
          return chain;
        },
      };
    },
  };
}

export function createBrowserClient() {
  return createServerClient();
}
