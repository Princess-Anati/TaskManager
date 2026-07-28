# Deploying Taskly permanently (free tier)

This gets Taskly off "my laptop + a temporary tunnel" and onto real,
always-on hosting, so it's usable without anyone needing to keep a dev
session running. Everything below fits on free tiers.

**Stack**: Supabase (Postgres) + Cloudflare R2 (file/avatar storage) +
Render (backend) + Cloudflare Pages (frontend).

**Time**: ~30-45 minutes, mostly account creation and copy-pasting values.

---

## 0. What you'll end up with

- A permanent database that doesn't expire (unlike some free-tier DBs that
  auto-delete after 90 days of inactivity).
- Uploaded files/avatars that survive redeploys (local disk on most free
  hosts gets wiped on every restart — this is why R2 is in the stack).
- A backend URL like `https://taskly-api.onrender.com`.
- A frontend URL like `https://taskly.pages.dev` (or a custom domain later).

**One honest tradeoff of the free tier**: Render's free web services spin
down after ~15 minutes of no traffic and take ~30-60 seconds to wake back up
on the next request. The app will feel instant most of the time, but the
first request after a quiet period will be slow. There's no code fix for
this — it's a Render free-tier limitation. If that's a dealbreaker, Render's
cheapest paid tier ($7/mo) removes it; nothing else in this guide changes.

---

## 1. Database — Supabase

1. Go to supabase.com, sign up, **New Project**.
2. Pick a name and a strong database password (save it — you'll need it in
   step 4). Pick a region close to where you'll deploy the backend (step 3)
   to minimize latency between them.
3. Once it's provisioned: **Project Settings → Database → Connection
   string** → copy the **URI** format (starts with `postgresql://`), and
   swap in the password you set. This is your `DATABASE_URL`.
   - Use the **connection pooler** string (port 6543, has `?pgbouncer=true`)
     if offered — Render's free tier + serverless-style connections behave
     better with it than a direct connection.

## 2. File/avatar storage — Cloudflare R2

1. Go to the Cloudflare dashboard → **R2** (left sidebar). Free tier: 10GB
   storage, no egress fees — plenty for this app.
2. **Create bucket** — name it e.g. `taskly-uploads`. Note the **Account
   ID** shown on the R2 overview page.
3. **Manage R2 API Tokens → Create API Token** — permissions: Object
   Read & Write, scoped to the bucket you just made. Copy the **Access Key
   ID** and **Secret Access Key** when shown (the secret is only shown
   once).
4. Your R2 env vars:
   - `R2_BUCKET` = the bucket name (`taskly-uploads`)
   - `R2_ENDPOINT` = `https://<account-id>.r2.cloudflarestorage.com`
   - `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` = from the token you created

## 3. Backend — Render

1. render.com, sign up, connect your GitHub account, grant it access to
   the `TaskManager` repo (your fork).
2. **New → Web Service** → pick the repo → branch
   `feature/taskly-modernization-and-platform-completion` (or whatever
   you've merged to by then).
3. Settings:
   - **Root Directory**: `backend`
   - **Build Command**: `npm install && npx prisma generate && npm run build`
   - **Pre-Deploy Command**: `npx prisma migrate deploy` (runs migrations
     automatically on every deploy — you never need to run this by hand)
   - **Start Command**: `npm start`
   - **Instance Type**: Free
4. **Environment** tab — add these (values from steps 1-2, plus generate
   the rest):
   ```
   DATABASE_URL=<from Supabase>
   JWT_SECRET=<a long random string — e.g. `openssl rand -hex 32`>
   CORS_ORIGIN=<your Pages URL from step 4, e.g. https://taskly.pages.dev>
   APP_URL=<same as CORS_ORIGIN>
   VAPID_PUBLIC_KEY=<generate: npx web-push generate-vapid-keys>
   VAPID_PRIVATE_KEY=<from the same command>
   VAPID_SUBJECT=mailto:you@example.com
   REMINDER_POLL_INTERVAL_MS=30000
   R2_BUCKET=<from step 2>
   R2_ENDPOINT=<from step 2>
   R2_ACCESS_KEY_ID=<from step 2>
   R2_SECRET_ACCESS_KEY=<from step 2>
   NODE_ENV=production
   ```
   Optional (payments — the app already runs fine without these, each
   provider's own checkout/webhook routes just 503 until its keys are set,
   independently of the others). See `backend/.env.example` for exactly
   where to get each value:
   ```
   STRIPE_SECRET_KEY=
   STRIPE_WEBHOOK_SECRET=
   STRIPE_PRICE_PREMIUM_MONTHLY=
   STRIPE_PRICE_PREMIUM_ANNUAL=
   STRIPE_PRICE_TEAM_MONTHLY=
   STRIPE_PRICE_TEAM_ANNUAL=
   PAYPAL_CLIENT_ID=
   PAYPAL_CLIENT_SECRET=
   PAYPAL_API_BASE=https://api-m.paypal.com   # sandbox by default — switch to live once ready
   PAYPAL_WEBHOOK_ID=
   FLUTTERWAVE_SECRET_KEY=
   FLUTTERWAVE_SECRET_HASH=
   ```
   Once the backend has a public Render URL (after step 5 below), register
   each provider's webhook against it:
   - Stripe: `https://<your-service>.onrender.com/api/payments/stripe/webhook`
   - PayPal: `https://<your-service>.onrender.com/api/payments/paypal/webhook`
   - Flutterwave: `https://<your-service>.onrender.com/api/payments/flutterwave/webhook`

   Optional (transactional email — invitations get logged to the console
   instead of emailed without it): `RESEND_API_KEY`, `EMAIL_FROM`.
5. **Create Web Service**. First deploy takes a few minutes. Once live,
   note the URL (`https://<something>.onrender.com`) — that's `API_ORIGIN`
   for step 4.

## 4. Frontend — Cloudflare Pages

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to
   Git** → pick the repo/branch.
2. Build settings:
   - **Root directory**: `frontend`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
3. **Environment variables** (Pages project settings, not the Worker
   runtime ones): add `API_ORIGIN` = your Render URL from step 3 (no
   trailing slash). This is read at *build time* by `vite.config.ts` to
   generate `_redirects`, which makes `/api/*` requests from the frontend
   transparently proxy to the backend — so the browser only ever talks to
   one origin (your Pages URL), keeping every existing relative `/api/...`
   call in the codebase working unchanged.
4. **Save and Deploy**.
5. Once live, go back to Render (step 3) and update `CORS_ORIGIN`/`APP_URL`
   to the real Pages URL if you used a placeholder, then trigger a redeploy.

## 5. Verify

- Visit the Pages URL. You should land on the marketing page (not a login
  redirect — see the earlier PWA `start_url` fix).
- Register an account, create a workspace, create a task.
- Settings → upload a profile photo → refresh the page → it should still
  be there (confirms R2 is wired correctly, not falling back to Render's
  ephemeral disk).
- Install the PWA from this URL — now that it's a stable domain, the
  install stays working indefinitely (no more "the tunnel died" issue).

## Troubleshooting

- **"Route not found" on every `/api/*` call from the Pages site**: check
  `API_ORIGIN` was actually set in Pages' build-time env vars before the
  last deploy (changing it requires a redeploy to regenerate
  `_redirects`), and that it has no trailing slash.
- **Avatar/file uploads 500**: check all four `R2_*` vars are set on
  Render — the backend silently falls back to local disk if even one is
  missing (logged at boot: `[storage] R2_BUCKET/... not fully set —
  falling back to local disk`), which "works" until the next redeploy
  wipes it.
- **Push notifications don't arrive**: confirm `VAPID_PUBLIC_KEY` matches
  between what the backend serves at `/api/push/vapid-public-key` and
  what's configured — they're generated as a pair, don't mix keys from
  different `generate-vapid-keys` runs.
- **CORS errors in the browser console**: this should be rare given the
  same-origin proxy setup — it usually means something is calling the
  Render URL directly instead of through the Pages proxy. Check
  `CORS_ORIGIN` on Render matches the Pages URL exactly (including
  `https://`, no trailing slash) as a fallback.
