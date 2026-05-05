// ============================================================
// Enhance Pet — ตีบวกคู่หู (+1 ถึง +20)
//   +1-10: ใช้แร่เหล็ก, ยันต์ talisman_X (boost rate), protect_scroll (กันลด)
//   +11-20: ใช้สัตว์เลี้ยงสายพันธุ์เดียวกันสังเวย
// ============================================================
const { getSupabase } = require('../_lib/supabase');
const { ok, fail } = require('../_lib/util');

async function loadSettings(sb) {
  const { data } = await sb.from('settings').select('key,value');
  const m = {};
  (data || []).forEach(r => { m[r.key] = r.value; });
  return m;
}

async function getOrCreatePetStats(sb, userId) {
  let { data: ps } = await sb.from('pet_stats').select('*').eq('user_id', userId).maybeSingle();
  if (!ps) {
    const { data: created } = await sb.from('pet_stats').insert({ user_id: userId }).select('*').single();
    ps = created;
  }
  return ps;
}

// mirror: enhancePet(userId, targetId, useProtectItemIds, useTalismanItemId, sacrificePetId)
//   targetId = 'equipped' หรือ inventory.item_id ของ pet (category='pets')
async function enhancePet(ctx, userId, targetId, useProtectItemIds, useTalismanItemId, sacrificePetId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');

  const sb = getSupabase();
  const settings = await loadSettings(sb);

  // โหลด inventory ของ user ทั้งหมด
  const { data: invItems } = await sb.from('inventory').select('*').eq('user_id', uid);
  const items = invItems || [];

  // ระบุ target — equipped หรือ specific pet capsule
  let target = null;
  let targetEnhance = 0;
  let targetPetType = '';
  let targetIsEquipped = false;
  if (targetId === 'equipped') {
    target = items.find(i => i.category === 'equipped');
    if (target) {
      targetEnhance = Number(target.enhance_level) || 0;
      targetPetType = target.item_key || '';
      targetIsEquipped = true;
    } else {
      // fallback: ใช้ pet_stats.pet_type ถ้าไม่มี equipped capsule (legacy)
      const ps = await getOrCreatePetStats(sb, uid);
      targetEnhance = Number(ps.enhance_level) || 0;
      targetPetType = ps.pet_type || 'dog';
      targetIsEquipped = true;
    }
  } else {
    target = items.find(i => i.item_id === targetId && i.category === 'pets');
    if (!target) return fail('ไม่พบแคปซูลที่ต้องการตีบวก');
    if (target.is_locked) return fail('🔒 สัตว์เลี้ยงนี้ถูกล็อคอยู่: ' + (target.locked_reason || 'ติดตลาด/ฟาร์ม') + ' — ยกเลิกก่อนถึงจะตีบวกได้');
    targetEnhance = Number(target.enhance_level) || 0;
    targetPetType = target.item_key || '';
  }
  if (targetEnhance >= 20) return fail('ตีบวกสูงสุด +20 (Transcendent) แล้ว!');

  const nextLevel = targetEnhance + 1;
  const ironOreItem = items.find(i => i.item_key === 'iron_ore' && i.category === 'gears');
  const ironOreNeeded = nextLevel <= 10 ? nextLevel : 0;
  if (nextLevel <= 10 && (!ironOreItem || (ironOreItem.quantity || 0) < ironOreNeeded)) {
    return fail(`ต้องการแร่เหล็ก ${ironOreNeeded} ก้อนสำหรับการตี +${nextLevel} (คุณมี ${ironOreItem ? ironOreItem.quantity : 0} ก้อน)`);
  }

  // sacrifice (+11 ขึ้นไป)
  let sacrificeNeeded = 0;
  if (nextLevel >= 11 && nextLevel <= 14) sacrificeNeeded = 1;
  else if (nextLevel >= 15 && nextLevel <= 17) sacrificeNeeded = 2;
  else if (nextLevel >= 18 && nextLevel <= 20) sacrificeNeeded = 3;

  let sacrificeIds = [];
  if (sacrificeNeeded > 0) {
    sacrificeIds = sacrificePetId ? String(sacrificePetId).split(',').map(s => s.trim()).filter(Boolean) : [];
    if (sacrificeIds.length < sacrificeNeeded) {
      return fail(`การตีบวก +${nextLevel} ต้องใช้สัตว์เลี้ยงสายพันธุ์เดียวกัน ${sacrificeNeeded} ตัว (เลือก ${sacrificeIds.length} ตัว)`);
    }
    for (const sid of sacrificeIds) {
      const sac = items.find(i => i.item_id === sid && i.category === 'pets');
      if (!sac) return fail('ไม่พบสัตว์เลี้ยงที่ต้องการสังเวย: ' + sid);
      if (sac.is_locked) return fail('🔒 สังเวยตัวที่ถูกล็อคไม่ได้ (ติดตลาด/ฟาร์ม): ' + (sac.locked_reason || ''));
      if (sac.item_key !== targetPetType) return fail('สัตว์เลี้ยงที่สังเวยต้องเป็นเผ่าพันธุ์เดียวกัน');
    }
  }

  // talisman (+1-10 only)
  let talismanBonus = 0;
  let talismanItem = null;
  if (useTalismanItemId && nextLevel <= 10) {
    talismanItem = items.find(i => i.item_id === useTalismanItemId);
    if (talismanItem) {
      const m = String(talismanItem.item_key || '').match(/talisman_(\d+)/);
      if (m) talismanBonus = Number(m[1]);
    }
  }

  // protect scroll (+1-10 only)
  let protectItem = null;
  if (useProtectItemIds && nextLevel <= 10) {
    protectItem = items.find(i => i.item_id === useProtectItemIds && i.item_key === 'protect_scroll');
  }

  // base success rate
  let baseRate = 100;
  if (nextLevel >= 4) {
    const k = 'rate_enhance_' + nextLevel;
    baseRate = settings[k] !== undefined ? Number(settings[k]) : Math.max(1, 100 - nextLevel * 5);
  }
  const totalRate = Math.min(100, baseRate + talismanBonus);

  // หักวัสดุ
  if (nextLevel <= 10) {
    if (ironOreItem) {
      const newQty = (ironOreItem.quantity || 1) - ironOreNeeded;
      if (newQty > 0) await sb.from('inventory').update({ quantity: newQty }).eq('item_id', ironOreItem.item_id);
      else await sb.from('inventory').delete().eq('item_id', ironOreItem.item_id);
    }
    if (talismanItem) {
      const newQty = (talismanItem.quantity || 1) - 1;
      if (newQty > 0) await sb.from('inventory').update({ quantity: newQty }).eq('item_id', talismanItem.item_id);
      else await sb.from('inventory').delete().eq('item_id', talismanItem.item_id);
    }
    if (protectItem) {
      const newQty = (protectItem.quantity || 1) - 1;
      if (newQty > 0) await sb.from('inventory').update({ quantity: newQty }).eq('item_id', protectItem.item_id);
      else await sb.from('inventory').delete().eq('item_id', protectItem.item_id);
    }
  } else {
    // ลบสัตว์ที่สังเวย
    if (sacrificeIds.length > 0) await sb.from('inventory').delete().in('item_id', sacrificeIds);
  }

  // roll
  const isSuccess = Math.random() * 100 <= totalRate;
  let finalLevel = targetEnhance;
  let message = '';
  const bonusRewards = [];

  if (isSuccess) {
    finalLevel += 1;
    if (finalLevel === 11) message = '🌟 ปาฏิหาริย์บังเกิด! คู่หูทะลวงขีดจำกัด (Limit Break) +11 (Awakened) สำเร็จ!';
    else if (finalLevel === 15) {
      const auraName = settings.enhance_15_aura || '🌟 Divine Glow';
      message = `✨ LEGENDARY! ตีบวก +15 สำเร็จ! ได้รับ Aura: ${auraName}`;
      bonusRewards.push({ type: 'aura', value: auraName });
    }
    else if (finalLevel === 20) {
      const titleName = settings.enhance_20_title || 'ผู้ทะลวงขีดจำกัดสูงสุด';
      message = `🏆 TRANSCENDENT! ตีบวก +20 สำเร็จ! ได้รับฉายา: 「${titleName}」`;
      bonusRewards.push({ type: 'title', value: titleName });
    }
    else message = `🎉 ยินดีด้วย! ตีบวกคู่หูสำเร็จเป็น +${finalLevel}`;
  } else {
    if (nextLevel >= 11) {
      message = `😭 ตีบวก +${nextLevel} ล้มเหลว... สัตว์เลี้ยงที่ใช้สังเวยหายไป (คงเหลือ +${finalLevel})`;
    } else if (protectItem) {
      message = `💥 ตีบวกล้มเหลว... แต่ [ยันต์กันของตก] ช่วยปกป้องระดับไว้! (คงเหลือ +${finalLevel})`;
    } else {
      finalLevel = Math.max(0, finalLevel - 1);
      message = `😭 ตีบวกล้มเหลว... ระดับลดลง 1 ขั้น (คงเหลือ +${finalLevel})`;
    }
  }

  // commit enhance level
  if (targetIsEquipped) {
    const updates = { enhance_level: finalLevel, updated_at: new Date().toISOString() };
    if (isSuccess && finalLevel >= 15) updates.pet_aura = settings.enhance_15_aura || '🌟 Divine Glow';
    if (isSuccess && finalLevel >= 20) updates.pet_title = settings.enhance_20_title || 'ผู้ทะลวงขีดจำกัดสูงสุด';
    await sb.from('pet_stats').update(updates).eq('user_id', uid);
    // sync เข้า inventory equipped row ด้วย (ถ้ามี)
    if (target && target.item_id) {
      const inv = { enhance_level: finalLevel };
      if (updates.pet_aura) inv.pet_aura = updates.pet_aura;
      if (updates.pet_title) inv.pet_title = updates.pet_title;
      await sb.from('inventory').update(inv).eq('item_id', target.item_id);
    }
  } else {
    await sb.from('inventory').update({ enhance_level: finalLevel }).eq('item_id', target.item_id);
  }

  // track daily quest
  try {
    const ps = await getOrCreatePetStats(sb, uid);
    const di = (ps.daily_items && typeof ps.daily_items === 'object') ? { ...ps.daily_items } : {};
    di.petUpgrades = (Number(di.petUpgrades) || 0) + 1;
    await sb.from('pet_stats').update({ daily_items: di }).eq('user_id', uid);
  } catch {}

  // notify
  try { await sb.from('notifications').insert({ user_id: uid, type: 'submit', message }); } catch {}

  return { success: isSuccess, message, newEnhanceLevel: finalLevel, bonusRewards };
}

module.exports = { enhancePet };
