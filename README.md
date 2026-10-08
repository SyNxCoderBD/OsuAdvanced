# OSU Advanced

Static site (`index.html` + `config.js`) plus one Supabase Edge Function for co-op.
Upload `index.html` and `config.js` to GitHub Pages, Netlify, EdgeOne or any static host.

## One-time Supabase setup
1. Supabase dashboard > SQL Editor > run `supabase/setup.sql`.
2. Deploy the function (needs the Supabase CLI: `npm i -g supabase`):
   ```
   supabase login
   supabase functions deploy coop --no-verify-jwt --project-ref aelmlixbhneaykihunga
   ```
   `--no-verify-jwt` lets the browser call it without a key; rooms are protected by random codes and a host token.
3. Check `config.js` points at `https://<your-project-ref>.supabase.co/functions/v1/coop`.

No keys are needed in this folder: Supabase gives the function its own URL and keys as secrets.

## Co-op
Host: pick a song > "Co-op room (2 players)" > "Create room". Guest: "Join a friend's co-op room" > enter the code.
Turns alternate every 30 seconds. Auto assist, Auto point and Autoplay are disabled in co-op.
