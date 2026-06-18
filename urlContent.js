const { YoutubeTranscript } = require('youtube-transcript');

function normalizeUrl(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) throw new Error('Paste a link first.');
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function assertPublicHttpUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Enter a valid URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https links are supported.');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost'
    || host.endsWith('.local')
    || host === '127.0.0.1'
    || host.startsWith('192.168.')
    || host.startsWith('10.')
    || host.startsWith('172.16.')
  ) {
    throw new Error('That URL is not allowed.');
  }
  return parsed.toString();
}

function getYoutubeVideoId(url) {
  const patterns = [
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/watch\?v=([\w-]{11})/,
    /youtube\.com\/embed\/([\w-]{11})/,
    /youtube\.com\/shorts\/([\w-]{11})/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function htmlToPlainText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9'
};

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        ...BROWSER_HEADERS,
        ...(options.headers || {})
      },
      redirect: 'follow'
    });
  } finally {
    clearTimeout(timer);
  }
}

function extractJsonAfterMarker(html, marker) {
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  const braceStart = html.indexOf('{', idx + marker.length);
  if (braceStart < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = braceStart; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(braceStart, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function fetchYoutubePlayerDetails(videoId) {
  const watchRes = await fetchWithTimeout(`https://www.youtube.com/watch?v=${videoId}`);
  if (!watchRes.ok) return { title: 'YouTube video', description: '' };

  const html = await watchRes.text();
  const player = extractJsonAfterMarker(html, 'ytInitialPlayerResponse');
  const details = player?.videoDetails || {};
  return {
    title: details.title || 'YouTube video',
    description: details.shortDescription || ''
  };
}

async function fetchYoutubeTranscript(videoId) {
  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId);
    const text = segments.map((seg) => seg.text).join(' ').replace(/\s+/g, ' ').trim();
    if (text.length >= 40) return text;
  } catch {
    /* try legacy fallback below */
  }

  return fetchYoutubeTranscriptLegacy(videoId);
}

async function fetchYoutubeTranscriptLegacy(videoId) {
  const listRes = await fetchWithTimeout(`https://www.youtube.com/api/timedtext?v=${videoId}&type=list`);
  if (!listRes.ok) return '';
  const listXml = await listRes.text();
  if (listXml.trimStart().startsWith('<!DOCTYPE') || listXml.trimStart().startsWith('<html')) return '';

  const langMatch = listXml.match(/lang_code="([^"]+)"/);
  const lang = langMatch ? langMatch[1] : 'en';
  const trackRes = await fetchWithTimeout(`https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}`);
  if (!trackRes.ok) return '';
  const trackXml = await trackRes.text();
  if (trackXml.trimStart().startsWith('<!DOCTYPE') || trackXml.trimStart().startsWith('<html')) return '';

  const parts = [...trackXml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => htmlToPlainText(m[1]));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

async function fetchYoutubeMetadata(url, videoId) {
  let title = 'YouTube video';
  let author = '';

  try {
    const oembedRes = await fetchWithTimeout(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      { headers: { Accept: 'application/json' } }
    );
    const contentType = oembedRes.headers.get('content-type') || '';
    if (oembedRes.ok && contentType.includes('json')) {
      const data = await oembedRes.json();
      title = data.title || title;
      author = data.author_name || '';
    }
  } catch {
    /* optional metadata */
  }

  if (title === 'YouTube video') {
    const details = await fetchYoutubePlayerDetails(videoId);
    title = details.title || title;
  }

  return { title, author };
}

async function extractYoutubeStudyText(rawUrl) {
  const url = assertPublicHttpUrl(normalizeUrl(rawUrl));
  const videoId = getYoutubeVideoId(url);
  if (!videoId) throw new Error('Enter a valid YouTube link.');

  const [{ title, author }, transcript, playerDetails] = await Promise.all([
    fetchYoutubeMetadata(url, videoId),
    fetchYoutubeTranscript(videoId),
    fetchYoutubePlayerDetails(videoId)
  ]);

  if (transcript.length >= 80) {
    return {
      title,
      source: url,
      urlType: 'youtube',
      text: `YouTube lecture: ${title}${author ? ` by ${author}` : ''}\nSource: ${url}\n\nTranscript:\n${transcript}`.slice(0, 120000)
    };
  }

  const description = (playerDetails.description || '').trim();
  if (description.length >= 200) {
    return {
      title,
      source: url,
      urlType: 'youtube',
      text: [
        `YouTube video: ${title}`,
        author ? `Channel: ${author}` : '',
        `URL: ${url}`,
        transcript ? `Partial transcript:\n${transcript}` : '',
        `Description:\n${description}`
      ].filter(Boolean).join('\n\n').slice(0, 120000)
    };
  }

  throw new Error('No captions found for this YouTube video. Try a lecture with subtitles enabled.');
}

async function extractWebsiteStudyText(rawUrl) {
  const url = assertPublicHttpUrl(normalizeUrl(rawUrl));
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Could not load website (${res.status}).`);

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const body = await res.text();
  if (!contentType.includes('html') && !body.includes('<html')) {
    return {
      title: new URL(url).hostname,
      source: url,
      urlType: 'website',
      text: body.slice(0, 120000)
    };
  }

  const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? htmlToPlainText(titleMatch[1]) : new URL(url).hostname;
  const text = htmlToPlainText(body);
  if (text.length < 80) {
    throw new Error('Could not extract enough text from that page.');
  }

  return {
    title,
    source: url,
    urlType: 'website',
    text: `Website: ${title}\nSource: ${url}\n\n${text}`.slice(0, 120000)
  };
}

async function extractUrlStudyText(url, urlType) {
  if (urlType === 'youtube') return extractYoutubeStudyText(url);
  if (urlType === 'website') return extractWebsiteStudyText(url);
  throw new Error('Unsupported link type.');
}

module.exports = {
  normalizeUrl,
  extractUrlStudyText,
  extractYoutubeStudyText,
  extractWebsiteStudyText
};
