# BipoAi Clone (Prototype)

This workspace contains a static front-end and a small Express mock API to demo core BipoAi features:

- Upload files -> mock flashcards
- Upload audio -> mock notes
- Generate quizzes from text (mock)
- Download a mock Anki export

Quick start:

1. Install dependencies (once)

```bash
cd ~/Projects/BipAi
npm install
```

If `npm` is not on your PATH (common in some terminals), use Cursor’s bundled Node:

```bash
./start.sh
```

2. Start the server

```bash
npm start
# or
./start.sh
```

3. Open the site

- Dashboard: http://localhost:3001/dashboard.html
- Study: http://localhost:3001/study.html
- Home: http://localhost:3001/index.html

Default port is **3001** (set `PORT` in `.env`).

Notes:
- The server is a mock prototype. Replace processing logic in `server.js` with real PDF/audio parsing and AI model calls to implement production features.
- For production, add user auth, storage, rate-limiting, and a real ML backend.
