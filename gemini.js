const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { GoogleGenAI } = require('@google/genai');

const aiContext = new AsyncLocalStorage();
const apiKeyClients = new Map();
const disabledKeys = new Set();
const keyCooldownUntil = new Map();
const KEY_COOLDOWN_MS = 60_000;

let geminiAvailable = true;
let vertexClient = null;

function cleanKey(raw) {
  return (raw || '').trim().replace(/^["']|["']$/g, '');
}

function parseApiKeys() {
  const keys = [];
  const fromList = (process.env.GEMINI_API_KEYS || '')
    .split(/[,;\n]+/)
    .map(cleanKey)
    .filter(Boolean);
  keys.push(...fromList);
  for (const envName of ['GEMINI_API_KEY', 'GEMINI_API_KEY_2', 'GEMINI_API_KEY_3', 'GOOGLE_API_KEY']) {
    const value = cleanKey(process.env[envName]);
    if (value && !keys.includes(value)) keys.push(value);
  }
  return keys;
}

function maskApiKey(key) {
  if (!key) return '****';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function getApiKeys() {
  return parseApiKeys();
}

function getApiKey() {
  const available = getAvailableApiKeys();
  return available[0] || getApiKeys()[0] || '';
}

function getAvailableApiKeys() {
  const now = Date.now();
  return getApiKeys().filter((key) => {
    if (disabledKeys.has(key)) return false;
    return now >= (keyCooldownUntil.get(key) || 0);
  });
}

function getApiKeyCount() {
  return getApiKeys().length;
}

function getActiveApiKeyCount() {
  return getAvailableApiKeys().length;
}

function getCredentialsPath() {
  const raw = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.join(__dirname, raw);
}

function useVertexAI() {
  if (process.env.GEMINI_USE_VERTEX === 'true') return true;
  return Boolean(getCredentialsPath());
}

function getProjectId() {
  if (process.env.GOOGLE_CLOUD_PROJECT) {
    return process.env.GOOGLE_CLOUD_PROJECT.trim().replace(/^["']|["']$/g, '');
  }
  const credPath = getCredentialsPath();
  if (!credPath || !fs.existsSync(credPath)) return '';
  try {
    const data = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    return data.project_id || '';
  } catch {
    return '';
  }
}

function getLocation() {
  return (process.env.GOOGLE_CLOUD_LOCATION || 'us-central1').trim().replace(/^["']|["']$/g, '');
}

function getAuthMode() {
  if (useVertexAI()) return 'vertex';
  if (getApiKeys().length) return 'api_key';
  return 'none';
}

function isGeminiEnabled() {
  return getAuthMode() !== 'none';
}

function shouldUseGemini() {
  if (!isGeminiEnabled()) return false;
  if (useVertexAI()) return geminiAvailable;
  return getApiKeys().some((key) => !disabledKeys.has(key)) && geminiAvailable;
}

function markUnavailable() {
  geminiAvailable = false;
}

function resetConnection() {
  disabledKeys.clear();
  keyCooldownUntil.clear();
  apiKeyClients.clear();
  geminiAvailable = true;
}

function isAuthError(err) {
  const msg = (err?.message || String(err)).toLowerCase();
  return msg.includes('401')
    || msg.includes('invalid authentication')
    || msg.includes('access_token_type_unsupported')
    || msg.includes('unauthenticated')
    || msg.includes('api key not valid')
    || msg.includes('permission denied');
}

function isRetryableError(err) {
  const msg = (err?.message || String(err)).toLowerCase();
  const code = err?.status || err?.code || err?.error?.code;
  const numeric = Number(code);
  if (numeric === 429 || numeric === 503 || numeric === 500 || numeric === 502 || numeric === 504) return true;
  return msg.includes('429')
    || msg.includes('503')
    || msg.includes('rate limit')
    || msg.includes('quota')
    || msg.includes('resource exhausted')
    || msg.includes('overloaded')
    || msg.includes('too many requests')
    || msg.includes('busy')
    || msg.includes('unavailable')
    || msg.includes('deadline exceeded')
    || msg.includes('temporarily');
}

function authHelpMessage() {
  if (useVertexAI()) {
    return 'Vertex AI credentials not working. Check GOOGLE_APPLICATION_CREDENTIALS path, enable Vertex AI API, and set GOOGLE_CLOUD_PROJECT in .env.';
  }
  const key = getApiKey();
  if (key.startsWith('AQ.')) {
    return 'Your AQ. key is not accepted by Google\'s API yet. Use a service account JSON file (Vertex AI) or an AIzaSy... key from https://aistudio.google.com/apikey.';
  }
  return 'Invalid Gemini API key. Create a new key at https://aistudio.google.com/apikey or use a service account JSON file.';
}

async function verifyConnection() {
  if (!isGeminiEnabled()) {
    return { ok: false, reason: 'no_key', message: 'Set GEMINI_API_KEY (or _2/_3) or GOOGLE_APPLICATION_CREDENTIALS in .env' };
  }

  if (useVertexAI()) {
    try {
      await withFailover(async () => {
        await getAI().models.generateContent({
          model: getDefaultModel(),
          contents: 'Reply OK'
        });
      });
      geminiAvailable = true;
      return { ok: true, mode: 'vertex', keys: 1, keysActive: 1 };
    } catch (err) {
      if (isAuthError(err)) {
        geminiAvailable = false;
        return { ok: false, reason: 'auth', mode: 'vertex', message: authHelpMessage() };
      }
      return { ok: false, reason: 'error', mode: 'vertex', message: err.message || 'Gemini unavailable' };
    }
  }

  const keys = getApiKeys();
  let keysActive = 0;
  for (const key of keys) {
    if (disabledKeys.has(key)) continue;
    try {
      const ai = getAIForApiKey(key);
      await ai.models.generateContent({
        model: getDefaultModel(),
        contents: 'Reply OK'
      });
      keysActive += 1;
      geminiAvailable = true;
    } catch (err) {
      if (isAuthError(err)) disabledKeys.add(key);
    }
  }

  if (keysActive > 0) {
    return { ok: true, mode: 'api_key', keys: keys.length, keysActive };
  }

  geminiAvailable = false;
  return { ok: false, reason: 'auth', mode: 'api_key', keys: keys.length, keysActive: 0, message: authHelpMessage() };
}

function getDefaultModel() {
  return process.env.GEMINI_MODEL || 'gemini-2.5-flash';
}

function getSolveModel() {
  return process.env.GEMINI_SOLVE_MODEL || 'gemini-2.5-pro';
}

function getAIForApiKey(apiKey) {
  if (!apiKeyClients.has(apiKey)) {
    apiKeyClients.set(apiKey, new GoogleGenAI({ apiKey }));
  }
  return apiKeyClients.get(apiKey);
}

function getVertexClient() {
  if (vertexClient) return vertexClient;

  const credPath = getCredentialsPath();
  if (credPath && fs.existsSync(credPath)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
  }
  const project = getProjectId();
  if (!project) {
    throw new Error('GOOGLE_CLOUD_PROJECT missing. Set it in .env or use a JSON file with project_id.');
  }
  vertexClient = new GoogleGenAI({
    vertexai: true,
    project,
    location: getLocation()
  });
  return vertexClient;
}

function getAI() {
  const fromContext = aiContext.getStore();
  if (fromContext) return fromContext;
  if (useVertexAI()) return getVertexClient();
  const key = getApiKey();
  if (!key) return null;
  return getAIForApiKey(key);
}

async function withFailover(operation) {
  if (useVertexAI()) {
    return aiContext.run(getVertexClient(), operation);
  }

  const keys = getAvailableApiKeys();
  if (!keys.length) {
    geminiAvailable = false;
    throw new Error('No Gemini API keys available. Check GEMINI_API_KEY settings in .env.');
  }

  let lastError;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const hasMore = i < keys.length - 1;
    try {
      const result = await aiContext.run(getAIForApiKey(key), operation);
      geminiAvailable = true;
      return result;
    } catch (err) {
      lastError = err;
      if (isAuthError(err)) {
        disabledKeys.add(key);
        console.warn(`Gemini key ${maskApiKey(key)} rejected — trying next key.`);
        if (hasMore) continue;
      } else if (isRetryableError(err) && hasMore) {
        keyCooldownUntil.set(key, Date.now() + KEY_COOLDOWN_MS);
        console.warn(`Gemini key ${maskApiKey(key)} busy or rate-limited — trying next key.`);
        continue;
      }
      break;
    }
  }

  if (!getAvailableApiKeys().length) geminiAvailable = false;
  throw lastError;
}

async function generateChat(message, context = '') {
  return withFailover(async () => {
    const trimmed = (message || '').trim();
    const ctx = (context || '').trim().slice(0, 50000);
    const contents = ctx
      ? `You are a helpful AI tutor. Answer clearly using the study material below when relevant.\n\nStudy material:\n${ctx}\n\nStudent question: ${trimmed}`
      : trimmed;
    const response = await getAI().models.generateContent({
      model: getDefaultModel(),
      contents
    });
    return response.text;
  });
}

async function generateSolveText(problem) {
  return withFailover(async () => {
    const response = await getAI().models.generateContent({
      model: getSolveModel(),
      contents: problem
    });
    return response.text;
  });
}

function parseModelJson(text) {
  const raw = (text || '').trim();
  if (!raw) throw new Error('Gemini returned empty JSON');
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        /* fall through */
      }
    }
    throw new Error('Gemini returned invalid JSON');
  }
}

async function generateJSON(model, prompt, extraParts = []) {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }, ...extraParts] }],
    config: {
      responseMimeType: 'application/json',
      temperature: 0.4
    }
  });
  return parseModelJson(response.text);
}

function mimeFromFile(file) {
  if (file.mimetype) return file.mimetype;
  const ext = path.extname(file.originalname || '').toLowerCase();
  const map = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg'
  };
  return map[ext] || 'application/octet-stream';
}

async function buildFileParts(files) {
  const ai = getAI();
  const parts = [];

  for (const file of files) {
    const mimeType = mimeFromFile(file);
    const name = file.originalname || path.basename(file.path);

    if (mimeType.startsWith('text/') || /\.(txt|md)$/i.test(name)) {
      const text = fs.readFileSync(file.path, 'utf8').slice(0, 120000);
      parts.push({ text: `--- File: ${name} ---\n${text}` });
      continue;
    }

    if (mimeType.startsWith('image/') || mimeType === 'application/pdf' || mimeType.startsWith('audio/')) {
      const stat = fs.statSync(file.path);
      if (stat.size <= 4 * 1024 * 1024) {
        const data = fs.readFileSync(file.path).toString('base64');
        parts.push({ inlineData: { mimeType, data } });
        parts.push({ text: `Content from file: ${name}` });
        continue;
      }

      const uploaded = await ai.files.upload({
        file: file.path,
        config: { mimeType, displayName: name }
      });
      await waitForFileActive(uploaded.name);
      parts.push({
        fileData: { mimeType: uploaded.mimeType, fileUri: uploaded.uri }
      });
      parts.push({ text: `Content from file: ${name}` });
      continue;
    }

    parts.push({ text: `Uploaded file (format may be limited): ${name}` });
  }

  return parts;
}

async function waitForFileActive(fileName) {
  const ai = getAI();
  for (let i = 0; i < 20; i++) {
    const file = await ai.files.get({ name: fileName });
    if (file.state === 'ACTIVE') return file;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('File processing timed out.');
}

async function generateFlashcardsFromFile(file) {
  return withFailover(async () => {
    const parts = await buildFileParts([file]);
    return generateFlashcardsFromParts(parts);
  });
}

async function generateFlashcardsFromText(text) {
  return withFailover(async () => {
    const source = (text || '').trim().slice(0, 120000);
    if (!source) return [];
    const data = await generateJSON(
      getDefaultModel(),
      `Create 8-12 study flashcards from this material:
${source}
Return JSON: { "items": [{ "q": "question", "a": "answer" }] }
Keep questions clear and answers concise.`,
      []
    );
    return data.items || [];
  });
}

async function generateFlashcardsFromParts(parts) {
  const data = await generateJSON(
    getDefaultModel(),
    `Create 8-12 study flashcards from the uploaded material.
Return JSON: { "items": [{ "q": "question", "a": "answer" }] }
Keep questions clear and answers concise.`,
    parts
  );
  return data.items || [];
}

async function generateNotes({ text, files = [] }) {
  return withFailover(async () => {
    const parts = files.length ? await buildFileParts(files) : [];
    const source = text ? `\n\nPasted text:\n${text.slice(0, 120000)}` : '';
    const data = await generateJSON(
      getDefaultModel(),
      `Generate smart study notes from the source material.${source}
Return JSON:
{
  "title": "short title",
  "bullets": ["key point 1", "key point 2", "..."]
}
Use 6-12 bullet points covering main ideas, definitions, and review tips.`,
      parts
    );
    return {
      title: data.title || 'Smart notes',
      bullets: Array.isArray(data.bullets) ? data.bullets : []
    };
  });
}

async function generateNotesFromAudio(file) {
  return withFailover(async () => {
    const parts = await buildFileParts([file]);
    const data = await generateJSON(
      getDefaultModel(),
      `Transcribe and summarize this audio lecture into study notes.
Return JSON:
{
  "title": "short title",
  "bullets": ["key point 1", "key point 2", "..."]
}`,
      parts
    );
    return {
      title: data.title || 'Lecture notes',
      bullets: Array.isArray(data.bullets) ? data.bullets : []
    };
  });
}

async function generateQuiz(text) {
  return withFailover(async () => {
    const data = await generateJSON(
      getDefaultModel(),
      `Create a multiple-choice quiz from this study material:
${(text || '').slice(0, 120000)}

Return JSON:
{
  "title": "quiz title",
  "questions": [
    { "q": "question", "options": ["A", "B", "C", "D"], "answer": 0 }
  ]
}
Use 5-8 questions. "answer" is the zero-based index of the correct option.`,
      []
    );
    return {
      title: data.title || 'Generated quiz',
      questions: Array.isArray(data.questions) ? data.questions : []
    };
  });
}

async function generatePodcast({ text, title, style }) {
  return withFailover(async () => {
    const styleKey = (style || 'conversational').toLowerCase();
    const data = await generateJSON(
      getDefaultModel(),
      `Create a study podcast script from this material:
${(text || '').slice(0, 120000)}

Style: ${styleKey}
Episode title: ${title || 'Study podcast episode'}

Use exactly two hosts: Alex (male co-host) and Sam (female co-host). Alternate lines between them.

Return JSON:
{
  "title": "episode title",
  "duration": "estimated mm:ss",
  "style": "${styleKey}",
  "styleLabel": "human readable style",
  "hosts": ["Alex", "Sam"],
  "description": "one paragraph",
  "segments": [{ "time": "0:00", "title": "segment", "summary": "summary" }],
  "script": [{ "speaker": "Alex", "text": "line" }, { "speaker": "Sam", "text": "line" }]
}
Include 4-6 segments and 10-14 script lines. Cover the key points from the notes. Alex and Sam should explain concepts clearly to the student.`,
      []
    );
    if (!Array.isArray(data.hosts) || data.hosts.length < 2) {
      data.hosts = ['Alex', 'Sam'];
    }
    return data;
  });
}

const PODCAST_HOST_BOY = 'Alex';
const PODCAST_HOST_GIRL = 'Sam';
const PODCAST_VOICE_BOY = 'Puck';
const PODCAST_VOICE_GIRL = 'Kore';

function getTtsModel() {
  return process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
}

function pcmToWavBuffer(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function ensureWavBuffer(buf, sampleRate = 24000) {
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'RIFF') return buf;
  return pcmToWavBuffer(buf, sampleRate);
}

function normalizePodcastScript(podcast) {
  const boy = podcast?.hosts?.[0] || PODCAST_HOST_BOY;
  const girl = podcast?.hosts?.[1] || PODCAST_HOST_GIRL;
  const script = Array.isArray(podcast?.script) ? podcast.script : [];
  return script.map((line, index) => {
    const speaker = line.speaker === girl || line.speaker === PODCAST_HOST_GIRL
      ? girl
      : (line.speaker === boy || index % 2 === 0 ? boy : girl);
    return { speaker, text: String(line.text || '').trim() };
  }).filter((line) => line.text);
}

function buildMultiSpeakerTtsInput(script, boyName, girlName) {
  const lines = script.map((line) => `${line.speaker}: ${line.text}`).join('\n');
  return `TTS the following educational study podcast conversation between ${boyName} (male host) and ${girlName} (female host). Speak clearly at a moderate teaching pace:\n${lines}`;
}

function extractInteractionAudio(interaction) {
  if (interaction?.output_audio?.data) return interaction.output_audio.data;
  for (const output of interaction?.outputs || []) {
    if (output?.type === 'audio' && output.data) return output.data;
  }
  return null;
}

function extractGenerateContentAudio(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inline = part.inlineData || part.inline_data;
    if (inline?.data) {
      const mime = inline.mimeType || inline.mime_type || '';
      if (!mime || mime.includes('audio')) {
        return { data: inline.data, mimeType: mime || 'audio/pcm' };
      }
    }
  }
  return null;
}

async function generatePodcastAudio(podcast) {
  return withFailover(async () => {
    const script = normalizePodcastScript(podcast);
    if (!script.length) return null;

    const boyName = podcast?.hosts?.[0] || PODCAST_HOST_BOY;
    const girlName = podcast?.hosts?.[1] || PODCAST_HOST_GIRL;
    const ai = getAI();
    const ttsModel = getTtsModel();
    const ttsInput = buildMultiSpeakerTtsInput(script, boyName, girlName);

    try {
      const interaction = await ai.interactions.create({
        model: ttsModel,
        input: ttsInput,
        response_modalities: ['audio'],
        generation_config: {
          speech_config: [
            { speaker: boyName, voice: PODCAST_VOICE_BOY },
            { speaker: girlName, voice: PODCAST_VOICE_GIRL }
          ]
        }
      });
      const audioB64 = extractInteractionAudio(interaction);
      if (audioB64) {
        const wav = ensureWavBuffer(Buffer.from(audioB64, 'base64'));
        return {
          mimeType: 'audio/wav',
          audioBase64: wav.toString('base64'),
          hosts: [boyName, girlName],
          voices: { [boyName]: 'male', [girlName]: 'female' }
        };
      }
    } catch (err) {
      console.warn('Podcast TTS (interactions):', err.message);
    }

    try {
      const response = await ai.models.generateContent({
        model: ttsModel,
        contents: ttsInput,
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            multiSpeakerVoiceConfig: {
              speakerVoiceConfigs: [
                {
                  speaker: boyName,
                  voiceConfig: { prebuiltVoiceConfig: { voiceName: PODCAST_VOICE_BOY } }
                },
                {
                  speaker: girlName,
                  voiceConfig: { prebuiltVoiceConfig: { voiceName: PODCAST_VOICE_GIRL } }
                }
              ]
            }
          }
        }
      });
      const audio = extractGenerateContentAudio(response);
      if (audio?.data) {
        let buf = Buffer.from(audio.data, 'base64');
        buf = ensureWavBuffer(buf);
        return {
          mimeType: 'audio/wav',
          audioBase64: buf.toString('base64'),
          hosts: [boyName, girlName],
          voices: { [boyName]: 'male', [girlName]: 'female' }
        };
      }
    } catch (err) {
      console.warn('Podcast TTS (generateContent):', err.message);
    }

    return null;
  });
}

async function solveProblem(problem, subject) {
  return withFailover(async () => {
    const autoDetect = !subject || subject === 'auto' || subject === 'general';
    const data = await generateJSON(
    getSolveModel(),
    autoDetect
      ? `You are an expert tutor. Read the problem, infer the subject (math, physics, chemistry, etc.), then solve it with a clear step-by-step walkthrough.

Problem:
${(problem || '').slice(0, 4000)}

Return JSON only:
{
  "title": "e.g. Physics: Motion (Kinematics) or Math: Algebra",
  "question": "restate the full question in one sentence",
  "given": ["Initial velocity u = 40 km/h", "Final velocity v = 0 m/s", "..."],
  "formula": "main equation used, e.g. v² = u² + 2as",
  "steps": [
    { "step": 1, "title": "Convert units", "detail": "Convert u to m/s: 40 × (5/18) = 11.11 m/s" },
    { "step": 2, "title": "Substitute values", "detail": "0² = (11.11)² + 2(-0.5)s" },
    { "step": 3, "title": "Solve for the unknown", "detail": "0 = 123.4 - 1s → s = 123.4 meters" }
  ],
  "answer": "final answer with units, e.g. 123.4 meters"
}

Rules:
- Put the detected subject in "title" (e.g. "Physics: …" or "Math: …").
- Use plain-text math (no LaTeX). Use ×, ÷, ², →, and fractions like (5/18).
- List every known value under "given".
- Show unit conversions explicitly when needed.
- Each step must show the actual calculation, not vague advice.
- For math problems, show formula manipulation step by step.`
      : `You are an expert tutor. Solve this ${String(subject).toLowerCase()} problem with a clear, structured walkthrough.

Problem:
${(problem || '').slice(0, 4000)}

Return JSON only:
{
  "title": "e.g. Physics: Motion (Kinematics) or Math: Algebra",
  "question": "restate the full question in one sentence",
  "given": ["Initial velocity u = 40 km/h", "Final velocity v = 0 m/s", "..."],
  "formula": "main equation used, e.g. v² = u² + 2as",
  "steps": [
    { "step": 1, "title": "Convert units", "detail": "Convert u to m/s: 40 × (5/18) = 11.11 m/s" },
    { "step": 2, "title": "Substitute values", "detail": "0² = (11.11)² + 2(-0.5)s" },
    { "step": 3, "title": "Solve for the unknown", "detail": "0 = 123.4 - 1s → s = 123.4 meters" }
  ],
  "answer": "final answer with units, e.g. 123.4 meters"
}

Rules:
- Use plain-text math (no LaTeX). Use ×, ÷, ², →, and fractions like (5/18).
- List every known value under "given".
- Show unit conversions explicitly when needed.
- Each step must show the actual calculation, not vague advice.
- For math problems, show formula manipulation step by step.`,
    []
  );
  return {
    title: data.title || 'Solution',
    question: data.question || (problem || '').slice(0, 500),
    given: Array.isArray(data.given) ? data.given : [],
    formula: data.formula || '',
    answer: data.answer || '',
    steps: Array.isArray(data.steps) ? data.steps : [],
    problem: (problem || '').slice(0, 500),
    subject: autoDetect ? 'auto' : String(subject).toLowerCase()
  };
  });
}

module.exports = {
  isGeminiEnabled,
  getApiKey,
  getApiKeys,
  getApiKeyCount,
  getActiveApiKeyCount,
  getAuthMode,
  useVertexAI,
  shouldUseGemini,
  markUnavailable,
  resetConnection,
  isAuthError,
  isRetryableError,
  authHelpMessage,
  verifyConnection,
  generateFlashcardsFromFile,
  generateFlashcardsFromText,
  generateNotes,
  generateNotesFromAudio,
  generateQuiz,
  generatePodcast,
  generatePodcastAudio,
  solveProblem,
  generateChat,
  generateSolveText
};
