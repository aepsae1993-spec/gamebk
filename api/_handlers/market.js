// ============================================================
// Market — list / buy / cancel  (pet, equipment, material)
// ============================================================
const { getSupabase } = require('../_lib/supabase');
const { ok, fail } = require('../_lib/util');
const { calcUserBaseFromSubmissions } = require('../_lib/pet');

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

function expiryDate(hours) { return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(); }

// ============================================================
// listPetForSale(userId, petItemId, price)
// ============================================================
async function listPetForSale(ctx, userId, petItemId, price) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  const p = Number(price);
  if (!isFinite(p) || p <= 0) return fail('ราคาไม่ถูกต้อง');

  const sb = getSupabase();
  const settings = await loadSettings(sb);
  const maxPerDay = Number(settings.market_max_list_per_day) || 3;
  const expireHours = Number(settings.market_expire_hours) || 24;

  // นับการลงขายวันนี้
  const today0 = new Date(); today0.setHours(0,0,0,0);
  const { count } = await sb.from('market_listings').select('*', { count: 'exact', head: true })
    .eq('seller_id', uid).gte('listed_at', today0.toISOString()).in('status', ['listed','sold']);
  if ((count || 0) >= maxPerDay) return fail(`ลงขายได้สูงสุด ${maxPerDay} ครั้ง/วัน`);

  // ตรวจ pet
  const { data: pet } = await sb.from('inventory').select('*').eq('item_id', petItemId).eq('user_id', uid).maybeSingle();
  if (!pet) return fail('ไม่พบสัตว์เลี้ยงนี้ในกระเป๋า');
  if (pet.category === 'equipped') return fail('ต้องถอดออกจากการสวมใส่ก่อน');
  if (pet.is_locked) return fail('สัตว์เลี้ยงนี้ถูกล็อคอยู่: ' + (pet.locked_reason || ''));

  // lock pet (กัน gacha confirm/discard/equip)
  await sb.from('inventory').update({ is_locked: true, locked_reason: 'listed_market' }).eq('item_id', petItemId);

  const { error } = await sb.from('market_listings').insert({
    seller_id: uid,
    seller_name: ctx.user.name || '',
    listing_type: 'pet',
    pet_item_id: petItemId,
    price: p,
    expires_at: expiryDate(expireHours),
    snapshot: {
      item_key: pet.item_key, element: pet.element,
      enhance_level: pet.enhance_level, pet_exp: pet.pet_exp, pet_level: pet.pet_level,
      pet_aura: pet.pet_aura, pet_title: pet.pet_title
    }
  });
  if (error) {
    await sb.from('inventory').update({ is_locked: false, locked_reason: '' }).eq('item_id', petItemId);
    return fail(error.message);
  }
  return ok({ message: '🛒 ลงขายเรียบร้อย!' });
}

// ============================================================
// listEquipForSale / listMaterialForSale
// ============================================================
async function listEquipForSale(ctx, userId, equipItemId, price) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  const p = Number(price);
  if (!isFinite(p) || p <= 0) return fail('ราคาไม่ถูกต้อง');
  const sb = getSupabase();
  const { data: eq } = await sb.from('equip_inventory').select('*, equipment_config(name,slot,rarity)')
    .eq('equip_item_id', equipItemId).eq('user_id', uid).maybeSingle();
  if (!eq) return fail('ไม่พบอุปกรณ์ในคลัง');
  // unequip ก่อนลงขาย
  await sb.from('pet_equipment').delete().eq('user_id', uid).eq('equip_item_id', equipItemId);
  const settings = await loadSettings(sb);
  const expireHours = Number(settings.market_expire_hours) || 24;

  const { error } = await sb.from('market_listings').insert({
    seller_id: uid, seller_name: ctx.user.name || '',
    listing_type: 'equipment', equip_item_id: equipItemId,
    price: p, expires_at: expiryDate(expireHours),
    snapshot: { equip_id: eq.equip_id, name: eq.equipment_config && eq.equipment_config.name, slot: eq.equipment_config && eq.equipment_config.slot, rarity: eq.equipment_config && eq.equipment_config.rarity }
  });
  if (error) return fail(error.message);
  return ok({ message: '🛒 ลงขายอุปกรณ์เรียบร้อย!' });
}

async function listMaterialForSale(ctx, userId, materialKey, quantity, price) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  const qty = Math.max(1, parseInt(quantity) || 1);
  const p = Number(price);
  if (!isFinite(p) || p <= 0) return fail('ราคาไม่ถูกต้อง');
  const sb = getSupabase();
  const { data: m } = await sb.from('crafting_materials').select('quantity').eq('user_id', uid).eq('mat_key', materialKey).maybeSingle();
  const have = Number(m && m.quantity) || 0;
  if (have < qty) return fail(`วัตถุดิบไม่พอ (มี ${have})`);
  // หักออกจากคลัง
  await sb.from('crafting_materials').update({ quantity: have - qty }).eq('user_id', uid).eq('mat_key', materialKey);

  const settings = await loadSettings(sb);
  const expireHours = Number(settings.market_expire_hours) || 24;
  const { error } = await sb.from('market_listings').insert({
    seller_id: uid, seller_name: ctx.user.name || '',
    listing_type: 'material', mat_key: materialKey, quantity: qty,
    price: p, expires_at: expiryDate(expireHours),
    snapshot: { mat_key: materialKey, quantity: qty }
  });
  if (error) {
    // คืนวัตถุดิบถ้า insert ล้มเหลว
    await sb.from('crafting_materials').update({ quantity: have }).eq('user_id', uid).eq('mat_key', materialKey);
    return fail(error.message);
  }
  return ok({ message: '🛒 ลงขายวัตถุดิบเรียบร้อย!' });
}

// ============================================================
// getMarketListings — ทุก listing ที่ status='listed'
// ============================================================
async function getMarketListings() {
  const sb = getSupabase();
  const { data } = await sb.from('market_listings')
    .select('*').eq('status', 'listed').order('listed_at', { ascending: false }).limit(100);
  return (data || []).map(toClient);
}

async function getMyMarketListings(ctx, userId) {
  const uid = userId || (ctx.user && ctx.user.userId);
  if (!uid) return [];
  const sb = getSupabase();
  const { data } = await sb.from('market_listings')
    .select('*').eq('seller_id', uid).order('listed_at', { ascending: false }).limit(50);
  return (data || []).map(toClient);
}

function toClient(r) {
  return {
    marketId: r.market_id, sellerId: r.seller_id, sellerName: r.seller_name,
    type: r.listing_type, petItemId: r.pet_item_id, equipItemId: r.equip_item_id,
    matKey: r.mat_key, quantity: r.quantity, price: r.price, status: r.status,
    listedAt: r.listed_at, expiresAt: r.expires_at, soldTo: r.sold_to, soldAt: r.sold_at,
    snapshot: r.snapshot || {}
  };
}

// ============================================================
// buyMarketPet / buyMarketItem (รวม)
// ============================================================
async function buyMarketPet(ctx, buyerId, marketId) {
  return _buyMarket(ctx, buyerId || ctx.user?.userId, marketId, 'pet');
}
async function buyMarketItem(ctx, buyerId, marketId) {
  return _buyMarket(ctx, buyerId || ctx.user?.userId, marketId, null);
}

async function _buyMarket(ctx, buyerId, marketId, expectType) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = buyerId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');

  const sb = getSupabase();
  const { data: listing } = await sb.from('market_listings').select('*').eq('market_id', marketId).maybeSingle();
  if (!listing) return fail('ไม่พบรายการลงขาย');
  if (listing.status !== 'listed') return fail('รายการนี้ไม่อยู่ในตลาดแล้ว');
  if (listing.seller_id === uid) return fail('ลงขายเองซื้อเองไม่ได้');
  if (expectType && listing.listing_type !== expectType) return fail('ประเภทไม่ตรง');

  // หัก gold ผู้ซื้อ
  const buyerPs = await getOrCreatePetStats(sb, uid);
  const buyerGold = await calcCurrentGold(sb, uid, buyerPs);
  if (buyerGold < listing.price) return fail(`Gold ไม่พอ (ต้องการ ${listing.price})`);

  // tax
  const settings = await loadSettings(sb);
  const taxRate = Number(settings.market_tax_rate) || 10;
  const tax = Math.floor(listing.price * taxRate / 100);
  const sellerGets = listing.price - tax;

  // อัพเดท buyer
  await sb.from('pet_stats').update({
    coins_spent: (Number(buyerPs.coins_spent) || 0) + listing.price,
    updated_at: new Date().toISOString()
  }).eq('user_id', uid);

  // อัพเดท seller (+gold)
  const sellerPs = await getOrCreatePetStats(sb, listing.seller_id);
  await sb.from('pet_stats').update({
    free_coins: (Number(sellerPs.free_coins) || 0) + sellerGets,
    updated_at: new Date().toISOString()
  }).eq('user_id', listing.seller_id);

  // ย้ายของ
  if (listing.listing_type === 'pet' && listing.pet_item_id) {
    await sb.from('inventory').update({
      user_id: uid, is_locked: false, locked_reason: ''
    }).eq('item_id', listing.pet_item_id);
  } else if (listing.listing_type === 'equipment' && listing.equip_item_id) {
    await sb.from('equip_inventory').update({ user_id: uid }).eq('equip_item_id', listing.equip_item_id);
  } else if (listing.listing_type === 'material' && listing.mat_key) {
    const { data: m } = await sb.from('crafting_materials').select('quantity').eq('user_id', uid).eq('mat_key', listing.mat_key).maybeSingle();
    const newQty = (Number(m && m.quantity) || 0) + (listing.quantity || 1);
    await sb.from('crafting_materials').upsert({ user_id: uid, mat_key: listing.mat_key, quantity: newQty }, { onConflict: 'user_id,mat_key' });
  }

  // mark sold
  await sb.from('market_listings').update({
    status: 'sold', sold_to: uid, sold_at: new Date().toISOString()
  }).eq('market_id', marketId);

  // notify seller
  await sb.from('notifications').insert({
    user_id: listing.seller_id, type: 'market',
    message: `🛍️ ขายของในตลาดสำเร็จ! ได้รับ <b>${sellerGets} G</b> (ภาษี ${tax})`
  });

  return ok({ message: '✅ ซื้อสำเร็จ!', goldSpent: listing.price });
}

// ============================================================
// cancelMarketListing / cancelEquipMatListing — ใช้ตัวเดียวก็ได้
// ============================================================
async function cancelMarketListing(ctx, userId, marketId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  const sb = getSupabase();
  const { data: listing } = await sb.from('market_listings').select('*').eq('market_id', marketId).maybeSingle();
  if (!listing) return fail('ไม่พบรายการ');
  if (listing.seller_id !== uid && ctx.user.role !== 'Admin') return fail('สิทธิ์ไม่เพียงพอ');
  if (listing.status !== 'listed') return fail('รายการนี้ไม่ active แล้ว');

  // unlock / คืนของ
  if (listing.listing_type === 'pet' && listing.pet_item_id) {
    await sb.from('inventory').update({ is_locked: false, locked_reason: '' }).eq('item_id', listing.pet_item_id);
  } else if (listing.listing_type === 'material' && listing.mat_key) {
    const { data: m } = await sb.from('crafting_materials').select('quantity').eq('user_id', listing.seller_id).eq('mat_key', listing.mat_key).maybeSingle();
    const newQty = (Number(m && m.quantity) || 0) + (listing.quantity || 1);
    await sb.from('crafting_materials').upsert({ user_id: listing.seller_id, mat_key: listing.mat_key, quantity: newQty }, { onConflict: 'user_id,mat_key' });
  }
  // equipment ค้างใน equip_inventory อยู่แล้ว (แค่ยกเลิก listing)

  await sb.from('market_listings').update({ status: 'cancelled' }).eq('market_id', marketId);
  return ok({ message: '🚫 ยกเลิกการลงขายเรียบร้อย' });
}

// alias: cancelEquipMatListing (frontend เรียกชื่อนี้)
async function cancelEquipMatListing(ctx, userId, marketId) {
  return cancelMarketListing(ctx, userId, marketId);
}

// ============================================================
// clearMarketHistory(userId) — ล้างประวัติ sold/cancelled ของตัวเอง
// ============================================================
async function clearMarketHistory(ctx, userId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  const sb = getSupabase();
  const { error } = await sb.from('market_listings').delete().eq('seller_id', uid).in('status', ['sold','cancelled','expired']);
  if (error) return fail(error.message);
  return ok({ message: 'ล้างประวัติเรียบร้อย' });
}

module.exports = {
  listPetForSale, listEquipForSale, listMaterialForSale,
  getMarketListings, getMyMarketListings,
  buyMarketPet, buyMarketItem,
  cancelMarketListing, cancelEquipMatListing,
  clearMarketHistory
};
