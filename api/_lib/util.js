// แปลง YYYY-MM-DD ที่ Postgres คืนมาให้เป็น string ตรง ๆ (Apps Script เดิมใช้แบบนี้)
function dateStr(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.length > 10 ? v.substring(0, 10) : v;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v);
}

function ok(extra) { return Object.assign({ success: true }, extra || {}); }
function fail(message, extra) { return Object.assign({ success: false, message: message || 'error' }, extra || {}); }

// แปลงลิงก์ Google Drive แบบดูเป็น direct image link (เหมือน convertDriveUrlToDirectLink เดิม)
function driveDirectLink(url) {
  if (!url) return '';
  const s = String(url);
  if (s.indexOf('drive.google.com') === -1) return s;
  let m = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) m = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m && m[1]) return 'https://lh3.googleusercontent.com/d/' + m[1];
  return s;
}

module.exports = { dateStr, ok, fail, driveDirectLink };
