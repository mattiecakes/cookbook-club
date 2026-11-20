# Cookbook Club (hosted test version)

The claude.ai prototype, running on Vercel and Supabase so people can use it without Claude accounts. The React rebuild replaces this in January.

- `index.html`: the prototype, unchanged except for two script tags and an "Account" section in Settings.
- `cc-port.js`: gives the app the same `claude.use("db" | "user" | "sample")` it had on claude.ai, backed by Supabase:
  - **db**: the `docs` table (one row per document, e.g. `books/<id>`, `plan/<monday>`), kept live with Realtime.
  - **user**: your membership in a household (name, owner or member).
  - **sample**: the `read-photo` Edge Function, which sends photos to Claude with the household's API key.

No build step. Vercel serves the folder as-is.

## Supabase project `cookbook-club`

- `households`: Josh & Kelsey, and Chris.
- `memberships`: who is in which household. Created on first sign-in from `invites`.
- `invites`: the guest list. To add someone, run this in the SQL editor:
  ```sql
  insert into invites (email, household_id, display_name)
  select 'friend@example.com', id, 'Friend' from households where name = 'Josh & Kelsey';
  ```
- `docs`: everything in the app. Row-level security limits each person to their own households, and keeps `data/users/<you>/...` (private notes, recently viewed) to you alone.

Edge Function `read-photo` needs the secret `ANTHROPIC_API_KEY`, set in the Supabase dashboard under Edge Functions > Secrets. The model defaults to `claude-sonnet-5-5`; set `READ_PHOTO_MODEL` to change it.
