This folder contains Firebase Cloud Functions for the Group Hangman project.

processGuess function
---------------------
- Trigger: Realtime Database `onCreate` at `/rooms/{roomId}/queue/{pushId}`.
- Purpose: Validate and process guesses (letters and full words) authoritatively.
  - Correct letter: reveal it in `players/{targetId}/revealed`, award +2 wordmoney to the guesser, add `guessedBy[letter]` entry for the target, record private hit for the guesser.
  - Wrong letter: record under `players/{guesserId}/privateWrong/{targetId}` (private to guesser).
  - Correct word: reveal all letters, award +5, set `players/{targetId}/eliminated = true`, record `guessedBy.__word`, remove player from `turnOrder`, adjust `currentTurnIndex`.
  - Wrong word: record under `players/{guesserId}/privateWrongWords/{targetId}` (private to guesser).
- After processing, the queue item is removed.

Deploy
------
From the repository root (you must have Firebase CLI installed and be logged in):

1) Change to functions folder and install deps:

```bash
cd functions
npm install
```

2) Deploy functions only:

```bash
firebase deploy --only functions:processGuess
```

Make sure your `firebase.json` has functions configured and your Firebase project is selected `firebase use <project-id>`.

Security note
-------------
- This function assumes that clients cannot directly modify `players/*/revealed`, `players/*/wordmoney`, etc. You should tighten your Realtime Database rules to prevent client writes to those fields except where appropriate. Using Cloud Functions centralizes authority for guess processing and prevents cheating.
