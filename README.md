Group Hangman - real-time multiplayer hangman

Overview
--
This repo contains a starter for "Group Hangman": a realtime, password-protected room game where each player sets a secret word and others guess.

Stack
--
- React + Vite (frontend)
- Firebase Realtime Database (realtime, no custom server)
- Vercel (free hosting for front-end)

Quick start
--
1. Install dependencies:

   npm install

2. Add Firebase config: open `src/firebase.js` and paste your project's config.
    You must include either `databaseURL` or `projectId` in the config for the Realtime Database to work.
    Example `firebaseConfig` (replace values):

    {
       apiKey: 'ABC...',
       authDomain: 'your-project.firebaseapp.com',
       databaseURL: 'https://your-project-default-rtdb.firebaseio.com',
       projectId: 'your-project',
       // ...other fields
    }

    If you don't add the config the app will still load in local mode but realtime features will be disabled until you paste the values and restart the dev server.

Environment (.env) setup (recommended)
--
Create a file named `.env.local` in the project root and add your Firebase config as Vite env vars (they must start with VITE_):

```
VITE_FIREBASE_API_KEY=your_api_key
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

After creating `.env.local`, restart the dev server so Vite picks up the new env variables.

3. Run dev server:

   npm run dev

Deploy to Vercel
--
1. Create a Vercel account (free) and connect your GitHub repo.
2. Set environment variables if needed (none required for frontend-only with public Firebase).
3. Deploy the main branch.

Notes and next steps
--
- The code includes a minimal Firebase hook `useGameRoom.js` that writes to `rooms/{roomId}`. It is a scaffold — you must implement server-side rules, authentication, and proper transaction logic in the database rules console.
- Validate words using a dictionary API or a client-side word list before accepting them.
- Password protection should store only a hash of the password in the DB (use bcrypt on a server). For a serverless approach you can derive a room key client-side from the password with a KDF (e.g. PBKDF2) and write only the derived key.

Server-side guess processing (recommended)
--
This repo includes a Firebase Cloud Function that processes guess queue entries authoritatively so clients cannot cheat. The function lives in `functions/index.js` and listens to `rooms/{roomId}/queue/{pushId}`. To deploy:

1) Install functions dependencies and deploy:

```bash
cd functions
npm install
firebase deploy --only functions:processGuess
```

2) Update your Realtime Database rules so clients cannot write to `players/*/revealed`, `players/*/hangmoney`, `players/*/eliminated`, or `rooms/*/turnOrder` directly. Let the Cloud Function be the authoritative updater for those fields.

If you'd like, I can add a recommended `database.rules.json` snippet tuned for this function — tell me if you want that and I'll add it next.
