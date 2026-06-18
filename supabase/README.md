# Supabase setup for BipoAi

## 1. Create a Supabase project
Go to [supabase.com/dashboard](https://supabase.com/dashboard) and create a project.

## 2. Run the database schema
1. Open **SQL Editor** in your Supabase project
2. Paste the contents of `supabase/schema.sql`
3. Click **Run**

This creates:
- `profiles` — users from Google, Apple, and email sign-in
- `study_sessions` — notes, flashcards, quiz, podcast per session
- `folders` — library folders
- `decks` — flashcard decks

## 3. Add credentials to `.env`
```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_ANON_KEY=your-anon-key
```

Find these under **Project Settings → API**.

- **service role** — server storage only (never expose in the browser)
- **anon key** — required for email sign-in / sign-up via Supabase Auth

## 4. Enable email login in Supabase
1. Open **Authentication → Providers → Email**
2. Turn **Email** on
3. For local testing, you can disable **Confirm email** (otherwise users must click the confirmation link before signing in)

## 5. Enable Google & Apple in Supabase (optional)
BipoAi verifies Google/Apple tokens on your server, then saves profiles to Supabase.

You can also enable providers in **Authentication → Providers** for future Supabase Auth flows:
- **Google** — use the same `GOOGLE_CLIENT_ID` / secret from Google Cloud
- **Apple** — use your Apple Services ID

## 6. Restart the server
```bash
./start.sh
```

Check connection:
- Database: `http://localhost:3001/api/db/status`
- Auth config: `http://localhost:3001/api/auth/config` (`supabaseAuth: true` when email login is ready)

## How sign-in works
1. **Email** — Supabase Auth verifies password; profile saved to `profiles`
2. **Google** or **Apple** — server verifies OAuth token, then saves profile to Supabase
3. Study sessions, decks, and folders are stored under the user's `owner_id`
4. Guest data (before sign-in) is migrated on login automatically
