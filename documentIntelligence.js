const fs = require('fs');
const path = require('path');

let DocumentIntelligence;
let isUnexpected;
let getLongRunningPoller;

function loadSdk() {
  if (DocumentIntelligence) return;
  const sdk = require('@azure-rest/ai-document-intelligence');
  DocumentIntelligence = sdk.default || sdk;
  isUnexpected = sdk.isUnexpected;
  getLongRunningPoller = sdk.getLongRunningPoller;
}

function cleanEnv(name) {
  return String(process.env[name] || '').trim().replace(/^["']|["']$/g, '');
}

function getEndpoint() {
  return cleanEnv('DOCUMENT_INTELLIGENCE_ENDPOINT')
    || cleanEnv('AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT');
}

function getApiKey() {
  return cleanEnv('DOCUMENT_INTELLIGENCE_API_KEY')
    || cleanEnv('AZURE_DOCUMENT_INTELLIGENCE_KEY');
}

function isConfigured() {
  return Boolean(getEndpoint() && getApiKey());
}

function getClient() {
  loadSdk();
  const endpoint = getEndpoint();
  const key = getApiKey();
  if (!endpoint || !key) {
    throw new Error('Set DOCUMENT_INTELLIGENCE_ENDPOINT and DOCUMENT_INTELLIGENCE_API_KEY in .env');
  }
  return DocumentIntelligence(endpoint, { key });
}

function classifyFile(file) {
  const mime = file.mimetype || '';
  const name = file.originalname || path.basename(file.path || '');
  if (mime.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|webm)$/i.test(name)) return 'audio';
  if (mime.startsWith('text/') || /\.(txt|md|csv)$/i.test(name)) return 'text';
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif)$/i.test(name)) return 'image';
  if (
    mime.includes('word')
    || mime === 'application/msword'
    || /\.(docx?|rtf)$/i.test(name)
  ) return 'word';
  if (mime.includes('presentation') || /\.(pptx?|odp)$/i.test(name)) return 'slides';
  if (mime.includes('sheet') || mime.includes('excel') || /\.(xlsx?|ods)$/i.test(name)) return 'spreadsheet';
  return 'document';
}

function shouldExtractWithAzure(file) {
  const kind = classifyFile(file);
  return ['pdf', 'image', 'word', 'slides', 'spreadsheet', 'document'].includes(kind);
}

function readPlainTextFile(file) {
  const name = file.originalname || path.basename(file.path || 'file');
  const text = fs.readFileSync(file.path, 'utf8').slice(0, 120000);
  return {
    name,
    kind: classifyFile(file),
    text: text.trim(),
    provider: 'local'
  };
}

function contentFromAnalyzeResult(result) {
  const analyzeResult = result?.analyzeResult || result;
  const content = String(analyzeResult?.content || '').trim();
  if (content.length >= 40) return content;

  const pages = analyzeResult?.pages || [];
  const fromPages = pages
    .flatMap((page) => (page.lines || []).map((line) => line.content || '').filter(Boolean))
    .join('\n')
    .trim();
  return fromPages || content;
}

async function extractTextFromFile(file, { modelId = 'prebuilt-read' } = {}) {
  const name = file.originalname || path.basename(file.path || 'file');
  const kind = classifyFile(file);

  if (kind === 'audio') {
    return { name, kind, text: '', provider: 'skip', skipped: true, reason: 'audio' };
  }

  if (kind === 'text') {
    const local = readPlainTextFile(file);
    return { ...local, skipped: false };
  }

  if (!shouldExtractWithAzure(file)) {
    return { name, kind, text: '', provider: 'skip', skipped: true, reason: 'unsupported' };
  }

  if (!isConfigured()) {
    return { name, kind, text: '', provider: 'skip', skipped: true, reason: 'not_configured' };
  }

  const stat = fs.statSync(file.path);
  const maxBytes = Number(process.env.DOCUMENT_INTELLIGENCE_MAX_BYTES || 50 * 1024 * 1024);
  if (stat.size > maxBytes) {
    return {
      name,
      kind,
      text: '',
      provider: 'azure',
      skipped: true,
      reason: 'too_large'
    };
  }

  loadSdk();
  const client = getClient();
  const base64Source = fs.readFileSync(file.path).toString('base64');

  const initialResponse = await client
    .path('/documentModels/{modelId}:analyze', modelId)
    .post({
      contentType: 'application/json',
      body: { base64Source },
      queryParameters: { locale: 'en-US' }
    });

  if (isUnexpected(initialResponse)) {
    const message = initialResponse.body?.error?.message || 'Document analysis failed';
    throw new Error(message);
  }

  const poller = getLongRunningPoller(client, initialResponse);
  const operation = await poller.pollUntilDone();
  const text = contentFromAnalyzeResult(operation.body).slice(0, 120000);

  return {
    name,
    kind,
    text,
    provider: 'azure',
    modelId,
    pageCount: operation.body?.analyzeResult?.pages?.length || null,
    skipped: false
  };
}

async function extractTextFromFiles(files = []) {
  const results = [];
  for (const file of files) {
    try {
      results.push(await extractTextFromFile(file));
    } catch (err) {
      results.push({
        name: file.originalname || path.basename(file.path || 'file'),
        kind: classifyFile(file),
        text: '',
        provider: 'azure',
        skipped: true,
        error: err.message || 'Extraction failed'
      });
    }
  }

  const sections = results
    .filter((item) => item.text && item.text.length >= 20)
    .map((item) => `--- ${item.name} (${item.kind}) ---\n${item.text}`);

  const extractedCount = results.filter((item) => item.text && item.text.length >= 20).length;

  return {
    text: sections.join('\n\n').slice(0, 500000),
    results,
    extractedCount,
    totalFiles: files.length,
    provider: isConfigured() ? 'azure' : 'local'
  };
}

async function verifyConnection() {
  if (!isConfigured()) {
    return {
      ok: false,
      reason: 'no_config',
      message: 'Set DOCUMENT_INTELLIGENCE_ENDPOINT and DOCUMENT_INTELLIGENCE_API_KEY in .env'
    };
  }

  try {
    loadSdk();
    const client = getClient();
    const response = await client.path('/info').get();
    if (isUnexpected(response)) {
      return {
        ok: false,
        reason: 'auth',
        message: response.body?.error?.message || 'Azure Document Intelligence auth failed'
      };
    }
    return {
      ok: true,
      message: 'Azure Document Intelligence connected',
      endpointConfigured: true
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      message: err.message || 'Azure Document Intelligence unavailable'
    };
  }
}

module.exports = {
  isConfigured,
  classifyFile,
  shouldExtractWithAzure,
  extractTextFromFile,
  extractTextFromFiles,
  verifyConnection
};
