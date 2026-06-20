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

## 5. Enable Google & Apple OAuth (recommended)

When `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set, BipoAi uses **Supabase Auth** for Google and Apple sign-in.

### Supabase dashboard

1. **Authentication → URL Configuration**
   - **Site URL:** `https://www.bipoai.com` (or `http://localhost:3001` for local dev)
   - **Redirect URLs:** add both:
     - `http://localhost:3001/auth-callback.html`
     - `https://www.bipoai.com/auth-callback.html`

2. **Authentication → Providers → Google**
   - Enable Google
   - Use the same **Client ID** and **Client secret** from Google Cloud Console

3. **Authentication → Providers → Apple** (optional)
   - Enable Apple and add your Apple Services ID credentials

### Google Cloud Console

For Supabase Google provider, authorized redirect URI must include your Supabase callback:

```
https://YOUR_PROJECT.supabase.co/auth/v1/callback
```

Find `YOUR_PROJECT` in your Supabase URL (`https://xxxx.supabase.co`).

Also add JavaScript origins for local/production app URLs.

### How OAuth works in BipoAi

1. User clicks a saved Google/Apple account or **Use another account**
2. Browser redirects through Supabase to the provider
3. Provider returns to `auth-callback.html`
4. Server verifies the Supabase session and saves the profile to `profiles`

### Fallback (no Supabase OAuth)

If only `GOOGLE_CLIENT_ID` / `APPLE_CLIENT_ID` are set (without Supabase anon key), BipoAi falls back to direct Google/Apple popup verification on your server.

## 6. Restart the server
```bash
./start.sh
```

Check connection:
- Database: `http://localhost:3001/api/db/status`
- Auth config: `http://localhost:3001/api/auth/config` (`supabaseAuth: true` when email login is ready)

## How sign-in works
1. **Email** — Supabase Auth verifies password; profile saved to `profiles`
2. **Google / Apple** — Supabase OAuth when `SUPABASE_ANON_KEY` is set; otherwise direct token verification on your server
3. Saved account lists open the real provider sign-in (not demo mode)
4. Study sessions, decks, and folders are stored under the user's `owner_id`
5. Guest data (before sign-in) is migrated on login automatically
