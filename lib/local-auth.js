const crypto = require('crypto');

const token = crypto.randomBytes(32).toString('hex');

function requestToken(req) {
  const header = req.headers['x-paper-agent-token'];
  if (Array.isArray(header)) return header[0] || '';
  if (header) return String(header);
  try {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    return url.searchParams.get('token') || '';
  } catch {
    return '';
  }
}

function isLoopbackHost(host = '') {
  const clean = String(host || '').split(':')[0].toLowerCase();
  return clean === 'localhost' || clean === '127.0.0.1' || clean === '::1' || clean === '[::1]';
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function middleware(req, res, next) {
  if (req.method === 'GET' && req.path === '/session') return next();
  if (!originAllowed(req)) {
    return res.status(403).json({ ok: false, error: 'Paper Agent 只接受本机页面发起的请求' });
  }
  if (requestToken(req) !== token) {
    return res.status(403).json({ ok: false, error: 'Paper Agent 本机访问令牌无效，请刷新页面' });
  }
  return next();
}

function verifyUpgrade(req) {
  return originAllowed(req) && requestToken(req) === token;
}

module.exports = {
  token,
  middleware,
  verifyUpgrade,
};
