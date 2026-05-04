// ============================================================
// helper เลือก row "equipped pet" จาก inventory + pet_stats
// Priority:
//   1. category='equipped'  (UI swap แล้ว)
//   2. category='pets' AND item_key === pet_stats.pet_type  (legacy/migrate)
//   3. category='pets' ตัวแรก  (fallback สุดท้าย)
// ============================================================
function pickEquippedPetRow(invItems, petStats) {
  const items = Array.isArray(invItems) ? invItems : [];
  const ptype = petStats && petStats.pet_type ? petStats.pet_type : null;
  let eq = items.find(i => i.category === 'equipped');
  if (eq) return eq;
  if (ptype) {
    eq = items.find(i => i.category === 'pets' && i.item_key === ptype);
    if (eq) return eq;
  }
  return items.find(i => i.category === 'pets') || null;
}

// Auto-promote: ถ้า user ยังไม่มี row equipped → เลื่อน pets ที่ match pet_type ขึ้นมาเป็น equipped
// (หรือ pets ตัวแรกถ้าไม่มี match) — ทำครั้งเดียวต่อ user แล้วจะใช้ category='equipped' ตามปกติ
async function ensureEquippedRow(sb, userId) {
  const { data: existing } = await sb.from('inventory')
    .select('item_id').eq('user_id', userId).eq('category', 'equipped').maybeSingle();
  if (existing) return existing.item_id;

  const { data: ps } = await sb.from('pet_stats').select('pet_type').eq('user_id', userId).maybeSingle();
  const ptype = ps && ps.pet_type ? ps.pet_type : null;

  let target = null;
  if (ptype) {
    const { data: m } = await sb.from('inventory').select('item_id, item_key')
      .eq('user_id', userId).eq('category', 'pets').eq('item_key', ptype).limit(1).maybeSingle();
    if (m) target = m;
  }
  if (!target) {
    const { data: any } = await sb.from('inventory').select('item_id, item_key')
      .eq('user_id', userId).eq('category', 'pets').limit(1).maybeSingle();
    if (any) target = any;
  }
  if (!target) return null;

  await sb.from('inventory').update({ category: 'equipped' }).eq('item_id', target.item_id);
  // sync pet_stats.pet_type ให้ตรง (กรณี item_key ไม่ตรง pet_type เดิม)
  if (target.item_key && (!ptype || ptype !== target.item_key)) {
    await sb.from('pet_stats').update({ pet_type: target.item_key, updated_at: new Date().toISOString() }).eq('user_id', userId);
  }
  return target.item_id;
}

module.exports = { pickEquippedPetRow, ensureEquippedRow };
