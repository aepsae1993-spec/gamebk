// ============================================================
// Equipment / Crafting / Materials
// (Phase 2C-Lite — ใช้ base stats จาก equipment_config โดยไม่ roll variance)
// ============================================================
const { getSupabase } = require('../_lib/supabase');
const { ok, fail } = require('../_lib/util');
const { calcUserBaseFromSubmissions } = require('../_lib/pet');

const SLOTS = ['weapon','armor','necklace','ring','shoes'];

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

async function calcCurrentGold(sb, userId, ps) {
  const { data: subs } = await sb.from('submissions').select('score').eq('student_id', userId);
  const base = calcUserBaseFromSubmissions(subs || []);
  return Math.max(0, base.coins + (Number(ps.free_coins) || 0) - (Number(ps.coins_spent) || 0));
}

// --- Materials helpers ---
async function getMyMaterials(ctx, userId) {
  const uid = userId || (ctx.user && ctx.user.userId);
  if (!uid) return { mat_iron: 0, mat_leather: 0, mat_gem: 0, mat_fabric: 0, mat_essence: 0 };
  const sb = getSupabase();
  const { data } = await sb.from('crafting_materials').select('mat_key, quantity').eq('user_id', uid);
  const out = { mat_iron: 0, mat_leather: 0, mat_gem: 0, mat_fabric: 0, mat_essence: 0 };
  (data || []).forEach(r => { out[r.mat_key] = Number(r.quantity) || 0; });
  return out;
}

async function _addMaterial(sb, userId, matKey, qty) {
  const { data: r } = await sb.from('crafting_materials').select('quantity').eq('user_id', userId).eq('mat_key', matKey).maybeSingle();
  const newQty = (Number(r && r.quantity) || 0) + qty;
  await sb.from('crafting_materials').upsert({ user_id: userId, mat_key: matKey, quantity: newQty }, { onConflict: 'user_id,mat_key' });
  return newQty;
}

// --- Recipes / Config ---
async function getEquipmentRecipes() {
  const sb = getSupabase();
  const settings = await loadSettings(sb);
  const { data } = await sb.from('equipment_config').select('*');
  const recipes = (data || []).map(r => ({
    id: r.equip_id, name: r.name, slot: r.slot, rarity: r.rarity,
    bonuses: {
      atk: r.atk_bonus, hp: r.hp_bonus, def: r.def_bonus, spd: r.spd_bonus,
      lifesteal: r.lifesteal_pct, reflect: r.reflect_pct, armorPen: r.armor_pen
    },
    // ค่า craft material costs default (admin override ผ่าน settings 'recipe_cost_<equip_id>_<mat>')
    costs: {
      mat_iron:    Number(settings['recipe_cost_' + r.equip_id + '_mat_iron']    ?? defaultMatCost(r.rarity, 'iron')),
      mat_leather: Number(settings['recipe_cost_' + r.equip_id + '_mat_leather'] ?? defaultMatCost(r.rarity, 'leather')),
      mat_gem:     Number(settings['recipe_cost_' + r.equip_id + '_mat_gem']     ?? defaultMatCost(r.rarity, 'gem')),
      mat_fabric:  Number(settings['recipe_cost_' + r.equip_id + '_mat_fabric']  ?? defaultMatCost(r.rarity, 'fabric')),
      mat_essence: Number(settings['recipe_cost_' + r.equip_id + '_mat_essence'] ?? defaultMatCost(r.rarity, 'essence'))
    }
  }));
  return { success: true, recipes };
}

function defaultMatCost(rarity, type) {
  const tiers = { C: 1, R: 2, SR: 4, SSR: 8, UR: 15 };
  const base = tiers[rarity] || 1;
  // เน้นวัสดุตาม rarity (essence สำหรับ UR, gem สำหรับ SSR)
  if (rarity === 'UR' && type === 'essence') return base;
  if (rarity === 'SSR' && type === 'gem') return base;
  if (rarity === 'SR' && type === 'fabric') return base;
  if (rarity === 'R' && type === 'leather') return base;
  if (type === 'iron') return Math.max(1, base);
  return 0;
}

// --- My equipment / inventory ---
async function getMyEquipment(ctx, userId) {
  const uid = userId || (ctx.user && ctx.user.userId);
  if (!uid) return { success: true, equipped: { weapon: null, armor: null, necklace: null, ring: null, shoes: null } };
  const sb = getSupabase();
  const { data: eq } = await sb.from('pet_equipment').select(`
    slot, equip_item_id,
    equip_inventory ( equip_id, equipment_config ( name, slot, rarity, atk_bonus, hp_bonus, def_bonus, spd_bonus, lifesteal_pct, reflect_pct, armor_pen ) )
  `).eq('user_id', uid);
  const equipped = { weapon: null, armor: null, necklace: null, ring: null, shoes: null };
  (eq || []).forEach(r => {
    if (!r.equip_inventory) return;
    const cfg = r.equip_inventory.equipment_config;
    if (!cfg) return;
    equipped[r.slot] = {
      id: r.equip_inventory.equip_id, name: cfg.name, rarity: cfg.rarity, slot: cfg.slot,
      atk: cfg.atk_bonus, hp: cfg.hp_bonus, def: cfg.def_bonus, spd: cfg.spd_bonus,
      lifesteal: cfg.lifesteal_pct, reflect: cfg.reflect_pct, armorPen: cfg.armor_pen,
      equipItemId: r.equip_item_id
    };
  });
  return { success: true, equipped };
}

async function getMyEquipInventory(ctx, userId) {
  const uid = userId || (ctx.user && ctx.user.userId);
  if (!uid) return { success: true, items: [] };
  const sb = getSupabase();
  const { data } = await sb.from('equip_inventory').select(`
    equip_item_id, equip_id, created_at,
    equipment_config ( name, slot, rarity, atk_bonus, hp_bonus, def_bonus, spd_bonus, lifesteal_pct, reflect_pct, armor_pen )
  `).eq('user_id', uid).order('created_at', { ascending: false });
  const items = (data || []).map(r => ({
    equipItemId: r.equip_item_id, id: r.equip_id,
    name: r.equipment_config && r.equipment_config.name,
    slot: r.equipment_config && r.equipment_config.slot,
    rarity: r.equipment_config && r.equipment_config.rarity,
    atk: r.equipment_config && r.equipment_config.atk_bonus,
    hp:  r.equipment_config && r.equipment_config.hp_bonus,
    def: r.equipment_config && r.equipment_config.def_bonus,
    spd: r.equipment_config && r.equipment_config.spd_bonus,
    lifesteal: r.equipment_config && r.equipment_config.lifesteal_pct,
    reflect:   r.equipment_config && r.equipment_config.reflect_pct,
    armorPen:  r.equipment_config && r.equipment_config.armor_pen,
    createdAt: r.created_at
  }));
  return { success: true, items };
}

// --- equip / unequip / discard ---
async function equipFromInventory(ctx, userId, equipItemId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');

  const sb = getSupabase();
  const { data: item } = await sb.from('equip_inventory').select(`
    equip_item_id, user_id, equip_id,
    equipment_config ( slot )
  `).eq('equip_item_id', equipItemId).maybeSingle();
  if (!item) return fail('ไม่พบอุปกรณ์ในคลัง');
  if (item.user_id !== uid) return fail('สิทธิ์ไม่เพียงพอ');
  const slot = item.equipment_config && item.equipment_config.slot;
  if (!slot) return fail('อุปกรณ์ไม่มี slot');

  // ลบ slot เดิมออก (ถ้ามี) แล้ว insert ใหม่
  await sb.from('pet_equipment').delete().eq('user_id', uid).eq('slot', slot);
  const { error } = await sb.from('pet_equipment').insert({ user_id: uid, slot, equip_item_id: equipItemId });
  if (error) return fail(error.message);
  return ok({ message: 'สวมใส่อุปกรณ์เรียบร้อย', slot });
}

async function unequipToInventory(ctx, userId, slot) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  if (!SLOTS.includes(slot)) return fail('slot ไม่ถูกต้อง');
  const sb = getSupabase();
  const { error } = await sb.from('pet_equipment').delete().eq('user_id', uid).eq('slot', slot);
  if (error) return fail(error.message);
  return ok({ message: 'ถอดอุปกรณ์เรียบร้อย', slot });
}

async function discardEquipment(ctx, userId, equipItemId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  const sb = getSupabase();
  // pet_equipment cascade ลบเองเพราะ FK on delete cascade
  const { error } = await sb.from('equip_inventory').delete().eq('equip_item_id', equipItemId).eq('user_id', uid);
  if (error) return fail(error.message);
  return ok({ message: 'ทิ้งอุปกรณ์เรียบร้อย' });
}

// --- craft ---
async function craftEquipment(ctx, userId, recipeId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  const sb = getSupabase();

  const { data: cfg } = await sb.from('equipment_config').select('*').eq('equip_id', recipeId).maybeSingle();
  if (!cfg) return fail('ไม่พบสูตรคราฟนี้');

  const settings = await loadSettings(sb);

  // gold cost
  const goldCost = Number(settings['craft_gold_' + cfg.rarity] ?? { C: 5000, R: 7000, SR: 10000, SSR: 15000, UR: 20000 }[cfg.rarity]) || 5000;
  const ps = await getOrCreatePetStats(sb, uid);
  const gold = await calcCurrentGold(sb, uid, ps);
  if (gold < goldCost) return fail(`Gold ไม่พอ! ต้องใช้ ${goldCost.toLocaleString()} G (มี ${gold.toLocaleString()} G)`);

  // material costs
  const recipes = await getEquipmentRecipes();
  const recipe = recipes.recipes.find(r => r.id === recipeId);
  if (!recipe) return fail('ไม่พบสูตร');
  const mats = await getMyMaterials(ctx, uid);
  for (const k of ['mat_iron','mat_leather','mat_gem','mat_fabric','mat_essence']) {
    if ((recipe.costs[k] || 0) > 0 && (mats[k] || 0) < recipe.costs[k]) {
      return fail(`วัตถุดิบไม่พอ! ต้องใช้ ${recipe.costs[k]} ${k} (มี ${mats[k]})`);
    }
  }

  // เช็คคลังเต็ม (10 ชิ้น)
  const { count } = await sb.from('equip_inventory').select('*', { count: 'exact', head: true }).eq('user_id', uid);
  if ((count || 0) >= 10) return fail('คลังอุปกรณ์เต็ม! (สูงสุด 10 ชิ้น)');

  // หัก gold + materials
  await sb.from('pet_stats').update({
    coins_spent: (Number(ps.coins_spent) || 0) + goldCost,
    updated_at: new Date().toISOString()
  }).eq('user_id', uid);
  for (const k of ['mat_iron','mat_leather','mat_gem','mat_fabric','mat_essence']) {
    if ((recipe.costs[k] || 0) > 0) {
      const newQty = (mats[k] || 0) - recipe.costs[k];
      await sb.from('crafting_materials').upsert({ user_id: uid, mat_key: k, quantity: newQty }, { onConflict: 'user_id,mat_key' });
    }
  }

  // สร้างอุปกรณ์ใน equip_inventory
  const { data: created, error } = await sb.from('equip_inventory').insert({
    user_id: uid, equip_id: recipeId
  }).select('equip_item_id').single();
  if (error) return fail(error.message);

  const finalMats = await getMyMaterials(ctx, uid);
  const newGold = await calcCurrentGold(sb, uid, { ...ps, coins_spent: (Number(ps.coins_spent) || 0) + goldCost });

  await sb.from('notifications').insert({
    user_id: uid, type: 'item',
    message: `🔨 คราฟ <b>${cfg.name}</b> [${cfg.rarity}] สำเร็จ! 💰 หัก ${goldCost.toLocaleString()} G`
  });

  return ok({
    message: `🔨 คราฟ ${cfg.name} [${cfg.rarity}] สำเร็จ! 💰 หัก ${goldCost.toLocaleString()} G`,
    crafted: { id: cfg.equip_id, name: cfg.name, rarity: cfg.rarity, slot: cfg.slot },
    equipItemId: created.equip_item_id,
    craftGoldCost: goldCost, newGold,
    materials: finalMats
  });
}

// --- expose for PvP/leaderboard ---
async function _getEquipmentBonusForUser(sb, userId) {
  const r = await getMyEquipment({ user: { userId, role: 'Admin' } }, userId);
  const eq = r.equipped || {};
  const total = { atk: 0, hp: 0, def: 0, spd: 0, lifesteal: 0, reflect: 0, armorPen: 0 };
  for (const s of SLOTS) {
    const it = eq[s];
    if (!it) continue;
    total.atk      += Number(it.atk) || 0;
    total.hp       += Number(it.hp) || 0;
    total.def      += Number(it.def) || 0;
    total.spd      += Number(it.spd) || 0;
    total.lifesteal+= Number(it.lifesteal) || 0;
    total.reflect  += Number(it.reflect) || 0;
    total.armorPen += Number(it.armorPen) || 0;
  }
  return total;
}

module.exports = {
  getMyMaterials,
  getEquipmentRecipes,
  getMyEquipment,
  getMyEquipInventory,
  equipFromInventory,
  unequipToInventory,
  discardEquipment,
  craftEquipment,
  _getEquipmentBonusForUser
};
