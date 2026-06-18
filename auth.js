const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const googleClientId = process.env.GOOGLE_CLIENT_ID || '';
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
const appleClientId = process.env.APPLE_CLIENT_ID || '';
const sessionSecret = process.env.SESSION_SECRET || 'bipai-dev-session-secret';

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

function getPublicAuthConfig(req) {
  const host = req.get('host');
  const protocol = req.protocol;
  const defaultAppleRedirect = `${protocol}://${host}/index.html?signin=1`;

  return {
    googleEnabled: Boolean(googleClientId && googleClientSecret),
    googleIdTokenEnabled: Boolean(googleClientId),
    appleEnabled: Boolean(appleClientId),
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
  verifyGoogleIdToken,
  verifyAppleIdentityToken,
  getPublicAuthConfig,
  createDemoAuthResponse,
  verifySessionToken,
  createSessionToken
};
