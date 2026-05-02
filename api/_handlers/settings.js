const { getSupabase } = require('../_lib/supabase');
const { ok, fail } = require('../_lib/util');

const DEFAULTS = {
  CurrentYear: '2567', CurrentTerm: '1',
  notif_auto_delete_days: 1
  // (default ของระบบเกมจะเพิ่มใน Phase 2)
};

// mirror: getSettings()
async function getSettings() {
  try {
    const sb = getSupabase();
    const { data } = await sb.from('settings').select('key,value');
    const result = { ...DEFAULTS };
    (data || []).forEach(r => { result[r.key] = r.value; });
    return result;
  } catch (e) {
    return { ...DEFAULTS };
  }
}

// mirror: saveSettings(d)
async function saveSettings(ctx, d) {
  if (!ctx.user || ctx.user.role !== 'Admin') return fail('สิทธิ์ไม่เพียงพอ');
  if (!d || typeof d !== 'object') return fail('ข้อมูลไม่ถูกต้อง');
  const sb = getSupabase();
  const rows = Object.keys(d).map(k => ({ key: k, value: d[k] }));
  const { error } = await sb.from('settings').upsert(rows, { onConflict: 'key' });
  if (error) return fail(error.message);
  return ok({ message: 'บันทึกการตั้งค่าสำเร็จ' });
}

module.exports = { getSettings, saveSettings };
