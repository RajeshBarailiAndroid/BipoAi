const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

function cleanEnv(raw) {
  return (raw || '').trim().replace(/^["']|["']$/g, '');
}

const googleClientId = cleanEnv(process.env.GOOGLE_CLIENT_ID);
const googleClientSecret = cleanEnv(process.env.GOOGLE_CLIENT_SECRET);
const defaultGoogleRedirectUri = 'https://bipoai.com/api/auth/google/callback';
const googleRedirectUri = cleanEnv(process.env.GOOGLE_REDIRECT_URI) || defaultGoogleRedirectUri;
const appleClientId = cleanEnv(process.env.APPLE_CLIENT_ID);
const sessionSecret = cleanEnv(process.env.SESSION_SECRET) || 'bipai-dev-session-secret';

function isAppleConfigured() {
  return Boolean(
    appleClientId
    && !/yourcompany|example\.com|changeme/i.test(appleClientId)
  );
}

const googleClient = googleClientId
  ? new OAuth2Client(googleClientId, googleClientSecret)
  : null;

const appleJwks = jwksClient({
  jwksUri: 'https://appleid.apple.com/auth/keys',
  cache: true,
  rateLimit: true
});

function getAppleSigningKey(header, callback) {
  appleJwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function createSessionToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.name,
      provider: user.provider
    },
    sessionSecret,
    { expiresIn: '7d' }
  );
}

function buildAuthResponse(profile) {
  const user = {
    id: profile.id,
    email: profile.email,
    name: profile.name,
    picture: profile.picture || null,
    plan: 'free',
    provider: profile.provider
  };

  return {
    type: 'auth',
    user,
    token: createSessionToken(user)
  };
}

async function verifyGoogleAuthCode(code) {
  if (!googleClient) {
    throw new Error('Google sign-in is not configured on the server.');
  }

  const { tokens } = await googleClient.getToken({
    code,
    redirect_uri: 'postmessage'
  });

  if (!tokens.id_token) {
    throw new Error('Google did not return an ID token.');
  }

  return verifyGoogleIdToken(tokens.id_token);
}

async function verifyGoogleAuthCodeRedirect(code, redirectUri) {
  if (!googleClient) {
    throw new Error('Google sign-in is not configured on the server.');
  }

  const { tokens } = await googleClient.getToken({
    code,
    redirect_uri: redirectUri
  });

  if (!tokens.id_token) {
    throw new Error('Google did not return an ID token.');
  }

  return verifyGoogleIdToken(tokens.id_token);
}

function getAppOrigin(req) {
  const host = req.get('host') || 'localhost:3001';
  const protocol = req.protocol || 'http';
  return `${protocol}://${host}`;
}

function getGoogleRedirectUri() {
  return googleRedirectUri;
}

function safeNextUrl(raw) {
  const next = String(raw || '/dashboard.html').trim();
  if (!next.startsWith('/') || next.startsWith('//')) return '/dashboard.html';
  return next;
}

function createOAuthState(nextUrl) {
  return jwt.sign(
    { purpose: 'google_oauth', next: safeNextUrl(nextUrl) },
    sessionSecret,
    { expiresIn: '10m' }
  );
}

function verifyOAuthState(state) {
  try {
    const payload = jwt.verify(String(state || ''), sessionSecret);
    if (payload.purpose !== 'google_oauth') return null;
    return { next: safeNextUrl(payload.next) };
  } catch {
    return null;
  }
}

function buildGoogleAuthUrl(req, nextUrl) {
  if (!googleClientId) {
    throw new Error('Google sign-in is not configured on the server.');
  }

  const redirectUri = getGoogleRedirectUri();
  const params = new URLSearchParams({
    client_id: googleClientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state: createOAuthState(nextUrl)
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function createOAuthCompletionToken(auth) {
  return jwt.sign(
    { purpose: 'oauth_complete', user: auth.user, token: auth.token },
    sessionSecret,
    { expiresIn: '2m' }
  );
}

function verifyOAuthCompletionToken(completion) {
  const payload = jwt.verify(String(completion || ''), sessionSecret);
  if (payload.purpose !== 'oauth_complete' || !payload.user || !payload.token) {
    throw new Error('Invalid completion token.');
  }
  return { user: payload.user, token: payload.token };
}

async function verifyGoogleIdToken(idToken) {
  if (!googleClientId) {
    throw new Error('Google sign-in is not configured on the server.');
  }

  const client = googleClient || new OAuth2Client(googleClientId);
  const ticket = await client.verifyIdToken({
    idToken,
    audience: googleClientId
  });
  const payload = ticket.getPayload();

  return buildAuthResponse({
    id: payload.sub,
    email: payload.email,
    name: payload.name || payload.email,
    picture: payload.picture,
    provider: 'google'
  });
}

async function verifyAppleIdentityToken(idToken, profileName) {
  if (!appleClientId) {
    throw new Error('Apple sign-in is not configured on the server.');
  }

  const decoded = await new Promise((resolve, reject) => {
    jwt.verify(
      idToken,
      getAppleSigningKey,
      {
        algorithms: ['RS256'],
        issuer: 'https://appleid.apple.com',
        audience: appleClientId
      },
      (err, payload) => {
        if (err) reject(err);
        else resolve(payload);
      }
    );
  });

  const email = decoded.email || `${decoded.sub}@privaterelay.appleid.com`;
  const name = profileName || email.split('@')[0];

  return buildAuthResponse({
    id: decoded.sub,
    email,
    name,
    provider: 'apple'
  });
}

function getGoogleOAuthSetup(req, supabaseUrl = '') {
  const appOrigin = getAppOrigin(req);
  const cleanSupabaseUrl = String(supabaseUrl || '').trim().replace(/\/$/, '');

  const javascriptOrigins = [
    'http://localhost:3001',
    'https://www.bipoai.com',
    'https://bipoai.com',
    appOrigin
  ];
  if (cleanSupabaseUrl) javascriptOrigins.push(cleanSupabaseUrl);

  const redirectUris = [
    getGoogleRedirectUri(),
    `${appOrigin}/auth-callback.html`
  ];
  if (cleanSupabaseUrl) {
    redirectUris.unshift(`${cleanSupabaseUrl}/auth/v1/callback`);
  }

  return {
    clientType: 'Web application',
    googleSignInMode: 'redirect',
    javascriptOrigins: [...new Set(javascriptOrigins.filter(Boolean))],
    redirectUris: [...new Set(redirectUris.filter(Boolean))],
    primaryRedirectUri: getGoogleRedirectUri(),
    supabaseCallbackUrl: cleanSupabaseUrl ? `${cleanSupabaseUrl}/auth/v1/callback` : '',
    supabaseProviderNote: cleanSupabaseUrl
      ? 'In Supabase → Authentication → Providers → Google, paste the same Client ID and Client secret from Google Cloud.'
      : '',
    commonFixes: [
      'Add this Authorized redirect URI: https://bipoai.com/api/auth/google/callback',
      'Use http://localhost:3001 in the browser — not 127.0.0.1 or a LAN IP like 192.168.x.x.',
      'OAuth client must be type Web application, not Desktop or iOS.',
      'Client ID and secret in .env must exactly match the Google Cloud Web client.',
      'After changing Google Cloud settings, wait a few minutes and try again.'
    ]
  };
}

function getPublicAuthConfig(req) {
  const host = req.get('host');
  const protocol = req.protocol;
  const defaultAppleRedirect = `${protocol}://${host}/index.html?signin=1`;

  return {
    googleEnabled: Boolean(googleClientId && googleClientSecret),
    googleIdTokenEnabled: Boolean(googleClientId),
    appleEnabled: isAppleConfigured(),
    googleClientId,
    appleClientId,
    appleRedirectUri: process.env.APPLE_REDIRECT_URI || defaultAppleRedirect
  };
}

function createDemoAuthResponse(provider, email, name) {
  return buildAuthResponse({
    id: `${provider}-${email}`,
    email,
    name: name || email.split('@')[0],
    provider
  });
}

function verifySessionToken(token) {
  try {
    return jwt.verify(token, sessionSecret);
  } catch {
    return null;
  }
}

module.exports = {
  verifyGoogleAuthCode,
  verifyGoogleAuthCodeRedirect,
  verifyGoogleIdToken,
  verifyAppleIdentityToken,
  getPublicAuthConfig,
  getGoogleOAuthSetup,
  getGoogleRedirectUri,
  buildGoogleAuthUrl,
  verifyOAuthState,
  createOAuthCompletionToken,
  verifyOAuthCompletionToken,
  createDemoAuthResponse,
  verifySessionToken,
  createSessionToken
};
