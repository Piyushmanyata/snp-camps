/**
 * Test stub for @/lib/supabase/admin createServiceRoleClient.
 * Tests install a fake via __setServiceRoleClient.
 */

let client = null;

export function __setServiceRoleClient(next) {
  client = next;
}

export function __resetServiceRoleClient() {
  client = null;
}

export function createServiceRoleClient() {
  return client;
}
