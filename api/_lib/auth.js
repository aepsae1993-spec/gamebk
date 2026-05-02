const crypto = require('crypto');
const jwt = require('jsonwebtoken');

function md5(text) {
  return crypto.createHash('md5').update(String(text)).digest('hex');
}

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Missing JWT_SECRET env var');
  return secret;
}

function signToken(payload) {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '30d' });
}

function verifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, getJwtSecret());
  } catch (e) {
    return null;
  }
}

// อ่าน Authorization header แล้ว verify token, คืน user payload หรือ null
function getUserFromReq(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return verifyToken(m[1]);
}

module.exports = { md5, signToken, verifyToken, getUserFromReq };
