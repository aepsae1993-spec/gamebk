// ============================================================
// Single RPC dispatcher (mirrors google.script.run pattern)
// Frontend calls: POST /api/rpc  { fn: 'loginUser', args: [...] }
// ============================================================
const { applyCors } = require('./_lib/cors');
const { getUserFromReq } = require('./_lib/auth');
const { fail } = require('./_lib/util');

const handlers = Object.assign(
  {},
  require('./_handlers/auth'),
  require('./_handlers/users'),
  require('./_handlers/settings'),
  require('./_handlers/classes'),
  require('./_handlers/subjects'),
  require('./_handlers/assignments'),
  require('./_handlers/submissions'),
  require('./_handlers/announcements'),
  require('./_handlers/notifications'),
  require('./_handlers/images'),
  require('./_handlers/import')
);

// ฟังก์ชันที่ไม่ต้องล็อกอิน (public)
const PUBLIC_FNS = new Set([
  'loginUser',
  'registerUser',
  'getPetImagesDictionary',
  'getEquipImagesDictionary',
  'getMaterialImages',
  'getPetConfigDictionary',
  'getSettings',
  'getAnnouncements'
]);

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json(fail('Method not allowed'));
  }

  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch { body = {}; }
  }

  const fn = body.fn;
  const args = Array.isArray(body.args) ? body.args : [];

  if (!fn || typeof fn !== 'string') return res.status(400).json(fail('Missing fn'));
  if (!handlers[fn]) return res.status(404).json(fail('Unknown fn: ' + fn));

  const user = getUserFromReq(req);
  if (!PUBLIC_FNS.has(fn) && !user) {
    return res.status(401).json(fail('ต้องล็อกอินก่อนใช้งาน'));
  }

  try {
    const ctx = { user };
    const result = await handlers[fn](ctx, ...args);
    return res.status(200).json(result === undefined ? null : result);
  } catch (e) {
    console.error('[rpc:' + fn + ']', e);
    return res.status(500).json(fail(e.message || 'Server error'));
  }
};
