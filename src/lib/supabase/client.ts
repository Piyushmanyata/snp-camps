import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | null = null;

/** Singleton browser client — one auth listener; no realtime channels used. */
export function createClient() {
  if (browserClient) return browserClient;
  browserClient = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      realtime: {
        // App uses fixed-interval / manual refresh only — do not open sockets.
        params: { eventsPerSecond: 0 },
      },
      global: {
        headers: { "x-client-info": "snp-camps-lean" },
      },
    },
  );
  return browserClient;
}
