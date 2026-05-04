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

module.exports = { pickEquippedPetRow };
