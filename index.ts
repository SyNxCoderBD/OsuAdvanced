// Supabase injects SUPABASE_URL and the keys into Edge Functions automatically.
// Nothing secret lives in this repo or in the browser.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { makeHandler } from "./handler.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
Deno.serve(makeHandler(sb));
