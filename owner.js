const { verifySessionToken } = require('./auth');

function resolveOwnerId(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const payload = verifySessionToken(auth.slice(7));
    if (payload?.sub) return String(payload.sub);
  }
  const guest = String(req.headers['x-guest-id'] || '').trim();
  if (/^guest-[a-z0-9-]{8,64}$/i.test(guest)) return guest;
  return null;
}

function requireOwner(req, res, next) {
  const ownerId = resolveOwnerId(req);
  if (!ownerId) {
    return res.status(401).json({ error: 'Sign in or continue as guest to save data.' });
  }
  req.ownerId = ownerId;
  next();
}

module.exports = { resolveOwnerId, requireOwner };
