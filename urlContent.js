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

function detectUrlType(rawUrl) {
  const url = assertPublicHttpUrl(normalizeUrl(rawUrl));
  return getYoutubeVideoId(url) ? 'youtube' : 'website';
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
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<header[\s\S]*?<\/header>/gi, ' ')
      .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function extractMetaContent(html, name) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, 'i')
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return htmlToPlainText(match[1]);
  }
  return '';
}

function extractArticleHtml(html) {
  const candidates = [
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1],
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1],
    html.match(/<div[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/div>/i)?.[1],
    html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1]
  ].filter((block) => block && block.length > 120);
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || html;
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

async function fetchYoutubeWatchPlayer(videoId) {
  const watchRes = await fetchWithTimeout(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      ...BROWSER_HEADERS,
      Cookie: 'CONSENT=PENDING+987'
    }
  });
  if (!watchRes.ok) return null;
  const html = await watchRes.text();
  return extractJsonAfterMarker(html, 'ytInitialPlayerResponse');
}

async function fetchYoutubePlayerDetails(videoId, player = null) {
  const resolved = player || await fetchYoutubeWatchPlayer(videoId);
  const details = resolved?.videoDetails || {};
  return {
    title: details.title || 'YouTube video',
    description: details.shortDescription || ''
  };
}

function rankCaptionTrack(track) {
  const lang = String(track?.languageCode || '').toLowerCase();
  const kind = String(track?.kind || '').toLowerCase();
  let score = 10;
  if (lang === 'en' || lang.startsWith('en-')) score = 0;
  else if (lang.startsWith('en')) score = 1;
  if (kind === 'asr') score += 2;
  return score;
}

function parseCaptionTrackBody(body) {
  const trimmed = String(body || '').trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed);
      return (data.events || [])
        .flatMap((event) => (event.segs || []).map((seg) => seg.utf8 || '').filter(Boolean))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    } catch {
      /* try other formats */
    }
  }

  if (trimmed.includes('<text')) {
    return [...trimmed.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
      .map((match) => htmlToPlainText(match[1]))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (trimmed.includes('WEBVTT')) {
    return trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('WEBVTT') && !/^\d+$/.test(line) && !/^\d{2}:\d{2}/.test(line))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return '';
}

async function fetchCaptionFromTrack(baseUrl) {
  const candidates = [
    `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}fmt=json3`,
    baseUrl,
    `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}fmt=srv3`
  ];
  for (const url of candidates) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) continue;
      const body = await res.text();
      if (body.trimStart().startsWith('<!DOCTYPE') || body.trimStart().startsWith('<html')) continue;
      const text = parseCaptionTrackBody(body);
      if (text.length >= 40) return text;
    } catch {
      /* try next format */
    }
  }
  return '';
}

async function fetchYoutubeTranscriptFromPlayer(player) {
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || !tracks.length) return '';

  const sorted = [...tracks].sort((a, b) => rankCaptionTrack(a) - rankCaptionTrack(b));
  for (const track of sorted) {
    if (!track?.baseUrl) continue;
    const text = await fetchCaptionFromTrack(track.baseUrl);
    if (text.length >= 40) return text;
  }
  return '';
}

async function fetchYoutubeTranscriptViaPackage(videoId) {
  const attempts = [
    () => YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' }),
    () => YoutubeTranscript.fetchTranscript(videoId),
    () => YoutubeTranscript.fetchTranscript(videoId, { lang: 'en-US' })
  ];
  for (const attempt of attempts) {
    try {
      const segments = await attempt();
      const text = segments.map((seg) => seg.text).join(' ').replace(/\s+/g, ' ').trim();
      if (text.length >= 40) return text;
    } catch {
      /* try next language/default */
    }
  }
  return '';
}

async function fetchYoutubeTranscript(videoId, player = null) {
  const resolvedPlayer = player || await fetchYoutubeWatchPlayer(videoId);
  const fromPlayer = await fetchYoutubeTranscriptFromPlayer(resolvedPlayer);
  if (fromPlayer.length >= 40) return fromPlayer;

  const fromPackage = await fetchYoutubeTranscriptViaPackage(videoId);
  if (fromPackage.length >= 40) return fromPackage;

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

function buildYoutubeStudyText({ title, author, url, transcript, description }) {
  const parts = [`YouTube video: ${title}`];
  if (author) parts.push(`Channel: ${author}`);
  parts.push(`Source: ${url}`);
  if (transcript.length >= 20) parts.push(`Transcript:\n${transcript}`);
  if (description) parts.push(`Description:\n${description}`);
  return parts.join('\n\n').slice(0, 120000);
}

async function extractYoutubeStudyText(rawUrl) {
  const url = assertPublicHttpUrl(normalizeUrl(rawUrl));
  const videoId = getYoutubeVideoId(url);
  if (!videoId) throw new Error('Enter a valid YouTube link.');

  const player = await fetchYoutubeWatchPlayer(videoId);
  const [{ title, author }, transcript, playerDetails] = await Promise.all([
    fetchYoutubeMetadata(url, videoId),
    fetchYoutubeTranscript(videoId, player),
    fetchYoutubePlayerDetails(videoId, player)
  ]);

  const resolvedTitle = title || playerDetails.title || 'YouTube video';
  const description = (playerDetails.description || '').trim();
  const text = buildYoutubeStudyText({
    title: resolvedTitle,
    author,
    url,
    transcript,
    description
  });

  if (text.replace(/\s+/g, ' ').trim().length < 30) {
    throw new Error('Could not load this YouTube video. Check the link and try again.');
  }

  return {
    title: resolvedTitle,
    source: url,
    urlType: 'youtube',
    captionless: transcript.length < 80,
    text
  };
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
  const ogTitle = extractMetaContent(body, 'og:title');
  const title = ogTitle || (titleMatch ? htmlToPlainText(titleMatch[1]) : new URL(url).hostname);
  const description = extractMetaContent(body, 'og:description')
    || extractMetaContent(body, 'description');
  const articleText = htmlToPlainText(extractArticleHtml(body));
  const textParts = [
    description && description.length > 40 ? `Summary: ${description}` : '',
    articleText
  ].filter(Boolean);
  const text = textParts.join('\n\n').trim();

  if (text.length < 80) {
    throw new Error('Could not extract enough text from that page. Try a direct article link.');
  }

  return {
    title,
    source: url,
    urlType: 'website',
    text: `Website: ${title}\nSource: ${url}\n\n${text}`.slice(0, 120000)
  };
}

async function extractUrlStudyText(url, urlType) {
  const type = urlType || detectUrlType(url);
  if (type === 'youtube') return extractYoutubeStudyText(url);
  if (type === 'website') return extractWebsiteStudyText(url);
  throw new Error('Unsupported link type.');
}

module.exports = {
  normalizeUrl,
  detectUrlType,
  extractUrlStudyText,
  extractYoutubeStudyText,
  extractWebsiteStudyText
};
