// ============================================================
// Inventory CRUD — equip / discard / expand / locked slots
// ============================================================
const { getSupabase } = require('../_lib/supabase');
const { ok, fail } = require('../_lib/util');
const { calcUserBaseFromSubmissions } = require('../_lib/pet');

// ดึง pet rarity จาก pet_config (cache ระหว่าง request เดียว)
async function getPetRarity(sb, petType) {
  const { data } = await sb.from('pet_config').select('rarity').eq('pet_type', petType).maybeSingle();
  return data ? (data.rarity || 'C') : 'C';
}

function soulValueByRarity(rarity) {
  if (rarity === 'UR') return 200;
  if (rarity === 'SSR') return 100;
  if (rarity === 'SR') return 20;
  if (rarity === 'R') return 5;
  return 1; // C
}

// ดึงหรือสร้าง pet_stats row
async function getOrCreatePetStats(sb, userId) {
  let { data: ps } = await sb.from('pet_stats').select('*').eq('user_id', userId).maybeSingle();
  if (!ps) {
    const { data: created, error } = await sb.from('pet_stats').insert({ user_id: userId }).select('*').single();
    if (error) throw new Error(error.message);
    ps = created;
  }
  return ps;
}

// คำนวณ gold ปัจจุบันของ user (จาก submissions + pet_stats)
async function calcCurrentGold(sb, userId) {
  const { data: subs } = await sb.from('submissions').select('score').eq('student_id', userId);
  const base = calcUserBaseFromSubmissions(subs || []);
  const { data: ps } = await sb.from('pet_stats').select('coins_spent, free_coins').eq('user_id', userId).maybeSingle();
  const spent = Number(ps && ps.coins_spent) || 0;
  const free = Number(ps && ps.free_coins) || 0;
  return Math.max(0, base.coins + free - spent);
}

// mirror: discardInventoryItem(userId, itemId)
async function discardInventoryItem(ctx, userId, itemId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  const sb = getSupabase();

  const { data: item } = await sb.from('inventory').select('*').eq('item_id', itemId).eq('user_id', uid).maybeSingle();
  if (!item) return fail('ไม่พบไอเทมนี้ในกระเป๋า');
  if (item.is_locked) return fail('ไอเทมนี้ถูกล็อค: ' + (item.locked_reason || 'ติดตลาด/ฟาร์ม'));

  // กรณี non-pet มี qty > 1 → ลดจำนวน
  if (item.category !== 'pets' && item.category !== 'equipped' && (item.quantity || 1) > 1) {
    const newQty = item.quantity - 1;
    await sb.from('inventory').update({ quantity: newQty }).eq('item_id', itemId);
    return ok({ message: `ทิ้งไอเทม 1 ชิ้นเรียบร้อย (เหลือ ${newQty})` });
  }

  // ลบ row
  await sb.from('inventory').delete().eq('item_id', itemId);

  // ถ้าเป็น pet → ได้เศษวิญญาณ
  if (item.category === 'pets' || item.category === 'equipped') {
    const rarity = await getPetRarity(sb, item.item_key);
    const soulValue = soulValueByRarity(rarity);
    const ps = await getOrCreatePetStats(sb, uid);
    const newSouls = (Number(ps.souls) || 0) + soulValue;
    await sb.from('pet_stats').update({ souls: newSouls }).eq('user_id', uid);
    return ok({ message: `แยกส่วนสำเร็จ! ได้รับเศษวิญญาณ +${soulValue}`, newSouls });
  }
  return ok({ message: 'ทิ้งไอเทมเรียบร้อย' });
}

// mirror: equipPetCapsule(userId, capsuleId)
//   - หาแคปซูลในกระเป๋า (category='pets')
//   - หา equipped เดิม (ถ้ามี) → swap เป็น 'pets'
//   - ตั้ง capsule → 'equipped'
//   - update pet_stats.pet_type / element / enhance_level
async function equipPetCapsule(ctx, userId, capsuleId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  const sb = getSupabase();

  const { data: capsule } = await sb.from('inventory').select('*').eq('item_id', capsuleId).eq('user_id', uid).maybeSingle();
  if (!capsule) return fail('ไม่พบแคปซูลนี้ในกระเป๋า');
  if (capsule.is_locked) return fail('แคปซูลนี้ถูกล็อค: ' + (capsule.locked_reason || ''));
  if (capsule.category === 'equipped') return fail('แคปซูลนี้สวมใส่อยู่แล้ว');
  if (capsule.category !== 'pets') return fail('ไอเทมนี้ไม่ใช่สัตว์เลี้ยง');

  const ps = await getOrCreatePetStats(sb, uid);
  const oldPetType = ps.pet_type || 'dog';
  const oldElement = ps.element || 'normal';
  const oldEnhance = Number(ps.enhance_level) || 0;
  const oldAura = ps.pet_aura || '';
  const oldTitle = ps.pet_title || '';

  // ดึง equipped เดิม
  const { data: oldEquipped } = await sb.from('inventory').select('*').eq('user_id', uid).eq('category', 'equipped').maybeSingle();

  // 1. capsule → equipped
  await sb.from('inventory').update({ category: 'equipped' }).eq('item_id', capsuleId);

  // 2. equipped เดิม → pets (เก็บข้อมูลตัวเก่าทั้งหมด)
  if (oldEquipped) {
    await sb.from('inventory').update({
      category: 'pets',
      item_key: oldPetType,
      element: oldElement,
      enhance_level: oldEnhance,
      pet_aura: oldAura,
      pet_title: oldTitle
    }).eq('item_id', oldEquipped.item_id);
  } else if (oldPetType) {
    // ไม่มี equipped row เดิม → สร้าง pets row ใหม่ให้ตัวเก่า (legacy fallback)
    await sb.from('inventory').insert({
      user_id: uid, category: 'pets',
      item_key: oldPetType, element: oldElement, enhance_level: oldEnhance,
      pet_aura: oldAura, pet_title: oldTitle, quantity: 1
    });
  }

  // 3. update pet_stats ให้ตรงกับแคปซูลใหม่
  await sb.from('pet_stats').update({
    pet_type: capsule.item_key,
    element: capsule.element || 'normal',
    enhance_level: Number(capsule.enhance_level) || 0,
    pet_aura: capsule.pet_aura || '',
    pet_title: capsule.pet_title || '',
    updated_at: new Date().toISOString()
  }).eq('user_id', uid);

  return ok({ message: 'สลับคู่หูเรียบร้อย' });
}

// mirror: expandInventory(userId)
async function expandInventory(ctx, userId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  const sb = getSupabase();

  const ps = await getOrCreatePetStats(sb, uid);
  const currentLimit = Number(ps.inventory_limit) || 5;

  // อ่าน max จาก settings
  const { data: setRows } = await sb.from('settings').select('value').eq('key', 'max_inventory_limit').maybeSingle();
  const maxLimit = (setRows && Number(setRows.value)) || 20;
  if (currentLimit >= maxLimit) return fail(`กระเป๋าขยายได้สูงสุด ${maxLimit} ช่องแล้ว`);

  const cost = 1000;
  const currentGold = await calcCurrentGold(sb, uid);
  if (currentGold < cost) return fail(`Gold ไม่พอ (ต้องการ ${cost} G)`);

  await sb.from('pet_stats').update({
    coins_spent: (Number(ps.coins_spent) || 0) + cost,
    inventory_limit: currentLimit + 1,
    updated_at: new Date().toISOString()
  }).eq('user_id', uid);

  return ok({
    message: `ขยายกระเป๋าสำเร็จ! ตอนนี้เก็บได้ ${currentLimit + 1} ช่อง`,
    newLimit: currentLimit + 1,
    newGold: currentGold - cost
  });
}

// mirror: getLockedSlots(userId) — Phase 2A: ส่งค่า default จนกว่า market system จะมา
async function getLockedSlots(ctx, userId) {
  // อ่านจาก settings สำหรับ max/expireHours
  const sb = getSupabase();
  const { data } = await sb.from('settings').select('key,value')
    .in('key', ['market_max_list_per_day', 'market_expire_hours']);
  const m = {};
  (data || []).forEach(r => { m[r.key] = r.value; });
  return {
    lockedSlots: [],
    todayListCount: 0,
    maxPerDay: Number(m.market_max_list_per_day) || 3,
    expireHours: Number(m.market_expire_hours) || 24
  };
}

module.exports = {
  discardInventoryItem,
  equipPetCapsule,
  expandInventory,
  getLockedSlots
};
