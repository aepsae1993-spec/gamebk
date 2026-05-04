// ============================================================
// Shop / Gacha / Soul Shop
// (Phase 2B — ยังไม่รวม skill rolling, ใช้ skill default ว่างก่อน)
// ============================================================
const { getSupabase } = require('../_lib/supabase');
const { ok, fail } = require('../_lib/util');
const {
  calcUserBaseFromSubmissions, calculateLevelAndExp,
  calculatePetLevelFromExp, calculateMaxHp, calcEnhanceHpBonus
} = require('../_lib/pet');
const { addBuff, getPvpCount, setPvpCount } = require('../_lib/buff');
const { loadAllSkillDefs, rollRandomSkill } = require('../_lib/skills');
const { pickEquippedPetRow } = require('../_lib/equippedPet');

const ELEMENTS = ['fire','water','wind','earth','light','dark','normal'];
const PVP_ITEMS = ['extra_battle','rematch_ticket','auto_win'];
const GEAR_ITEMS = ['iron_ore'];
const SUPPORT_ITEMS = ['talisman_5','talisman_10','talisman_15','talisman_20','talisman_30','talisman_50','talisman_100','protect_scroll'];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function loadSettingsMap(sb) {
  const { data } = await sb.from('settings').select('key,value');
  const m = {};
  (data || []).forEach(r => { m[r.key] = r.value; });
  return m;
}

async function getOrCreatePetStats(sb, userId) {
  let { data: ps } = await sb.from('pet_stats').select('*').eq('user_id', userId).maybeSingle();
  if (!ps) {
    const { data: created, error } = await sb.from('pet_stats').insert({ user_id: userId }).select('*').single();
    if (error) throw new Error(error.message);
    ps = created;
  }
  return ps;
}

async function calcCurrentGold(sb, userId, ps) {
  const { data: subs } = await sb.from('submissions').select('score').eq('student_id', userId);
  const base = calcUserBaseFromSubmissions(subs || []);
  return Math.max(0, base.coins + (Number(ps.free_coins) || 0) - (Number(ps.coins_spent) || 0));
}

// คำนวณ maxHp แบบ simplified
async function calcMaxHpSimple(sb, userId, ps, settings) {
  // หา equipped pet level (priority ตาม pickEquippedPetRow)
  const { data: invItems } = await sb.from('inventory').select('item_id, item_key, category,pet_exp,pet_level')
    .eq('user_id', userId).in('category', ['equipped','pets']);
  let petLevel = 1;
  const eq = pickEquippedPetRow(invItems, ps);
  if (eq) petLevel = calculatePetLevelFromExp(eq.pet_exp || 0).petLevel;

  let bonus = calcEnhanceHpBonus(Number(ps.enhance_level) || 0);
  if (ps.pet_aura) bonus += (Number(settings.enhance_15_aura_hp_buff) || 5) / 100;
  if (ps.pet_title) bonus += (Number(settings.enhance_20_title_hp_buff) || 10) / 100;
  return Math.floor(calculateMaxHp(petLevel) * (1 + bonus));
}

// ดึง pet pools จาก pet_config
async function loadPetPools(sb) {
  const { data } = await sb.from('pet_config').select('pet_type, rarity');
  const pools = { C: [], R: [], SR: [], SSR: [], UR: [] };
  (data || []).forEach(r => {
    const rar = (r.rarity || 'C').toUpperCase();
    if (pools[rar]) pools[rar].push(r.pet_type);
  });
  // fallback ถ้าตารางว่าง
  if (pools.C.length === 0) pools.C = ['dog','cat','chicken','bird','mouse'];
  if (pools.R.length === 0) pools.R = ['unicorn','kitsune','slime'];
  if (pools.SR.length === 0) pools.SR = ['phoenix','cerberus','kraken'];
  if (pools.SSR.length === 0) pools.SSR = ['dragon','monkeyking','mecha','naga'];
  if (pools.UR.length === 0) pools.UR = ['angel'];
  return pools;
}

async function rollGacha(sb, qty, settings, useUR, ratesPayload) {
  const pools = await loadPetPools(sb);
  // อ่าน rates
  let rGod = 0, rLegend = 0, rEpic = 0, rRare = 0;
  if (useUR) {
    rGod    = ratesPayload && ratesPayload.god    !== undefined ? Number(ratesPayload.god)    : Number(settings.rate_soul_god    || 1);
    rLegend = ratesPayload && ratesPayload.legend !== undefined ? Number(ratesPayload.legend) : Number(settings.rate_soul_legend || 5);
    rEpic   = ratesPayload && ratesPayload.epic   !== undefined ? Number(ratesPayload.epic)   : Number(settings.rate_soul_epic   || 12);
    rRare   = ratesPayload && ratesPayload.rare   !== undefined ? Number(ratesPayload.rare)   : Number(settings.rate_soul_rare   || 22);
  } else {
    rLegend = ratesPayload && ratesPayload.legend !== undefined ? Number(ratesPayload.legend) : Number(settings.rate_legend || 1.5);
    rEpic   = ratesPayload && ratesPayload.epic   !== undefined ? Number(ratesPayload.epic)   : Number(settings.rate_epic   || 8.5);
    rRare   = ratesPayload && ratesPayload.rare   !== undefined ? Number(ratesPayload.rare)   : Number(settings.rate_rare   || 20);
  }

  // preload skill defs สำหรับ preview passive skill ในการ์ดกาชา
  const skillDefs = await loadAllSkillDefs(sb);

  const result = [];
  for (let i = 0; i < qty; i++) {
    const roll = Math.random() * 100;
    let rarity = 'C', pool = pools.C;
    let acc = 0;
    if (useUR) {
      acc += rGod;    if (roll <= acc) { rarity = 'UR';  pool = pools.UR; }
      else { acc += rLegend; if (roll <= acc) { rarity = 'SSR'; pool = pools.SSR; }
        else { acc += rEpic; if (roll <= acc) { rarity = 'SR'; pool = pools.SR; }
          else { acc += rRare; if (roll <= acc) { rarity = 'R'; pool = pools.R; } } } }
    } else {
      acc += rLegend; if (roll <= acc) { rarity = 'SSR'; pool = pools.SSR; }
      else { acc += rEpic; if (roll <= acc) { rarity = 'SR'; pool = pools.SR; }
        else { acc += rRare; if (roll <= acc) { rarity = 'R'; pool = pools.R; } } }
    }
    // สุ่มสกิล passive 1 ตัว — preview ในการ์ด
    const previewSkill = rollRandomSkill(skillDefs, 'passive', settings);
    const skillInfo = previewSkill ? [{
      skillId: previewSkill.id, name: previewSkill.name,
      type: 'passive', effect: previewSkill.effect, value: previewSkill.value,
      description: previewSkill.description
    }] : [];
    result.push({ type: rand(pool), element: rand(ELEMENTS), rarity, skills: skillInfo });
  }
  return result;
}

// เพิ่ม inventory item แบบ stack (สำหรับ items/gears) — qty
async function addStackItem(sb, userId, category, itemKey, qty) {
  const { data: existing } = await sb.from('inventory').select('item_id, quantity')
    .eq('user_id', userId).eq('category', category).eq('item_key', itemKey).maybeSingle();
  if (existing) {
    await sb.from('inventory').update({ quantity: (existing.quantity || 1) + qty }).eq('item_id', existing.item_id);
  } else {
    await sb.from('inventory').insert({ user_id: userId, category, item_key: itemKey, element: 'normal', quantity: qty });
  }
}

// ใช้ jsonb daily_items: track shopBuys + ของที่ซื้อรายวัน
function bumpDailyItems(daily, key, qty) {
  const obj = (daily && typeof daily === 'object') ? { ...daily } : {};
  obj[key] = (Number(obj[key]) || 0) + qty;
  obj.shopBuys = (Number(obj.shopBuys) || 0) + 1;
  return obj;
}

// =====================================
// Core: buy item (shared by gold + soul shops)
// =====================================
async function _buyShopItem(ctx, opts) {
  const { userId, itemKey, cost, itemName, qty: rawQty, payload, currency } = opts;
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');

  const qty = Math.max(1, parseInt(rawQty) || 1);
  const totalCost = cost * qty;

  const sb = getSupabase();
  const settings = await loadSettingsMap(sb);

  // เช็ค active flag
  const activeKey = (currency === 'soul' ? 'active_soul_' : 'active_') + itemKey;
  if (settings[activeKey] === false) return fail('ไอเทมชิ้นนี้ถูก Admin ปิดการขายชั่วคราว!');

  const ps = await getOrCreatePetStats(sb, uid);

  // เช็คเงิน/วิญญาณ
  if (currency === 'gold') {
    const gold = await calcCurrentGold(sb, uid, ps);
    if (gold < totalCost) return fail(`Gold ไม่พอ (ต้องการ ${totalCost} G)`);
  } else {
    if ((Number(ps.souls) || 0) < totalCost) return fail(`วิญญาณไม่พอ (ต้องการ ${totalCost} 👻)`);
  }

  // เช็ค daily limit (เฉพาะ gold shop)
  const dailyItems = ps.daily_items || {};
  if (currency === 'gold') {
    const limitKey = 'limit_' + itemKey;
    const dailyLimit = settings[limitKey] !== undefined ? Number(settings[limitKey]) : 0;
    const used = Number(dailyItems[itemKey]) || 0;
    if (dailyLimit > 0 && used + qty > dailyLimit) {
      return fail(`ซื้อเกินโควต้า! ไอเทมนี้จำกัด ${dailyLimit} ชิ้น/วัน (คุณซื้อไปแล้ว ${used} ชิ้น)`);
    }
  }

  // ===== Gacha =====
  if (itemKey === 'gacha') {
    const useUR = currency === 'soul';
    const rolledPets = await rollGacha(sb, qty, settings, useUR, payload && payload.gachaRates);
    const updates = currency === 'gold'
      ? { coins_spent: (Number(ps.coins_spent) || 0) + totalCost, daily_items: bumpDailyItems(dailyItems, itemKey, qty), updated_at: new Date().toISOString() }
      : { souls: (Number(ps.souls) || 0) - totalCost, daily_items: bumpDailyItems(dailyItems, itemKey, qty), updated_at: new Date().toISOString() };
    await sb.from('pet_stats').update(updates).eq('user_id', uid);
    const result = { success: true, message: `สุ่มกาชา${currency === 'soul' ? 'ด้วยวิญญาณ' : ''}สำเร็จ ${qty} ชิ้น`, rolledPets, isGacha: true };
    if (currency === 'gold') result.newGold = (await calcCurrentGold(sb, uid, { ...ps, ...updates }));
    else result.newSouls = updates.souls;
    return result;
  }

  // ===== Apply effects =====
  let activeBuff = ps.active_buff || '';
  let petType = ps.pet_type || 'dog';
  let element = ps.element || 'normal';
  let customName = ps.custom_name || '';
  let expOffset = Number(ps.exp_offset) || 0;
  let shieldExpiry = Number(ps.shield_expiry) || 0;
  let currentHp = Number(ps.current_hp) || 0;
  let message = '';

  if (PVP_ITEMS.includes(itemKey)) {
    const cur = getPvpCount(activeBuff, itemKey);
    activeBuff = setPvpCount(activeBuff, itemKey, cur + qty);
    const newTotal = cur + qty;
    const nameMap = { extra_battle: 'ตั๋วประลองเพิ่ม', rematch_ticket: 'ใบประกาศจับ', auto_win: 'คัมภีร์ประกาศิต' };
    if (itemKey === 'extra_battle')   message = `🎟️ เปิดใช้ ${nameMap[itemKey]} ${qty} ใบ! สู้เพิ่มได้อีก ${newTotal} ครั้ง`;
    else if (itemKey === 'rematch_ticket') message = `🎯 เปิดใช้ ${nameMap[itemKey]} ${qty} ใบ! ตีซ้ำได้อีก ${newTotal} ครั้ง`;
    else                              message = `📜 เปิดใช้ ${nameMap[itemKey]} ${qty} ใบ! ชนะแน่นอน ${newTotal} ครั้งถัดไป`;
  } else if (GEAR_ITEMS.includes(itemKey) || SUPPORT_ITEMS.includes(itemKey)) {
    const cat = GEAR_ITEMS.includes(itemKey) ? 'gears' : 'items';
    await addStackItem(sb, uid, cat, itemKey, qty);
    message = `ได้รับ ${itemName || itemKey} จำนวน ${qty} ชิ้น เก็บลงกระเป๋าเรียบร้อย!`;
  } else if (itemKey === 'name_tag') {
    customName = (payload && payload.newName) ? String(payload.newName).trim().substring(0, 20) : '';
    message = `เปลี่ยนชื่อคู่หูเป็น '${customName}' เรียบร้อยแล้ว!`;
  } else if (itemKey === 'exp_booster') {
    expOffset += 200 * qty;
    message = `📖 อ่านคัมภีร์ คู่หูได้รับ +${200 * qty} EXP ทันที!`;
  } else if (itemKey === 'element_reroll') {
    const pool = ['fire','water','wind','earth','light','dark'].filter(e => e !== element);
    element = rand(pool);
    message = `🔮 ปลุกพลังสายเลือดใหม่! ธาตุของคุณเปลี่ยนเป็น [${element.toUpperCase()}]`;
  } else if (itemKey === 'shield_breaker') { activeBuff = addBuff(activeBuff, 'shield_breaker'); message = 'ค้อนทุบบาเรียพร้อมใช้งานในรอบถัดไป!'; }
  else if (itemKey === 'reflect')         { activeBuff = addBuff(activeBuff, 'reflect');         message = 'ติดกระจกสะท้อนการโจมตีสำเร็จ!'; }
  else if (itemKey === 'berserk')         { activeBuff = addBuff(activeBuff, 'berserk');         message = 'ดื่มยาบ้าคลั่ง! โจมตีครั้งถัดไปดาเมจ x2!'; }
  else if (itemKey === 'unicorn') { petType = 'unicorn'; message = 'สวมใส่คริสตัลยูนิคอร์นสำเร็จ!'; }
  else if (itemKey === 'phoenix') { petType = 'phoenix'; message = 'วิวัฒนาการสายเลือดฟีนิกซ์สำเร็จ!'; }
  else if (itemKey === 'dragon')  { petType = 'dragon';  message = 'ปลุกพลังมังกรทองสำเร็จ!'; }
  else if (itemKey === 'shield')  { shieldExpiry = Date.now() + 24 * 60 * 60 * 1000; message = 'กางบาเรีย 24 ชั่วโมงเรียบร้อยแล้ว!'; }
  else if (itemKey === 'heal_potion') {
    const maxHp = await calcMaxHpSimple(sb, uid, ps, settings);
    const baseHp = (currentHp <= 0 || currentHp > maxHp) ? maxHp : currentHp;
    currentHp = Math.min(maxHp, baseHp + 100 * qty);
    message = `ฟื้นฟูพลังชีวิตคู่หูสำเร็จ (+${100 * qty} HP) [MaxHP: ${maxHp}]`;
  } else {
    return fail('ไม่รู้จักไอเทมนี้: ' + itemKey);
  }

  // commit
  const newDaily = bumpDailyItems(dailyItems, itemKey, qty);
  const updates = {
    active_buff: activeBuff,
    pet_type: petType,
    element,
    custom_name: customName,
    exp_offset: expOffset,
    shield_expiry: shieldExpiry,
    current_hp: currentHp,
    daily_items: newDaily,
    updated_at: new Date().toISOString()
  };
  if (currency === 'gold') updates.coins_spent = (Number(ps.coins_spent) || 0) + totalCost;
  else updates.souls = (Number(ps.souls) || 0) - totalCost;

  await sb.from('pet_stats').update(updates).eq('user_id', uid);

  const result = { success: true, message };
  if (currency === 'gold') result.newGold = await calcCurrentGold(sb, uid, { ...ps, ...updates });
  else result.newSouls = updates.souls;
  return result;
}

// mirror: buyShopItem(userId, itemKey, cost, itemName, qty, payloadObj)
async function buyShopItem(ctx, userId, itemKey, cost, itemName, qty, payload) {
  return _buyShopItem(ctx, { userId, itemKey, cost, itemName, qty, payload, currency: 'gold' });
}

// mirror: buySoulShopItem(userId, itemKey, price, itemName, qty, payloadObj)
async function buySoulShopItem(ctx, userId, itemKey, price, itemName, qty, payload) {
  return _buyShopItem(ctx, { userId, itemKey, cost: price, itemName, qty, payload, currency: 'soul' });
}

// mirror: confirmGachaResult(userId, keptPetsArray, soulsGained)
async function confirmGachaResult(ctx, userId, keptPetsArray, soulsGained) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  const sb = getSupabase();

  const ps = await getOrCreatePetStats(sb, uid);
  const limit = Number(ps.inventory_limit) || 5;

  // นับ pet count ปัจจุบัน
  const { count: petCount } = await sb.from('inventory').select('*', { count: 'exact', head: true })
    .eq('user_id', uid).eq('category', 'pets');
  const kept = Array.isArray(keptPetsArray) ? keptPetsArray : [];
  if ((petCount || 0) + kept.length > limit) {
    return fail(`กระเป๋าเต็ม! (มีที่ว่าง ${limit - (petCount || 0)} ช่อง)`);
  }

  // 1. เพิ่ม pets + assign preview skill ที่ roll ไว้
  if (kept.length > 0) {
    const rows = kept.map(p => ({
      user_id: uid, category: 'pets',
      item_key: p.type, element: p.element || 'normal',
      enhance_level: 0, quantity: 1
    }));
    const { data: inserted } = await sb.from('inventory').insert(rows).select('item_id');
    if (inserted) {
      const learned = [];
      for (let i = 0; i < kept.length && i < inserted.length; i++) {
        const sk = (kept[i].skills && kept[i].skills.length > 0) ? kept[i].skills[0] : null;
        if (sk && sk.skillId) {
          learned.push({
            pet_item_id: inserted[i].item_id,
            owner_user_id: uid,
            skill_id: sk.skillId,
            skill_type: sk.type || 'passive',
            source: 'gacha'
          });
        }
      }
      if (learned.length > 0) {
        try { await sb.from('pet_learned_skills').insert(learned); } catch(e) { /* silent */ }
      }
    }
  }

  // 2. เพิ่ม souls จากการย่อย
  const newSouls = (Number(ps.souls) || 0) + (Number(soulsGained) || 0);
  if (Number(soulsGained) > 0) {
    await sb.from('pet_stats').update({ souls: newSouls }).eq('user_id', uid);
  }

  return ok({ message: 'บันทึกสัตว์เลี้ยงและเศษวิญญาณเรียบร้อย!', newSouls });
}

module.exports = { buyShopItem, buySoulShopItem, confirmGachaResult };
