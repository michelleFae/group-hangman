Group Hangman - real-time multiplayer hangman (Underword)

Overview
--
This repo is a realtime, password-protected Group Hangman game built with React + Vite and Firebase Realtime Database. It includes two ways to run the authoritative guess processor:

- A Vercel-friendly serverless HTTP handler at `api/processGuess.js` (recommended for easy deployment on Vercel).
- A reference Firebase Cloud Functions implementation under `functions/` (optional; useful if you prefer Firebase functions or scheduled jobs).

Stack
--
- React + Vite (frontend)
- Firebase Realtime Database (realtime state)
- Vercel (recommended hosting for frontend + serverless API)

Quick start (local)
--
1. Install dependencies:

   npm install

2. Add Firebase config: open `src/firebase.js` and paste your project's client config. Ensure it includes `databaseURL` or `projectId` for Realtime Database access.

3. (optional) Create `.env.local` with Vite-friendly env vars (prefix with VITE_):

```
VITE_FIREBASE_API_KEY=your_api_key
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

4. Run dev server:

```powershell
npm run dev
```

Open http://localhost:5173 and test the app.

Run the local API server (dev only)
--
If you need the local Express helper that serves `/api/*` endpoints (dictionary, validate-animal), run the server in a separate terminal:

```bash
npm install        # only if you haven't installed node_modules yet
node server.js
```

Note on authoritative processing
--
Client guesses are either (A) sent to a serverless API (`/api/processGuess`) when `VITE_USE_SERVERLESS` is set to `1`/`true`, or (B) pushed into the Realtime DB queue `rooms/{roomId}/queue` (fallback). In the latter case you need a consumer to process the queue (either the Cloud Function in `functions/` or a worker you run). Without a consumer, queued guesses won't be processed.

Deploying to Vercel (serverless)
--
This repo is ready to deploy to Vercel. The serverless handler `api/processGuess.js` is compatible with Vercel Functions and will be deployed alongside the frontend automatically.

Environment variables to set in Vercel (Project Settings > Environment Variables):

- FIREBASE_SERVICE_ACCOUNT (required for serverless handler)
  - The JSON service account credentials for a Firebase service account that has Database Admin privileges. You may paste the raw JSON or a base64-encoded JSON string.
- FIREBASE_DATABASE_URL (required for serverless handler)
  - Example: `https://your-project-id.firebaseio.com`
- VITE_USE_SERVERLESS (client-side toggle)
  - Set to `1` or `true` to make the client call `/api/processGuess` instead of pushing into the DB queue.

Steps to deploy:
1. Import this repository into Vercel (or connect via GitHub).
2. Add the three environment variables above in the Project > Environment Variables panel.
3. Set Build Command: `npm run build` and Output Directory: `dist`.
4. Deploy (Vercel will publish the frontend and the serverless function at `/api/processGuess`).

Local serverless testing with Vercel CLI
--
You can test the serverless function locally with the Vercel CLI:

```powershell
# install vercel CLI if necessary
npm i -g vercel
# run the project locally with serverless functions
vercel dev
```

Ensure your environment variables (FIREBASE_SERVICE_ACCOUNT, FIREBASE_DATABASE_URL, VITE_USE_SERVERLESS) are available to `vercel dev` (via shell env or a local env file).

Firebase emulator (optional)
--
If you prefer to run things locally without deploying to Vercel, use the Firebase emulator to test database and functions behaviour.

```powershell
npm i -g firebase-tools
firebase login
firebase init emulators
firebase emulators:start --only database,functions
```

Notes: the emulator lets you run the Cloud Functions reference in `functions/index.js` without enabling Blaze in your Firebase project.

Environment variables (summary)
--
- FIREBASE_SERVICE_ACCOUNT: JSON or base64 JSON of a service account with Database Admin privileges (required by `api/processGuess.js`).
- FIREBASE_DATABASE_URL: Realtime Database URL (required by `api/processGuess.js`).
- VITE_USE_SERVERLESS: `1` or `true` to enable serverless processing from the client.

How guesses are processed (overview)
--
There are two supported approaches in this repo:

1. Serverless HTTP handler (recommended for Vercel) : `api/processGuess.js`:
   - Verifies the caller's Firebase ID token using Admin SDK.
   - Validates turn order, processes letter/word guesses, applies wordmoney changes, reveals letters, marks eliminations, and advances the turn.

2. Firebase Cloud Function / queue consumer : `functions/index.js`:
   - Reference implementation that consumes the DB queue and can also run scheduled jobs for timed turns and eviction of stale anonymous players.
   - Useful if you prefer Firebase-native execution or need scheduled background jobs. Some scheduled features may require Blaze.

Frontend notes and behavior
--
- Anonymous players: an anonymous player id is stored in localStorage under `gh_anon_<roomId>` so a refresh will reattach the same player node if present server-side.
- Pending timeout penalties: frontend displays temporary pending -2 deductions when timeouts are observed; the UI clears the pending marker only after the DB reflects the deduction.
- Word bonus: the host can enable a word bonus when starting the game; the client awards and displays the word bonus as part of the submit/start flow.

Security & rules
--
You should lock down your Realtime Database rules so clients cannot directly modify authoritative game fields (wordmoney, eliminated, revealed, turnOrder, etc.). Use the serverless handler or Cloud Function as the only trusted writer for those fields.

Troubleshooting & tips
--
- If the client keeps pushing to the DB queue but nothing happens, verify you have either deployed the serverless function (and set `VITE_USE_SERVERLESS=true`) or deployed/started a queue consumer (Cloud Function or worker).
- For Vercel deployments make sure `FIREBASE_SERVICE_ACCOUNT` is present and correctly formatted (JSON vs base64). If the serverless function logs "Missing FIREBASE_SERVICE_ACCOUNT", check that variable.
- If anonymous rejoin fails after refresh, check localStorage for `gh_anon_<roomId>` and confirm the corresponding player node still exists in the DB.

Debugging extra timeout penalties
--
If you see duplicate or extra -2 timeout penalties, enable extra logging:

- Client-side (in browser console):
  - Open DevTools and run:

```javascript
localStorage.setItem('gh_debug_timeouts', '1')
```

  - The client will log when the host's TimerWatcher considers writing a timeout, when it skips due to an existing timeout entry, and the details of the timeout it writes.

- Server-side (Cloud Functions / Vercel):
  - For Firebase Functions, check function logs with `firebase functions:log` or in the Firebase Console -> Functions -> Logs.
  - For the serverless handler deployed to Vercel, use the Vercel dashboard's function logs or `vercel logs <deployment-url>`.
  - The server-side `advanceTimedTurns` scheduled job now logs existing timeout keys per room, why it skips duplicates, and when it applies a penalty (including the `turnStartedAt` it used).

Contributing
--
Contributions welcome. Open an issue or PR with a clear description of the change.

License
--
MIT
