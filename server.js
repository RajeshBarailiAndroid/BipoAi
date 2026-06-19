const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
require('dotenv').config();

const {
  verifyGoogleAuthCode,
  verifyGoogleIdToken,
  verifyAppleIdentityToken,
  getPublicAuthConfig,
  createDemoAuthResponse,
  createSessionToken
} = require('./auth');
const gemini = require('./gemini');
const supabase = require('./supabase');
const { requireOwner, resolveOwnerId } = require('./owner');
const { extractUrlStudyText, detectUrlType } = require('./urlContent');

async function finalizeAuth(auth) {
  if (!auth?.user?.id || !supabase.isSupabaseConfigured()) {
    return { ...auth, supabase: false };
  }
  try {
    await supabase.upsertProfile({
      id: auth.user.id,
      email: auth.user.email,
      name: auth.user.name,
      picture: auth.user.picture,
      provider: auth.user.provider || 'email',
      plan: auth.user.plan || 'free'
    });
    return { ...auth, supabase: true };
  } catch (err) {
    console.warn('Supabase profile sync:', err.message);
    return { ...auth, supabase: false, supabaseError: err.message };
  }
}

const PODCAST_AUDIO_DIR = path.join(__dirname, 'uploads', 'podcasts');

function savePodcastAudioFile(audioBase64) {
  if (!audioBase64) return null;
  const wav = Buffer.from(audioBase64, 'base64');
  if (!wav.length) return null;
  fs.mkdirSync(PODCAST_AUDIO_DIR, { recursive: true });
  const id = `podcast-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`;
  const filePath = path.join(PODCAST_AUDIO_DIR, id);
  fs.writeFileSync(filePath, wav);
  return `/api/podcast/stream/${id}`;
}

/** Omit huge base64 blobs from API payloads when a stream URL is available. */
function clientAudioPayload(audio) {
  if (!audio) return null;
  const out = {
    mimeType: audio.mimeType,
    hosts: audio.hosts,
    voices: audio.voices
  };
  if (audio.audioUrl) out.audioUrl = audio.audioUrl;
  else if (audio.audioBase64) out.audioBase64 = audio.audioBase64;
  return out;
}

function slimPodcastForDb(podcast) {
  if (!podcast || typeof podcast !== 'object') return podcast || null;
  const clone = JSON.parse(JSON.stringify(podcast));
  if (clone.audio?.audioBase64 && clone.audio?.audioUrl) delete clone.audio.audioBase64;
  return clone;
}

function studyInputLabel(inputType, notes, text, files, urlMeta) {
  if (inputType === 'audio') return notes?.source || files[0]?.originalname || 'Audio lecture';
  if (inputType === 'text') return notes?.source || 'Pasted text';
  if (inputType === 'url') return urlMeta?.source || notes?.source || 'Web link';
  return notes?.source || files.map((f) => f.originalname).filter(Boolean).join(', ') || 'Uploaded files';
}

function humanizeFilename(name) {
  return String(name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveSessionName(userName, { notes = {}, files = [], text = '', urlMeta = null, inputType = 'files' } = {}) {
  const given = String(userName || '').trim();
  if (given) return given.slice(0, 80);

  if (urlMeta?.title) return String(urlMeta.title).trim().slice(0, 80);

  if (inputType === 'audio' && files[0]?.originalname) {
    const audioName = humanizeFilename(files[0].originalname);
    if (audioName && !/^recording[-\s]?\d+$/i.test(audioName)) return audioName.slice(0, 80);
    return 'Lecture recording';
  }

  if (files.length === 1) {
    return humanizeFilename(files[0].originalname).slice(0, 80) || 'Uploaded file';
  }
  if (files.length > 1) {
    const first = humanizeFilename(files[0].originalname);
    return (first ? `${first} + ${files.length - 1} more` : `${files.length} files`).slice(0, 80);
  }

  if (text) {
    const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (line) return line.slice(0, 80);
    return 'Pasted notes';
  }

  const noteTitle = String(notes?.title || '').trim();
  if (noteTitle && noteTitle !== 'Study session') {
    return noteTitle.replace(/^Smart notes from\s+/i, '').slice(0, 80);
  }

  return `Study session — ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

async function persistStudySessionForOwner(ownerId, result, meta = {}) {
  if (!ownerId || !supabase.isSupabaseConfigured()) return null;
  const { notes = {}, quiz = {}, flashcards = [], podcast = {} } = result;
  const inputType = meta.inputType || result.inputType || 'files';
  const inputText = (meta.inputText || result.inputText || result.sourceText || '').slice(0, 50000);
  const name = resolveSessionName(meta.name, {
    notes,
    files: meta.files || [],
    text: meta.rawText || inputText,
    urlMeta: meta.urlMeta,
    inputType
  });
  const session = {
    id: meta.id || `session-${Date.now()}`,
    name,
    createdAt: Date.now(),
    source: meta.source || studyInputLabel(inputType, notes, meta.rawText || '', meta.files || [], meta.urlMeta),
    inputType,
    inputText,
    audioUrl: meta.audioUrl || result.audioUrl || null,
    cardCount: flashcards.length,
    quizCount: quiz.questions?.length || 0,
    notes,
    quiz,
    flashcards,
    podcast: slimPodcastForDb(podcast),
    sourceText: (result.sourceText || inputText || '').slice(0, 50000)
  };
  return supabase.upsertStudySession(ownerId, session);
}

async function tryGemini(fn) {
  if (!gemini.shouldUseGemini()) return null;
  try {
    return await fn();
  } catch (err) {
    if (gemini.isAuthError(err)) {
      gemini.markUnavailable();
      console.warn('Gemini auth failed — using offline fallback.');
      console.warn(gemini.authHelpMessage());
      return null;
    }
    if (gemini.isRetryableError && gemini.isRetryableError(err)) {
      console.warn('Gemini busy after trying all API keys — using offline fallback.');
      return null;
    }
    throw err;
  }
}

const app = express();
const upload = multer({ dest: path.join(__dirname, 'uploads/') });
app.use(cors());
app.use(express.json());

// Gemini connection status
app.get('/api/gemini/status', async (req, res) => {
  const key = gemini.getApiKey ? gemini.getApiKey() : '';
  const status = await gemini.verifyConnection();
  const db = await supabase.verifyConnection();
  res.json({
    connected: status.ok,
    mode: status.mode || gemini.getAuthMode(),
    reason: status.reason || (status.ok ? 'ok' : 'unknown'),
    message: status.message || (status.ok ? 'Gemini API connected' : 'Gemini not connected'),
    keyConfigured: Boolean(key),
    keyCount: gemini.getApiKeyCount ? gemini.getApiKeyCount() : (key ? 1 : 0),
    keysActive: status.keysActive ?? (status.ok ? 1 : 0),
    failoverEnabled: (gemini.getApiKeyCount ? gemini.getApiKeyCount() : 0) > 1,
    keyPrefix: key ? key.slice(0, 4) : null,
    vertexConfigured: gemini.useVertexAI ? gemini.useVertexAI() : false,
    database: db
  });
});

// Supabase database status
app.get('/api/db/status', async (req, res) => {
  res.json(await supabase.verifyConnection());
});

// Gemini chat (gemini-2.5-flash) — direct API, surfaces Google errors
app.post('/api/chat', async (req, res) => {
  const { message, context } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Message is required' });

  try {
    if (gemini.isGeminiEnabled()) {
      const reply = await gemini.generateChat(message, context);
      return res.json({ reply });
    }
  } catch (error) {
    if (!gemini.isAuthError(error)) {
      console.error('Gemini API Error details:', error);
      return res.status(500).json({ error: error.message || 'API processing failed' });
    }
  }

  const snippet = (context || '').trim().slice(0, 120);
  res.json({
    reply: snippet
      ? `Based on your material (${snippet}${context.length > 120 ? '…' : ''}), focus on the main idea and try explaining it in your own words. (AI tutor offline — connect Gemini for full answers.)`
      : 'Connect Gemini in .env to use the AI tutor. For now, review your notes and quiz tabs above.'
  });
});

// Direct Gemini solve text (gemini-2.5-pro)
app.post('/api/solve/text', async (req, res) => {
  const { problem } = req.body || {};
  if (!problem) return res.status(400).json({ error: 'Problem description is required' });
  if (!gemini.isGeminiEnabled()) {
    return res.status(503).json({ error: 'Set GEMINI_API_KEY in .env' });
  }

  try {
    const solution = await gemini.generateSolveText(problem);
    res.json({ solution });
  } catch (error) {
    console.error('Gemini Solve Error details:', error);
    res.status(500).json({ error: error.message || 'API processing failed' });
  }
});

// Upload and return generated flashcards
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const filename = req.file && req.file.originalname ? req.file.originalname : 'unknown';
  try {
    if (req.file) {
      const items = await tryGemini(() => gemini.generateFlashcardsFromFile(req.file));
      if (items) return res.json({ type: 'flashcards', items });
    }
    const flashcards = [
      { q: 'What is spaced repetition?', a: 'A learning technique where reviews are spaced over increasing intervals.' },
      { q: 'What is active recall?', a: 'Actively retrieving information to strengthen memory.' },
      { q: 'Source file', a: filename }
    ];
    res.json({ type: 'flashcards', items: flashcards });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Flashcard generation failed.' });
  }
});

// Audio upload -> notes
app.post('/api/audio', upload.single('audio'), async (req, res) => {
  const fileUrl = req.file ? `/uploads/${req.file.filename}` : null;
  try {
    if (req.file) {
      const generated = await tryGemini(() => gemini.generateNotesFromAudio(req.file));
      if (generated) {
        return res.json({
          type: 'notes',
          notes: {
            ...generated,
            file: fileUrl,
            originalName: req.file.originalname || null
          }
        });
      }
    }
    const notes = {
      title: 'Lecture notes (mock)',
      bullets: [
        'Key concept A explained with example',
        'Important definition: mock definition',
        'Summary: review sections 2 and 3'
      ],
      file: fileUrl,
      originalName: req.file ? req.file.originalname : null
    };
    res.json({ type: 'notes', notes });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Audio notes generation failed.' });
  }
});

// List uploaded files (simple directory listing)
app.get('/api/uploads', (req, res) => {
  const dir = path.join(__dirname, 'uploads');
  fs.readdir(dir, (err, files) => {
    if (err) return res.status(500).json({ error: 'failed' });
    const items = files.map(f => {
      const p = path.join(dir, f);
      const stat = fs.statSync(p);
      return { name: f, url: `/uploads/${f}`, size: stat.size, mtime: stat.mtime };
    });
    res.json({ items });
  });
});

// Text -> quiz generation
app.post('/api/quiz', async (req, res) => {
  const { text } = req.body || {};
  try {
    if (text) {
      const quiz = await tryGemini(() => gemini.generateQuiz(text));
      if (quiz) {
        quiz.source = text.substring(0, 120);
        return res.json({ type: 'quiz', quiz });
      }
    }
    const quiz = {
      title: 'Sample Quiz (mock)',
      questions: [
        { q: 'Which technique improves long-term retention?', options: ['Rereading', 'Spaced repetition', 'Highlighting'], answer: 1 },
        { q: 'Active recall is?', options: ['Passive review', 'Active retrieval', 'Note copying'], answer: 1 }
      ]
    };
    if (text) quiz.source = text.substring(0, 120);
    res.json({ type: 'quiz', quiz });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Quiz generation failed.' });
  }
});

// Text -> study podcast episode
app.post('/api/podcast', async (req, res) => {
  const { text, title, style } = req.body || {};
  const source = (text || '').trim();
  try {
    if (source) {
      const podcast = await tryGemini(() => gemini.generatePodcast({ text: source, title, style }));
      if (podcast) {
        podcast.source = source.substring(0, 160);
        return res.json({ type: 'podcast', podcast });
      }
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Podcast generation failed.' });
  }
  const styleKey = (style || 'conversational').toLowerCase();
  const styleLabels = {
    conversational: 'Conversational',
    lecture: 'Lecture style',
    interview: 'Interview'
  };
  const hostsByStyle = {
    conversational: ['Alex', 'Sam'],
    lecture: ['Dr. Lee'],
    interview: ['Host', 'Guest expert']
  };
  const hosts = hostsByStyle[styleKey] || hostsByStyle.conversational;
  const episodeTitle = (title || '').trim() || 'Study podcast episode (mock)';
  const snippet = source ? source.substring(0, 120) : 'your uploaded study material';

  const podcast = {
    title: episodeTitle,
    duration: '11:42',
    style: styleKey,
    styleLabel: styleLabels[styleKey] || styleLabels.conversational,
    hosts,
    description: `An AI-generated ${styleLabels[styleKey] || 'study'} podcast based on ${snippet}${source.length > 120 ? '...' : ''}.`,
    segments: [
      { time: '0:00', title: 'Welcome', summary: 'Hosts introduce the topic and what you will review in this episode.' },
      { time: '1:15', title: 'Core concepts', summary: 'Main ideas from your material explained in plain language.' },
      { time: '4:40', title: 'Key definitions', summary: 'Important terms and how they connect to the bigger picture.' },
      { time: '7:55', title: 'Practice recap', summary: 'Quick review questions to check understanding before the outro.' },
      { time: '10:30', title: 'Wrap-up', summary: 'Summary of takeaways and suggested next steps for studying.' }
    ],
    script: styleKey === 'lecture'
      ? [
          { speaker: hosts[0], text: `Welcome to today's lecture review. We'll walk through the essential points from your notes.` },
          { speaker: hosts[0], text: 'First, focus on the core concept and why it matters for your exam or assignment.' },
          { speaker: hosts[0], text: 'Next, remember the key definition and try explaining it in your own words.' },
          { speaker: hosts[0], text: 'Before you finish, quiz yourself on the practice recap section.' }
        ]
      : styleKey === 'interview'
        ? [
            { speaker: hosts[0], text: 'Thanks for joining us. What should students focus on first from this material?' },
            { speaker: hosts[1], text: 'Start with the main idea, then connect it to the supporting examples in your notes.' },
            { speaker: hosts[0], text: 'What is the most common mistake people make here?' },
            { speaker: hosts[1], text: 'Skipping the definitions. Those terms usually show up again in harder questions.' },
            { speaker: hosts[0], text: 'Great advice. Review the recap, then test yourself with a short quiz.' }
          ]
        : [
            { speaker: hosts[0], text: `Hey ${hosts[1]}, ready to turn this study set into a quick podcast review?` },
            { speaker: hosts[1], text: 'Absolutely. The big idea here is to connect the main concept to real examples.' },
            { speaker: hosts[0], text: 'And the definition we need to remember is the one highlighted in the notes.' },
            { speaker: hosts[1], text: 'Right. Pause after each chapter and say the answer out loud — that helps retention.' },
            { speaker: hosts[0], text: 'Perfect. Let us wrap with a fast recap before your next study session.' }
          ],
    source: source ? source.substring(0, 160) : null
  };

  res.json({ type: 'podcast', podcast });
});

// Generate two-voice podcast audio (Alex male, Sam female) from script
app.post('/api/podcast/audio', async (req, res) => {
  const { podcast, text, title, style } = req.body || {};
  try {
    let episode = podcast;
    if (!episode?.script?.length && (text || '').trim()) {
      episode = await tryGemini(() => gemini.generatePodcast({ text: text.trim(), title, style }));
    }
    if (!episode?.script?.length) {
      return res.status(400).json({ error: 'No podcast script available for voice generation.' });
    }

    episode.hosts = ['Alex', 'Sam'];
    const audio = await tryGemini(() => gemini.generatePodcastAudio(episode));
    if (audio?.audioBase64) {
      audio.audioUrl = savePodcastAudioFile(audio.audioBase64);
      episode.audio = clientAudioPayload({
        mimeType: audio.mimeType,
        audioUrl: audio.audioUrl,
        audioBase64: audio.audioBase64,
        hosts: audio.hosts,
        voices: audio.voices
      });
    }

    res.json({
      type: 'podcast-audio',
      podcast: episode,
      audio: clientAudioPayload(episode.audio),
      message: episode.audio ? null : 'Voice generation unavailable. Use browser playback.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Podcast audio generation failed.' });
  }
});

app.get('/api/podcast/stream/:file', (req, res) => {
  const safeName = path.basename(req.params.file || '');
  if (!safeName.endsWith('.wav')) return res.status(400).json({ error: 'Invalid audio file.' });
  const filePath = path.join(PODCAST_AUDIO_DIR, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Audio not found.' });
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(filePath);
});

// Solve math, physics, and complex problems with step-by-step explanations
function trySimpleMath(problem) {
  const trimmed = (problem || '').trim();
  const expr = trimmed.replace(/\s+/g, '');
  if (!expr || !/^[\d+\-*/().]+$/.test(expr)) return null;
  try {
    const value = Function('"use strict"; return (' + expr + ')')();
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return {
      title: 'Math solution',
      answer: String(value),
      steps: [
        { step: 1, title: 'Read the expression', detail: `Evaluate: ${trimmed}` },
        { step: 2, title: 'Calculate', detail: `${trimmed} = ${value}` },
        { step: 3, title: 'Verify', detail: 'Check that the arithmetic is correct.' }
      ],
      problem: trimmed.slice(0, 240),
      subject: 'math'
    };
  } catch {
    return null;
  }
}

function tryPhysicsKinematics(problem) {
  const text = (problem || '').trim();
  const uKmh = text.match(/(\d+(?:\.\d+)?)\s*km\/h/i);
  const aMatch = text.match(/(-?\d+(?:\.\d+)?)\s*m\/s²?/i);
  if (!uKmh || !aMatch) return null;

  const uMs = parseFloat(uKmh[1]) * (5 / 18);
  const a = parseFloat(aMatch[1]);
  if (!a) return null;

  const s = (0 - uMs * uMs) / (2 * a);
  if (!Number.isFinite(s) || s < 0) return null;

  const uRounded = uMs.toFixed(2);
  const sRounded = s.toFixed(1);

  return {
    title: 'Physics: Motion (Kinematics)',
    question: text.slice(0, 500),
    given: [
      `Initial velocity u = ${uKmh[1]} km/h`,
      'Final velocity v = 0 m/s',
      `Acceleration a = ${a} m/s²`
    ],
    formula: 'v² = u² + 2as',
    steps: [
      {
        step: 1,
        title: 'Convert u to m/s',
        detail: `u = ${uKmh[1]} × (5/18) = ${uRounded} m/s`
      },
      {
        step: 2,
        title: 'Substitute values',
        detail: `0² = (${uRounded})² + 2(${a})s → 0 = ${(uMs * uMs).toFixed(1)} + ${(2 * a).toFixed(1)}s`
      },
      {
        step: 3,
        title: 'Solve for s',
        detail: `s = ${sRounded} meters`
      }
    ],
    answer: `${sRounded} meters`,
    problem: text.slice(0, 500),
    subject: 'physics'
  };
}

app.post('/api/solve', async (req, res) => {
  const { problem, subject } = req.body || {};
  const prompt = (problem || '').trim();
  const topic = (!subject || subject === 'auto') ? 'auto' : String(subject).toLowerCase();

  try {
    if (prompt) {
      const aiSolution = await tryGemini(() => gemini.solveProblem(prompt, topic));
      if (aiSolution) return res.json({ type: 'solution', solution: aiSolution });
      const physics = topic === 'physics' ? tryPhysicsKinematics(prompt) : null;
      if (physics) return res.json({ type: 'solution', solution: physics });
      const simple = trySimpleMath(prompt);
      if (simple) return res.json({ type: 'solution', solution: simple });
    }
  } catch (err) {
    console.error('Gemini solve error details:', err);
    const simple = trySimpleMath(prompt);
    if (simple) return res.json({ type: 'solution', solution: simple });
    return res.status(500).json({ error: err.message || 'Problem solving failed.' });
  }

  const templates = {
    math: {
      title: 'Math solution (mock)',
      answer: 'x = 4',
      steps: [
        { step: 1, title: 'Identify the equation', detail: 'Start with the given linear equation, e.g. 2x + 8 = 16.' },
        { step: 2, title: 'Isolate the variable term', detail: 'Subtract 8 from both sides: 2x = 8.' },
        { step: 3, title: 'Solve for x', detail: 'Divide both sides by 2: x = 4.' },
        { step: 4, title: 'Verify', detail: 'Substitute x = 4 back into the original equation to confirm both sides match.' }
      ]
    },
    physics: {
      title: 'Physics: Motion (Kinematics)',
      question: 'A train slows to rest under uniform acceleration. Find the stopping distance.',
      given: ['Initial velocity u = 40 km/h', 'Final velocity v = 0 m/s', 'Acceleration a = -0.5 m/s²'],
      formula: 'v² = u² + 2as',
      answer: '123.4 meters',
      steps: [
        { step: 1, title: 'Convert u to m/s', detail: 'u = 40 × (5/18) = 11.11 m/s' },
        { step: 2, title: 'Substitute values', detail: '0² = (11.11)² + 2(-0.5)s → 0 = 123.4 - 1s' },
        { step: 3, title: 'Solve for s', detail: 's = 123.4 meters' }
      ]
    },
    general: {
      title: 'Complex problem solution (mock)',
      answer: 'Solution found',
      steps: [
        { step: 1, title: 'Understand the problem', detail: 'Restate the question and identify what is being asked.' },
        { step: 2, title: 'Break it into sub-problems', detail: 'Split the task into smaller parts that can be solved independently.' },
        { step: 3, title: 'Solve each part', detail: 'Work through each sub-problem with reasoning shown at every step.' },
        { step: 4, title: 'Combine and check', detail: 'Merge partial results into a final answer and verify it makes sense.' }
      ]
    }
  };

  const solution = templates[topic] || templates.general;
  if (prompt) solution.problem = prompt.substring(0, 240);
  solution.subject = topic;

  res.json({ type: 'solution', solution });
});

// Email sign in
app.post('/api/auth/signin', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    if (supabase.isSupabaseAuthConfigured()) {
      const result = await supabase.signInWithEmail(email, password);
      const auth = await finalizeAuth({
        type: 'auth',
        user: result.user,
        token: createSessionToken(result.user)
      });
      return res.json({ ...auth, supabaseAuth: true });
    }

    const name = email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const userId = `email:${email.toLowerCase()}`;
    const user = { id: userId, email, name, plan: 'free', provider: 'email' };
    const auth = await finalizeAuth({
      type: 'auth',
      user,
      token: createSessionToken(user)
    });
    return res.json({ ...auth, supabaseAuth: false });
  } catch (err) {
    return res.status(401).json({ error: err.message || 'Sign in failed.' });
  }
});

// Email sign up
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    if (supabase.isSupabaseAuthConfigured()) {
      const result = await supabase.signUpWithEmail(email, password, name);
      if (result.needsEmailConfirmation) {
        return res.json({
          type: 'auth',
          needsEmailConfirmation: true,
          message: 'Account created. Check your email to confirm, then sign in.',
          user: result.user,
          supabaseAuth: true
        });
      }
      const auth = await finalizeAuth({
        type: 'auth',
        user: result.user,
        token: createSessionToken(result.user)
      });
      return res.json({ ...auth, supabaseAuth: true });
    }

    const userId = `email:${email.toLowerCase()}`;
    const user = {
      id: userId,
      email,
      name: (name || email.split('@')[0]).trim(),
      plan: 'free',
      provider: 'email'
    };
    const auth = await finalizeAuth({
      type: 'auth',
      user,
      token: createSessionToken(user)
    });
    return res.json({ ...auth, supabaseAuth: false });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Sign up failed.' });
  }
});

app.get('/api/auth/config', (req, res) => {
  res.json({
    ...getPublicAuthConfig(req),
    supabaseAuth: supabase.isSupabaseAuthConfigured(),
    supabaseStorage: supabase.isSupabaseConfigured()
  });
});

// Sign in with Google (authorization code or ID token from Google Identity Services)
app.post('/api/auth/google', async (req, res) => {
  try {
    const { code, idToken } = req.body || {};
    let auth;
    if (idToken) auth = await verifyGoogleIdToken(idToken);
    else if (code) auth = await verifyGoogleAuthCode(code);
    else return res.status(400).json({ error: 'Missing Google authorization code or ID token.' });
    res.json(await finalizeAuth(auth));
  } catch (err) {
    res.status(401).json({ error: err.message || 'Google sign-in failed.' });
  }
});

// Sign in with Apple (identity token from Sign in with Apple JS)
app.post('/api/auth/apple', async (req, res) => {
  try {
    const { idToken, name } = req.body || {};
    if (!idToken) {
      return res.status(400).json({ error: 'Missing Apple identity token.' });
    }
    const auth = await verifyAppleIdentityToken(idToken, name);
    res.json(await finalizeAuth(auth));
  } catch (err) {
    res.status(401).json({ error: err.message || 'Apple sign-in failed.' });
  }
});

// Demo provider sign-in when OAuth credentials are not configured yet
app.post('/api/auth/demo', async (req, res) => {
  const { provider, email, name } = req.body || {};
  const config = getPublicAuthConfig(req);

  if (!provider || !email) {
    return res.status(400).json({ error: 'Missing provider account details.' });
  }

  if ((provider === 'google' && config.googleEnabled) || (provider === 'apple' && config.appleEnabled)) {
    return res.status(400).json({ error: 'Use the provider sign-in popup for this account.' });
  }

  const auth = createDemoAuthResponse(provider, email, name);
  res.json(await finalizeAuth(auth));
});

// Move guest data to signed-in user after OAuth
app.post('/api/auth/migrate-guest', requireOwner, async (req, res) => {
  if (!supabase.isSupabaseConfigured()) {
    return res.json({ ok: true, migrated: 0, supabase: false });
  }
  try {
    const guestId = String(req.body?.guestId || '').trim();
    const result = await supabase.migrateGuestData(guestId, req.ownerId);
    res.json({ ok: true, ...result, supabase: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Guest migration failed.' });
  }
});

// --- Supabase-backed storage ---
function storageUnavailable(res) {
  return res.status(503).json({ error: 'Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env' });
}

app.get('/api/sessions', requireOwner, async (req, res) => {
  if (!supabase.isSupabaseConfigured()) return storageUnavailable(res);
  try {
    const sessions = await supabase.listStudySessions(req.ownerId);
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions', requireOwner, async (req, res) => {
  if (!supabase.isSupabaseConfigured()) return storageUnavailable(res);
  try {
    const session = await supabase.upsertStudySession(req.ownerId, req.body || {});
    res.json({ session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:id', requireOwner, async (req, res) => {
  if (!supabase.isSupabaseConfigured()) return storageUnavailable(res);
  try {
    const session = await supabase.getStudySession(req.ownerId, req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    res.json({ session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sessions/:id', requireOwner, async (req, res) => {
  if (!supabase.isSupabaseConfigured()) return storageUnavailable(res);
  try {
    await supabase.deleteStudySession(req.ownerId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/decks', requireOwner, async (req, res) => {
  if (!supabase.isSupabaseConfigured()) return storageUnavailable(res);
  try {
    const decks = await supabase.listDecks(req.ownerId);
    res.json({ decks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/decks', requireOwner, async (req, res) => {
  if (!supabase.isSupabaseConfigured()) return storageUnavailable(res);
  try {
    const deck = await supabase.upsertDeck(req.ownerId, req.body || {});
    res.json({ deck });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/decks/:id', requireOwner, async (req, res) => {
  if (!supabase.isSupabaseConfigured()) return storageUnavailable(res);
  try {
    await supabase.deleteDeck(req.ownerId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/folders', requireOwner, async (req, res) => {
  if (!supabase.isSupabaseConfigured()) return storageUnavailable(res);
  try {
    const folders = await supabase.listFolders(req.ownerId);
    res.json({ folders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/folders', requireOwner, async (req, res) => {
  if (!supabase.isSupabaseConfigured()) return storageUnavailable(res);
  try {
    const folder = await supabase.upsertFolder(req.ownerId, req.body || {});
    res.json({ folder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/folders/:id', requireOwner, async (req, res) => {
  if (!supabase.isSupabaseConfigured()) return storageUnavailable(res);
  try {
    await supabase.deleteFolder(req.ownerId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mock: smart notes from PDF, image, Word, or pasted text (supports multiple files)
function classifyNotesFile(file) {
  const mime = file.mimetype || '';
  const name = file.originalname || '';
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(name)) return 'image';
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (mime.includes('word') || mime === 'application/msword' || /\.(docx?|rtf)$/i.test(name)) return 'word';
  if (mime.includes('presentation') || mime.includes('powerpoint') || /\.(pptx?|odp)$/i.test(name)) return 'slides';
  if (mime.includes('sheet') || mime.includes('excel') || mime === 'text/csv' || /\.(xlsx?|csv)$/i.test(name)) return 'spreadsheet';
  if (mime.startsWith('text/') || /\.(txt|md)$/i.test(name)) return 'text';
  return 'document';
}

function notesBulletForFile(file, index) {
  const type = classifyNotesFile(file);
  const label = file.originalname;
  const n = index + 1;
  switch (type) {
    case 'image':
      return `File ${n} (Image): Text and visuals extracted from ${label}`;
    case 'pdf':
      return `File ${n} (PDF): Key points summarized from ${label}`;
    case 'word':
      return `File ${n} (Word): Notes generated from ${label}`;
    case 'slides':
      return `File ${n} (Slides): Content summarized from ${label}`;
    case 'spreadsheet':
      return `File ${n} (Sheet): Data and headings extracted from ${label}`;
    case 'text':
      return `File ${n} (Text): Content processed from ${label}`;
    default:
      return `File ${n} (Document): Content processed from ${label}`;
  }
}

app.post('/api/notes', upload.array('files', 30), async (req, res) => {
  const text = (req.body?.text || '').trim();
  const files = req.files || [];

  if (!text && !files.length) {
    return res.status(400).json({ error: 'No text or files provided.' });
  }

  try {
    if (text || files.length) {
      const generated = await tryGemini(() => gemini.generateNotes({ text, files }));
      if (generated) {
        if (text && !files.length) {
          return res.json({
            type: 'notes',
            notes: {
              ...generated,
              source: text.substring(0, 160),
              fileType: 'text',
              pageCount: 1,
              detectedTypes: [{ type: 'text', count: 1 }]
            }
          });
        }
        if (files.length) {
          const fileMeta = files.map((file, index) => ({
            name: file.originalname,
            url: `/uploads/${file.filename}`,
            fileType: classifyNotesFile(file),
            page: index + 1
          }));
          const typeCounts = {};
          fileMeta.forEach((item) => {
            typeCounts[item.fileType] = (typeCounts[item.fileType] || 0) + 1;
          });
          const detectedTypes = Object.entries(typeCounts).map(([type, count]) => ({ type, count }));
          const uniqueTypes = [...new Set(fileMeta.map((item) => item.fileType))];
          const primaryType = uniqueTypes.length === 1 ? uniqueTypes[0] : 'multi';
          return res.json({
            type: 'notes',
            notes: {
              ...generated,
              source: files.map((file) => file.originalname).join(', '),
              fileType: primaryType,
              file: files.length === 1 ? fileMeta[0].url : null,
              files: fileMeta,
              pageCount: files.length,
              detectedTypes
            }
          });
        }
      }
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Notes generation failed.' });
  }

  if (text && !files.length) {
    return res.json({
      type: 'notes',
      notes: {
        title: 'Smart notes from pasted text',
        bullets: [
          'Main idea extracted from your pasted text',
          'Key definition or concept highlighted for review',
          'Summary point with suggested follow-up reading'
        ],
        source: text.substring(0, 160),
        fileType: 'text',
        pageCount: 1,
        detectedTypes: [{ type: 'text', count: 1 }]
      }
    });
  }

  if (!files.length) {
    return res.status(400).json({ error: 'No files uploaded.' });
  }

  const fileMeta = files.map((file, index) => ({
    name: file.originalname,
    url: `/uploads/${file.filename}`,
    fileType: classifyNotesFile(file),
    page: index + 1
  }));

  const typeCounts = {};
  fileMeta.forEach((item) => {
    typeCounts[item.fileType] = (typeCounts[item.fileType] || 0) + 1;
  });
  const detectedTypes = Object.entries(typeCounts).map(([type, count]) => ({ type, count }));

  const bullets = files.map((file, index) => notesBulletForFile(file, index));

  if (files.length > 1) {
    bullets.push(`Combined review checklist across all ${files.length} uploaded files`);
  }

  const uniqueTypes = [...new Set(fileMeta.map((item) => item.fileType))];
  const primaryType = uniqueTypes.length === 1 ? uniqueTypes[0] : 'multi';

  res.json({
    type: 'notes',
    notes: {
      title: files.length > 1
        ? `Smart notes from ${files.length} files`
        : `Smart notes from ${files[0].originalname}`,
      bullets,
      source: files.map((file) => file.originalname).join(', '),
      fileType: primaryType,
      file: files.length === 1 ? fileMeta[0].url : null,
      files: fileMeta,
      pageCount: files.length,
      detectedTypes
    }
  });
});

function mockStudyNotes(text, files) {
  if (text) {
    return {
      title: 'Smart notes from pasted text',
      bullets: [
        'Main idea extracted from your pasted text',
        'Key definition or concept highlighted for review',
        'Summary point with suggested follow-up reading',
        'Review tip: explain the main idea out loud without looking at your notes'
      ],
      source: text.substring(0, 160),
      fileType: 'text',
      pageCount: 1,
      detectedTypes: [{ type: 'text', count: 1 }]
    };
  }
  const bullets = files.map((file, index) => notesBulletForFile(file, index));
  if (files.length > 1) bullets.push(`Combined review checklist across all ${files.length} uploaded files`);
  return {
    title: files.length > 1 ? `Smart notes from ${files.length} files` : `Smart notes from ${files[0].originalname}`,
    bullets,
    source: files.map((file) => file.originalname).join(', '),
    pageCount: files.length
  };
}

function mockStudyQuiz(sourceText) {
  const snippet = (sourceText || 'your material').substring(0, 80);
  return {
    title: 'Practice quiz',
    questions: [
      { q: 'Which technique improves long-term retention?', options: ['Rereading', 'Spaced repetition', 'Highlighting'], answer: 1 },
      { q: 'Active recall means…', options: ['Passive review', 'Actively retrieving information', 'Copying notes'], answer: 1 },
      { q: `What is a key idea from: "${snippet}${sourceText.length > 80 ? '…' : ''}"?`, options: ['The main concept from your material', 'An unrelated topic', 'None of the above'], answer: 0 }
    ]
  };
}

function mockStudyFlashcards(sourceText) {
  const snippet = (sourceText || 'your study material').substring(0, 60);
  return [
    { q: 'What is spaced repetition?', a: 'Reviewing material at increasing intervals to strengthen memory.' },
    { q: 'What is active recall?', a: 'Testing yourself by retrieving information from memory.' },
    { q: 'Key idea from your upload', a: `Review the main concepts from: ${snippet}${sourceText.length > 60 ? '…' : ''}` }
  ];
}

function enrichStudyNotes(notes, text, files) {
  if (text && !files.length) {
    return {
      ...notes,
      source: text.substring(0, 160),
      fileType: 'text',
      pageCount: 1,
      detectedTypes: [{ type: 'text', count: 1 }]
    };
  }
  if (!files.length) return notes;
  const fileMeta = files.map((file, index) => ({
    name: file.originalname,
    url: `/uploads/${file.filename}`,
    fileType: classifyNotesFile(file),
    page: index + 1
  }));
  const typeCounts = {};
  fileMeta.forEach((item) => {
    typeCounts[item.fileType] = (typeCounts[item.fileType] || 0) + 1;
  });
  const detectedTypes = Object.entries(typeCounts).map(([type, count]) => ({ type, count }));
  const uniqueTypes = [...new Set(fileMeta.map((item) => item.fileType))];
  const primaryType = uniqueTypes.length === 1 ? uniqueTypes[0] : 'multi';
  return {
    ...notes,
    source: files.map((file) => file.originalname).join(', '),
    fileType: primaryType,
    file: files.length === 1 ? fileMeta[0].url : null,
    files: fileMeta,
    pageCount: files.length,
    detectedTypes
  };
}

function enrichStudyNotesFromUrl(notes, meta) {
  const urlType = meta.urlType === 'youtube' ? 'youtube' : 'website';
  return {
    ...notes,
    title: notes.title || meta.title,
    source: meta.source,
    fileType: urlType,
    pageCount: 1,
    detectedTypes: [{ type: urlType, count: 1 }]
  };
}

function normalizeGenerateOptions(input) {
  const defaults = { notes: true, flashcards: true, podcast: true };
  if (!input) return defaults;
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return defaults;
    }
  }
  return {
    notes: raw.notes !== false && raw.notes !== 'false',
    flashcards: raw.flashcards !== false && raw.flashcards !== 'false',
    podcast: raw.podcast !== false && raw.podcast !== 'false'
  };
}

async function buildStudySession({ text, files, urlMeta = null, generate: rawGenerate = null }) {
  const generate = normalizeGenerateOptions(rawGenerate);
  if (!generate.notes && !generate.flashcards && !generate.podcast) {
    throw new Error('Select at least one output to generate.');
  }

  const audioOnly = files.length === 1 && (files[0].mimetype || '').startsWith('audio/');
  const canFlashcardsFromFile = generate.flashcards && files.length === 1 && !text && !audioOnly;
  let notes = null;
  let sourceText = text;
  const inputType = urlMeta ? 'url' : audioOnly ? 'audio' : (text && !files.length) ? 'text' : 'files';
  const audioUrl = audioOnly && files[0]?.filename ? `/uploads/${files[0].filename}` : null;

  const shouldReadMaterial = generate.notes
    || (generate.podcast && (audioOnly || files.length > 0 || !text))
    || (generate.flashcards && files.length > 0 && !canFlashcardsFromFile);

  if (shouldReadMaterial) {
    if (audioOnly) {
      notes = await tryGemini(() => gemini.generateNotesFromAudio(files[0]));
    } else if (files.length) {
      notes = await tryGemini(() => gemini.generateNotes({ text, files }));
    } else {
      notes = await tryGemini(() => gemini.generateNotes({ text }));
    }
    if (!notes) notes = mockStudyNotes(text, files);
    notes = urlMeta ? enrichStudyNotesFromUrl(notes, urlMeta) : enrichStudyNotes(notes, text, files);
    sourceText = [...(notes.bullets || []), text].filter(Boolean).join('\n');
  } else if (text) {
    sourceText = text;
  }

  if (!generate.notes) {
    notes = {
      title: urlMeta?.title || 'Study session',
      bullets: [],
      source: urlMeta?.source || text.substring(0, 160) || files.map((f) => f.originalname).join(', ')
    };
  }

  let flashcards = [];
  if (generate.flashcards) {
    if (files.length === 1 && !text && !audioOnly) {
      flashcards = await tryGemini(() => gemini.generateFlashcardsFromFile(files[0])) || [];
    } else {
      flashcards = await tryGemini(() => gemini.generateFlashcardsFromText(sourceText)) || [];
    }
    if (!flashcards.length) flashcards = mockStudyFlashcards(sourceText);
  }

  let podcast = null;
  if (generate.podcast) {
    podcast = await tryGemini(() => gemini.generatePodcast({
      text: sourceText,
      title: notes.title || 'Study podcast',
      style: 'conversational'
    }));

    if (!podcast) {
      podcast = {
        title: notes.title || 'Study podcast',
        duration: '10:00',
        style: 'conversational',
        styleLabel: 'Conversational',
        hosts: ['Alex', 'Sam'],
        description: 'A review podcast based on your uploaded material.',
        segments: [
          { time: '0:00', title: 'Introduction', summary: 'Overview of the main topic.' },
          { time: '2:00', title: 'Key concepts', summary: 'Core ideas explained simply.' },
          { time: '6:00', title: 'Review', summary: 'Quick recap and practice tips.' }
        ],
        script: [
          { speaker: 'Alex', text: 'Let us walk through the key points from your material.' },
          { speaker: 'Sam', text: 'Focus on the main definitions and try explaining them out loud.' }
        ]
      };
    }

    if (podcast?.script?.length) {
      try {
        const audio = await tryGemini(() => gemini.generatePodcastAudio(podcast));
        if (audio?.audioBase64) {
          const audioUrl = savePodcastAudioFile(audio.audioBase64);
          podcast.audio = clientAudioPayload({
            mimeType: audio.mimeType,
            audioUrl,
            audioBase64: audio.audioBase64,
            hosts: audio.hosts,
            voices: audio.voices
          });
        }
      } catch (err) {
        console.warn('Study podcast audio:', err.message);
      }
    }
  }

  return {
    type: 'study',
    notes,
    quiz: { title: 'Practice quiz', questions: [] },
    flashcards,
    podcast: podcast || {},
    sourceText: sourceText.slice(0, 8000),
    inputType,
    inputText: (text || sourceText || '').slice(0, 50000),
    audioUrl,
    generate
  };
}

// One upload → notes, flashcards, quiz
app.post('/api/study', upload.array('files', 30), async (req, res) => {
  const text = (req.body?.text || '').trim();
  const files = req.files || [];
  const sessionName = (req.body?.sessionName || '').trim();

  if (!text && !files.length) {
    return res.status(400).json({ error: 'Upload a file or paste text.' });
  }

  try {
    const result = await buildStudySession({
      text,
      files,
      generate: req.body?.generate
    });
    const resolvedName = resolveSessionName(sessionName, {
      notes: result.notes,
      files,
      text,
      inputType: result.inputType
    });
    const ownerId = resolveOwnerId(req);
    let savedSession = null;
    if (ownerId) {
      try {
        savedSession = await persistStudySessionForOwner(ownerId, result, {
          name: resolvedName,
          rawText: text,
          files,
          inputType: result.inputType,
          inputText: text || result.inputText,
          audioUrl: result.audioUrl
        });
      } catch (err) {
        console.warn('Study session DB save:', err.message);
      }
    }
    res.json({
      ...result,
      sessionName: savedSession?.name || resolvedName,
      sessionId: savedSession?.id || null,
      savedToDatabase: Boolean(savedSession)
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Study session generation failed.' });
  }
});

app.post('/api/study/url', async (req, res) => {
  const url = (req.body?.url || '').trim();
  let urlType = (req.body?.urlType || '').trim();
  const sessionName = (req.body?.sessionName || '').trim();

  if (!url) {
    return res.status(400).json({ error: 'Paste a link first.' });
  }

  try {
    if (!urlType) urlType = detectUrlType(url);
    if (!['youtube', 'website'].includes(urlType)) {
      return res.status(400).json({ error: 'Unsupported link type.' });
    }

    const extracted = await extractUrlStudyText(url, urlType);
    const result = await buildStudySession({
      text: extracted.text,
      files: [],
      urlMeta: extracted,
      generate: req.body?.generate
    });
    const resolvedName = resolveSessionName(sessionName, {
      notes: result.notes,
      text: extracted.text,
      urlMeta: extracted,
      inputType: 'url'
    });
    const ownerId = resolveOwnerId(req);
    let savedSession = null;
    if (ownerId) {
      try {
        savedSession = await persistStudySessionForOwner(ownerId, result, {
          name: resolvedName,
          urlMeta: extracted,
          inputType: 'url',
          inputText: extracted.text.slice(0, 50000)
        });
      } catch (err) {
        console.warn('Study session DB save:', err.message);
      }
    }
    res.json({
      ...result,
      sessionName: savedSession?.name || resolvedName,
      sessionId: savedSession?.id || null,
      savedToDatabase: Boolean(savedSession)
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not build a study session from that link.' });
  }
});

app.post('/api/video', async (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Paste a YouTube link first.' });
  try {
    const extracted = await extractUrlStudyText(url, 'youtube');
    const result = await buildStudySession({
      text: extracted.text,
      files: [],
      urlMeta: extracted,
      generate: req.body?.generate
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not process video link.' });
  }
});

// Mock: export to Anki (returns a small text file)
app.get('/api/export/anki', (req, res) => {
  const content = 'APKG-EXPORT-MOCK\nQ: What is mock?\nA: A placeholder export.';
  res.setHeader('Content-Disposition', 'attachment; filename="bipoai-mock.apkg"');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(content);
});

// Static files after API routes so /api/* never falls through to HTML
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

function getLocalIp() {
  try {
    const { execSync } = require('child_process');
    return execSync('ipconfig getifaddr en0', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function resolveHttpsOptions() {
  const useHttps = process.env.HTTPS === 'true' || process.env.HTTPS === '1';
  if (!useHttps) return null;
  const keyPath = process.env.SSL_KEY || path.join(__dirname, 'certs', 'localhost-key.pem');
  const certPath = process.env.SSL_CERT || path.join(__dirname, 'certs', 'localhost.pem');
  const hasCerts = fs.existsSync(keyPath) && fs.existsSync(certPath);
  if (!hasCerts) {
    console.warn('HTTPS requested but certs not found. Run: npm run ssl:generate');
    return null;
  }
  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };
}

async function logStartup(protocol) {
  const lan = getLocalIp();
  console.log(`BipoAi operational on ${protocol}://localhost:${PORT}`);
  if (lan) console.log(`Same Wi-Fi: ${protocol}://${lan}:${PORT}`);
  const status = await gemini.verifyConnection();
  if (status.ok) {
    const keyInfo = status.keysActive != null && status.keys > 1
      ? `Gemini connected (${status.keysActive}/${status.keys} API keys)`
      : 'Gemini connected';
    console.log(keyInfo);
  } else if (status.reason === 'auth') {
    console.log('Gemini not connected:', status.message);
  } else if (status.reason === 'no_key') {
    console.log('Set GEMINI_API_KEY in .env for AI features');
  } else {
    console.log('Gemini warning:', status.message);
  }
}

const httpsOptions = resolveHttpsOptions();
if (httpsOptions) {
  https.createServer(httpsOptions, app).listen(PORT, HOST, () => logStartup('https'));
} else {
  app.listen(PORT, HOST, () => logStartup('http'));
}
