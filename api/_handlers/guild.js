// ============================================================
// Guild — basic (create/join/leave/chat/farm/donate/expand)
// Guild War: stub functions ไว้ก่อน (Phase 2E)
// ============================================================
const { getSupabase } = require('../_lib/supabase');
const { ok, fail } = require('../_lib/util');
const { calcUserBaseFromSubmissions } = require('../_lib/pet');

async function loadSettings(sb) {
  const { data } = await sb.from('settings').select('key,value');
  const m = {}; (data || []).forEach(r => { m[r.key] = r.value; });
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

function guildExpForLevel(level) {
  // level 1-N — สูตรง่าย ๆ: ×1.5
  if (level <= 1) return 1000;
  return Math.floor(1000 * Math.pow(1.5, level - 1));
}

function calcGuildLevel(totalExp) {
  let level = 1; let exp = totalExp;
  while (level < 50) {
    const need = guildExpForLevel(level);
    if (exp >= need) { exp -= need; level++; }
    else return { level, currentExp: exp, maxExp: need };
  }
  return { level: 50, currentExp: exp, maxExp: guildExpForLevel(50) };
}

// ============================================================
// getGuildList()
// ============================================================
async function getGuildList() {
  const sb = getSupabase();
  const { data: guilds } = await sb.from('guilds').select('*').order('exp_total', { ascending: false });
  const ids = (guilds || []).map(g => g.guild_id);
  let memberCounts = {};
  if (ids.length > 0) {
    const { data: members } = await sb.from('guild_members').select('guild_id, role').in('guild_id', ids).neq('role', 'pending');
    (members || []).forEach(m => { memberCounts[m.guild_id] = (memberCounts[m.guild_id] || 0) + 1; });
  }
  const joinModeMap = { open: 'auto', request: 'approve', closed: 'closed' };
  return (guilds || []).map(g => {
    const lvl = calcGuildLevel(g.exp_total || 0);
    return {
      guildId: g.guild_id, name: g.name, leaderId: g.leader_id,
      funds: g.funds || 0, expTotal: g.exp_total || 0,
      level: lvl.level, currentExp: lvl.currentExp, maxExp: lvl.maxExp,
      memberLimit: g.member_limit || 10,
      joinMode: joinModeMap[g.join_mode] || 'approve',
      memberCount: memberCounts[g.guild_id] || 0,
      createdAt: g.created_at
    };
  });
}

// ============================================================
// getMyGuild(userId)  — return shape ตรงกับ frontend (myGuild.hasGuild, myGuild.guild.*)
// ============================================================
async function getMyGuild(ctx, userId) {
  const uid = userId || (ctx.user && ctx.user.userId);
  if (!uid) return { hasGuild: false };
  const sb = getSupabase();

  // 1. หา membership ใดๆ (รวม pending)
  const { data: anyMembership } = await sb.from('guild_members').select('*').eq('user_id', uid).maybeSingle();
  if (!anyMembership) return { hasGuild: false, isPending: false };

  if (anyMembership.role === 'pending') {
    const { data: pendingGuild } = await sb.from('guilds').select('name').eq('guild_id', anyMembership.guild_id).maybeSingle();
    return { hasGuild: false, isPending: true, pendingGuildName: pendingGuild ? pendingGuild.name : '' };
  }

  // 2. โหลด guild + members
  const m = anyMembership;
  const { data: guild } = await sb.from('guilds').select('*').eq('guild_id', m.guild_id).maybeSingle();
  if (!guild) return { hasGuild: false };

  const { data: allMembers } = await sb.from('guild_members')
    .select('user_id, role, guild_points, joined_at').eq('guild_id', m.guild_id);
  const memberIds = (allMembers || []).map(x => x.user_id);
  let nameMap = {};
  if (memberIds.length > 0) {
    const { data: users } = await sb.from('users').select('user_id, name').in('user_id', memberIds);
    (users || []).forEach(u => { nameMap[u.user_id] = u.name; });
  }

  const lvl = calcGuildLevel(guild.exp_total || 0);
  const activeMembers = (allMembers || []).filter(x => x.role !== 'pending');
  const pendingMembers = (allMembers || []).filter(x => x.role === 'pending').map(x => ({
    userId: x.user_id, name: nameMap[x.user_id] || '', requestedAt: x.joined_at
  }));

  // map join_mode: DB(open|request|closed) → frontend(auto|approve|closed)
  const joinModeMap = { open: 'auto', request: 'approve', closed: 'closed' };

  // chat — recent 50
  const { data: chats } = await sb.from('guild_chat')
    .select('*').eq('guild_id', m.guild_id).order('sent_at', { ascending: false }).limit(50);

  // expand cost
  const expandCost = (Number(guild.member_limit) || 10) * 1000;

  return {
    hasGuild: true,
    isPending: false,
    myRole: m.role,
    myGuildPoints: m.guild_points || 0,
    memberCount: activeMembers.length,
    members: activeMembers.map(x => ({
      userId: x.user_id, name: nameMap[x.user_id] || '', role: x.role,
      guildPoints: x.guild_points || 0, joinedAt: x.joined_at
    })),
    pendingMembers,
    expandCost,
    guildBuffs: { atkPct: 0, hpPct: 0 }, // Phase 2C ยังไม่ implement guild buff
    chats: (chats || []).reverse().map(c => ({
      id: c.chat_id, userId: c.user_id, userName: c.user_name,
      message: c.message, sentAt: c.sent_at
    })),
    guild: {
      guildId: guild.guild_id,
      name: guild.name,
      leaderId: guild.leader_id,
      leaderName: nameMap[guild.leader_id] || '',
      funds: Number(guild.funds) || 0,
      expTotal: Number(guild.exp_total) || 0,
      level: lvl.level,
      currentExp: lvl.currentExp,
      maxExp: lvl.maxExp,
      memberLimit: guild.member_limit || 10,
      joinMode: joinModeMap[guild.join_mode] || 'approve'
    }
  };
}

// ============================================================
// createGuild(userId, guildName)
// ============================================================
async function createGuild(ctx, userId, guildName) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  const name = String(guildName || '').trim();
  if (!name || name.length < 3) return fail('ชื่อกิลด์ต้อง ≥ 3 ตัวอักษร');

  const sb = getSupabase();
  const { data: existing } = await sb.from('guild_members').select('guild_id').eq('user_id', uid).neq('role', 'pending').maybeSingle();
  if (existing) return fail('คุณอยู่ในกิลด์อื่นแล้ว');

  // ค่าใช้จ่าย 50,000 G (ตาม frontend)
  const CREATE_COST = 50000;
  const ps = await getOrCreatePetStats(sb, uid);
  const gold = await calcCurrentGold(sb, uid, ps);
  if (gold < CREATE_COST) return fail(`Gold ไม่พอ (ต้องการ ${CREATE_COST.toLocaleString()} G)`);

  const { data: dup } = await sb.from('guilds').select('guild_id').eq('name', name).maybeSingle();
  if (dup) return fail('มีชื่อกิลด์นี้อยู่แล้ว');

  const { data: g, error } = await sb.from('guilds').insert({
    name, leader_id: uid, funds: 0, exp_total: 0, member_limit: 10
  }).select('guild_id').single();
  if (error) return fail(error.message);

  await sb.from('pet_stats').update({
    coins_spent: (Number(ps.coins_spent) || 0) + CREATE_COST,
    updated_at: new Date().toISOString()
  }).eq('user_id', uid);

  await sb.from('guild_members').insert({ guild_id: g.guild_id, user_id: uid, role: 'leader' });

  return ok({ message: 'สร้างกิลด์สำเร็จ!', guildId: g.guild_id });
}

// ============================================================
// joinGuild / approve / reject / leave / kick / mode
// ============================================================
async function joinGuild(ctx, userId, guildId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  const sb = getSupabase();
  const { data: existing } = await sb.from('guild_members').select('guild_id, role').eq('user_id', uid).neq('role', 'pending').maybeSingle();
  if (existing) return fail('คุณอยู่ในกิลด์อยู่แล้ว');

  const { data: g } = await sb.from('guilds').select('*').eq('guild_id', guildId).maybeSingle();
  if (!g) return fail('ไม่พบกิลด์');
  if (g.join_mode === 'closed') return fail('กิลด์นี้ปิดรับสมาชิก');

  const { count } = await sb.from('guild_members').select('*', { count: 'exact', head: true }).eq('guild_id', guildId).neq('role', 'pending');
  if ((count || 0) >= (g.member_limit || 10)) return fail('กิลด์เต็มแล้ว');

  const role = g.join_mode === 'open' ? 'member' : 'pending';
  // ลบ pending ของ guild อื่นก่อน (รอ approve ที่เดียวเท่านั้น)
  await sb.from('guild_members').delete().eq('user_id', uid).eq('role', 'pending');
  const { error } = await sb.from('guild_members').insert({ guild_id: guildId, user_id: uid, role });
  if (error) return fail(error.message);

  return ok({ message: role === 'pending' ? 'ส่งคำขอเข้าร่วมแล้ว' : '✅ เข้าร่วมกิลด์สำเร็จ!', joined: role !== 'pending' });
}

async function approveGuildJoin(ctx, leaderId, targetId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const lid = leaderId || ctx.user.userId;
  const sb = getSupabase();
  const { data: leader } = await sb.from('guild_members').select('guild_id, role').eq('user_id', lid).maybeSingle();
  if (!leader || (leader.role !== 'leader' && leader.role !== 'officer')) return fail('สิทธิ์ไม่เพียงพอ');
  const { error } = await sb.from('guild_members').update({ role: 'member' })
    .eq('user_id', targetId).eq('guild_id', leader.guild_id).eq('role', 'pending');
  if (error) return fail(error.message);
  return ok({ message: 'อนุมัติเรียบร้อย' });
}

async function rejectGuildJoin(ctx, leaderId, targetId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const lid = leaderId || ctx.user.userId;
  const sb = getSupabase();
  const { data: leader } = await sb.from('guild_members').select('guild_id, role').eq('user_id', lid).maybeSingle();
  if (!leader || (leader.role !== 'leader' && leader.role !== 'officer')) return fail('สิทธิ์ไม่เพียงพอ');
  await sb.from('guild_members').delete().eq('user_id', targetId).eq('guild_id', leader.guild_id).eq('role', 'pending');
  return ok({ message: 'ปฏิเสธเรียบร้อย' });
}

async function leaveGuild(ctx, userId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  const sb = getSupabase();
  const { data: m } = await sb.from('guild_members').select('guild_id, role').eq('user_id', uid).neq('role', 'pending').maybeSingle();
  if (!m) return fail('คุณไม่ได้อยู่ในกิลด์');
  if (m.role === 'leader') {
    const { count } = await sb.from('guild_members').select('*', { count: 'exact', head: true }).eq('guild_id', m.guild_id).neq('role', 'pending');
    if ((count || 0) > 1) return fail('หัวหน้ากิลด์ต้องโอนตำแหน่งหรือ kick สมาชิกก่อน');
    // เป็นคนเดียว → ลบกิลด์ทั้งกิลด์
    await sb.from('guilds').delete().eq('guild_id', m.guild_id);
    return ok({ message: 'ยุบกิลด์เรียบร้อย' });
  }
  await sb.from('guild_members').delete().eq('user_id', uid).eq('guild_id', m.guild_id);
  return ok({ message: 'ออกจากกิลด์เรียบร้อย' });
}

async function kickGuildMember(ctx, leaderId, targetId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const lid = leaderId || ctx.user.userId;
  const sb = getSupabase();
  const { data: leader } = await sb.from('guild_members').select('guild_id, role').eq('user_id', lid).maybeSingle();
  if (!leader || leader.role !== 'leader') return fail('เฉพาะหัวหน้ากิลด์');
  await sb.from('guild_members').delete().eq('user_id', targetId).eq('guild_id', leader.guild_id);
  return ok({ message: 'kick สมาชิกแล้ว' });
}

async function setGuildJoinMode(ctx, leaderId, mode) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const lid = leaderId || ctx.user.userId;
  // map frontend mode (auto/approve/closed) → DB (open/request/closed)
  const aliasMap = { auto: 'open', approve: 'request', closed: 'closed', open: 'open', request: 'request' };
  const dbMode = aliasMap[mode];
  if (!dbMode) return fail('mode ไม่ถูกต้อง');
  const sb = getSupabase();
  const { data: leader } = await sb.from('guild_members').select('guild_id, role').eq('user_id', lid).maybeSingle();
  if (!leader || leader.role !== 'leader') return fail('เฉพาะหัวหน้ากิลด์');
  await sb.from('guilds').update({ join_mode: dbMode }).eq('guild_id', leader.guild_id);
  return ok();
}

// ============================================================
// donateToGuild / expandGuildLimit
// ============================================================
async function donateToGuild(ctx, userId, amount) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  const amt = Number(amount);
  if (!isFinite(amt) || amt <= 0) return fail('จำนวนไม่ถูกต้อง');
  const sb = getSupabase();
  const { data: m } = await sb.from('guild_members').select('guild_id').eq('user_id', uid).neq('role', 'pending').maybeSingle();
  if (!m) return fail('คุณไม่ได้อยู่ในกิลด์');

  const ps = await getOrCreatePetStats(sb, uid);
  const gold = await calcCurrentGold(sb, uid, ps);
  if (gold < amt) return fail('Gold ไม่พอ');

  await sb.from('pet_stats').update({
    coins_spent: (Number(ps.coins_spent) || 0) + amt,
    updated_at: new Date().toISOString()
  }).eq('user_id', uid);

  // เพิ่ม funds + exp + GP ของผู้บริจาค
  const { data: g } = await sb.from('guilds').select('funds, exp_total').eq('guild_id', m.guild_id).maybeSingle();
  await sb.from('guilds').update({
    funds: (Number(g.funds) || 0) + amt,
    exp_total: (Number(g.exp_total) || 0) + amt
  }).eq('guild_id', m.guild_id);

  const { data: mr } = await sb.from('guild_members').select('guild_points').eq('user_id', uid).eq('guild_id', m.guild_id).maybeSingle();
  await sb.from('guild_members').update({
    guild_points: (Number(mr && mr.guild_points) || 0) + Math.floor(amt / 10)
  }).eq('user_id', uid).eq('guild_id', m.guild_id);

  return ok({ message: `บริจาค ${amt} G สำเร็จ! ได้รับ ${Math.floor(amt/10)} GP` });
}

async function expandGuildLimit(ctx, userId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  const sb = getSupabase();
  const { data: m } = await sb.from('guild_members').select('guild_id, role').eq('user_id', uid).maybeSingle();
  if (!m || m.role !== 'leader') return fail('เฉพาะหัวหน้ากิลด์');
  const { data: g } = await sb.from('guilds').select('funds, member_limit').eq('guild_id', m.guild_id).maybeSingle();
  const cur = Number(g.member_limit) || 10;
  const cost = cur * 1000; // 10×1000=10000 G
  if (g.funds < cost) return fail(`คลังกิลด์ไม่พอ (ต้องการ ${cost} G)`);
  if (cur >= 50) return fail('ขยายได้สูงสุด 50 คน');
  await sb.from('guilds').update({
    funds: g.funds - cost, member_limit: cur + 1
  }).eq('guild_id', m.guild_id);
  return ok({ message: `ขยายกิลด์เป็น ${cur + 1} คนแล้ว!`, newLimit: cur + 1 });
}

// ============================================================
// Guild Chat
// ============================================================
async function sendGuildChat(ctx, userId, message) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  const msg = String(message || '').trim().substring(0, 500);
  if (!msg) return fail('ข้อความว่าง');
  const sb = getSupabase();
  const { data: m } = await sb.from('guild_members').select('guild_id').eq('user_id', uid).neq('role', 'pending').maybeSingle();
  if (!m) return fail('คุณไม่ได้อยู่ในกิลด์');
  const { error } = await sb.from('guild_chat').insert({
    guild_id: m.guild_id, user_id: uid, user_name: ctx.user.name || '', message: msg
  });
  if (error) return fail(error.message);
  return ok();
}

// ============================================================
// Guild Ranking
// ============================================================
async function getGuildRanking() {
  return getGuildList();
}

// ============================================================
// Guild Shop (basic — cuts permanent buffs only)
// ============================================================
async function buyGuildShopItem(ctx, userId, itemId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  const sb = getSupabase();
  const settings = await loadSettings(sb);
  const price = Number(settings['guild_price_' + itemId]);
  if (!isFinite(price) || price <= 0) return fail('ไอเทมไม่พร้อมขาย');

  const { data: m } = await sb.from('guild_members').select('guild_id, guild_points').eq('user_id', uid).neq('role', 'pending').maybeSingle();
  if (!m) return fail('คุณไม่ได้อยู่ในกิลด์');
  const cur = Number(m.guild_points) || 0;
  if (cur < price) return fail(`GP ไม่พอ! ต้องใช้ ${price} GP (มี ${cur})`);

  await sb.from('guild_members').update({ guild_points: cur - price })
    .eq('user_id', uid).eq('guild_id', m.guild_id);

  // apply effect (เพิ่มเข้า activeBuff)
  const ps = await getOrCreatePetStats(sb, uid);
  let buff = ps.active_buff || '';
  let effectMsg = '';

  if (itemId === 'perm_atk_5')   { buff = setGuildPerm(buff, 'atk', 5); effectMsg = 'ATK +5 ถาวร'; }
  else if (itemId === 'perm_hp_200') { buff = setGuildPerm(buff, 'hp', 200); effectMsg = 'HP +200 ถาวร'; }
  else if (itemId === 'perm_def_3')  { buff = setGuildPerm(buff, 'def', 3); effectMsg = 'DEF +3 ถาวร'; }
  else if (itemId === 'perm_spd_2')  { buff = setGuildPerm(buff, 'spd', 2); effectMsg = 'SPD +2 ถาวร'; }
  else if (itemId.startsWith('mat_')) {
    // ซื้อวัตถุดิบจาก GP
    const { data: cm } = await sb.from('crafting_materials').select('quantity').eq('user_id', uid).eq('mat_key', itemId).maybeSingle();
    await sb.from('crafting_materials').upsert({ user_id: uid, mat_key: itemId, quantity: (Number(cm && cm.quantity) || 0) + 1 }, { onConflict: 'user_id,mat_key' });
    effectMsg = `ได้รับ ${itemId} ×1`;
  } else {
    effectMsg = 'ซื้อสำเร็จ (effect ยังไม่ implement)';
  }

  if (buff !== ps.active_buff) {
    await sb.from('pet_stats').update({ active_buff: buff, updated_at: new Date().toISOString() }).eq('user_id', uid);
  }
  return ok({ message: `ซื้อ ${itemId} สำเร็จ! ${effectMsg}` });
}

function setGuildPerm(buffStr, key, value) {
  const prefix = 'guildPerm_' + key + ':';
  const arr = buffStr ? String(buffStr).split(',').filter(b => b && !b.startsWith(prefix)) : [];
  arr.push(prefix + value);
  return arr.join(',');
}

// ============================================================
// Guild Farm — slot 1 default, ขยายได้ถึง 5 (ใช้เงินกิล 1,000,000 G ต่อช่อง)
// ============================================================
const FARM_DEFAULT_SLOTS = 1;
const FARM_MAX_SLOTS = 5;
const FARM_NEXT_COST = 1000000;
const FARM_NEXT_LEVEL_REQ = 5;
const FARM_MAX_HOURS = 8;

async function getGuildFarmData(ctx, userId) {
  const uid = userId || (ctx.user && ctx.user.userId);
  if (!uid) return { success: true, totalSlots: FARM_DEFAULT_SLOTS, farmSlots: [], availablePets: [], boughtSlots: 0, expPerHour: 1000 };
  const sb = getSupabase();

  const settings = await loadSettings(sb);
  const expPerHour = Number(settings.farm_per_hour) || 1000;
  const boughtSlots = Number(settings['farm_slot_extra_' + uid]) || 0;
  const totalSlots = Math.min(FARM_MAX_SLOTS, FARM_DEFAULT_SLOTS + boughtSlots);

  // farm rows + inventory + pet_config (สำหรับ rarity)
  const [farmRes, invRes, petCfgRes, myGuildRes] = await Promise.all([
    sb.from('guild_farm').select('*').eq('user_id', uid).order('slot_index'),
    sb.from('inventory').select('*').eq('user_id', uid).in('category', ['pets']),
    sb.from('pet_config').select('pet_type, rarity'),
    sb.from('guild_members').select('guild_id, role').eq('user_id', uid).neq('role', 'pending').maybeSingle()
  ]);

  const rarityMap = {};
  (petCfgRes.data || []).forEach(p => { rarityMap[p.pet_type] = p.rarity; });

  // คำนวณ farmSlots ที่กำลังฟาร์มอยู่
  const farmSlots = [];
  const occupiedPetIds = new Set();
  for (const f of farmRes.data || []) {
    if (!f.pet_item_id) continue;
    occupiedPetIds.add(f.pet_item_id);
    const pet = (invRes.data || []).find(p => p.item_id === f.pet_item_id);
    const startMs = f.started_at ? new Date(f.started_at).getTime() : Date.now();
    const elapsedMs = Date.now() - startMs;
    const cappedHours = Math.min(FARM_MAX_HOURS, elapsedMs / 3600000);
    const multi = Number(f.farm_multiplier) || 1;
    const accruedExp = Math.floor(cappedHours * expPerHour * multi);
    let petLevel = 1;
    if (pet) {
      const exp = Number(pet.pet_exp) || 0;
      let lv = 1, e = exp;
      while (lv < 100) {
        const need = lv <= 30 ? (1000 + (lv - 1) * 500)
          : lv <= 60 ? (1000 + 29 * 500 + (lv - 30) * 350)
          : (1000 + 29 * 500 + 30 * 350 + (lv - 60) * 200);
        if (e >= need) { e -= need; lv++; } else break;
      }
      petLevel = lv;
    }
    farmSlots.push({
      slotIndex: f.slot_index,
      occupied: true,
      petItemId: f.pet_item_id,
      type: pet ? pet.item_key : '',
      element: pet ? pet.element : 'normal',
      enhance: pet ? (Number(pet.enhance_level) || 0) : 0,
      petLevel,
      rarity: pet ? (rarityMap[pet.item_key] || 'C') : 'C',
      // ส่งเป็น ms (number) เพื่อให้ frontend ใช้ Date.now() - pet.startTime ได้ตรง ๆ
      startTime: startMs,
      startedAt: f.started_at,
      farmMultiplier: multi,
      exp: accruedExp,
      maxHours: FARM_MAX_HOURS
    });
  }

  // available pets = pets ที่ไม่ได้ลงตลาด, ไม่ได้ฟาร์มอยู่, ไม่ใช่ equipped
  const { data: marketRows } = await sb.from('market_listings')
    .select('pet_item_id').eq('seller_id', uid).eq('status', 'listed').eq('listing_type', 'pet');
  const onMarket = new Set((marketRows || []).map(r => r.pet_item_id));

  const availablePets = (invRes.data || [])
    .filter(p => !occupiedPetIds.has(p.item_id) && !onMarket.has(p.item_id) && !p.is_locked)
    .map(p => {
      const exp = Number(p.pet_exp) || 0;
      let lv = 1, e = exp;
      while (lv < 100) {
        const need = lv <= 30 ? (1000 + (lv - 1) * 500)
          : lv <= 60 ? (1000 + 29 * 500 + (lv - 30) * 350)
          : (1000 + 29 * 500 + 30 * 350 + (lv - 60) * 200);
        if (e >= need) { e -= need; lv++; } else break;
      }
      return {
        itemId: p.item_id,
        type: p.item_key,
        element: p.element || 'normal',
        enhance: Number(p.enhance_level) || 0,
        petLevel: lv,
        rarity: rarityMap[p.item_key] || 'C'
      };
    });

  // farm multiplier items จาก inventory (item_key='farm_x3', 'farm_x5', 'farm_x10')
  const farmMultiStock = { 3: 0, 5: 0, 10: 0 };
  const { data: items } = await sb.from('inventory').select('item_key, quantity')
    .eq('user_id', uid).eq('category', 'items').in('item_key', ['farm_x3','farm_x5','farm_x10']);
  (items || []).forEach(i => {
    if (i.item_key === 'farm_x3')  farmMultiStock[3]  = Number(i.quantity) || 0;
    if (i.item_key === 'farm_x5')  farmMultiStock[5]  = Number(i.quantity) || 0;
    if (i.item_key === 'farm_x10') farmMultiStock[10] = Number(i.quantity) || 0;
  });

  // ตรวจ: ขยาย slot ใหม่ได้มั้ย (ต้องอยู่ในกิล + กิลถึง level req + funds พอ)
  let canBuyNextSlot = false;
  let nextSlotCost = FARM_NEXT_COST;
  if (myGuildRes && myGuildRes.data) {
    const { data: g } = await sb.from('guilds').select('funds, exp_total').eq('guild_id', myGuildRes.data.guild_id).maybeSingle();
    const lvl = calcGuildLevel(Number(g && g.exp_total) || 0);
    canBuyNextSlot = totalSlots < FARM_MAX_SLOTS
      && lvl.level >= FARM_NEXT_LEVEL_REQ
      && Number(g && g.funds || 0) >= nextSlotCost;
  }

  return {
    success: true,
    totalSlots,
    boughtSlots,
    maxUnlockableSlots: FARM_MAX_SLOTS,
    nextSlotCost,
    nextSlotLevel: FARM_NEXT_LEVEL_REQ,
    canBuyNextSlot,
    hasExpBoost: false,   // Phase 2D ยังไม่มี exp boost
    expPerHour,
    farmSlots,
    availablePets,
    farmMultiStock
  };
}

async function startFarming(ctx, userId, slotIndex, petItemId, farmMultiplier) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  const sb = getSupabase();
  // ตรวจ pet
  const { data: pet } = await sb.from('inventory').select('*').eq('item_id', petItemId).eq('user_id', uid).maybeSingle();
  if (!pet || pet.category !== 'pets') return fail('เลือกสัตว์เลี้ยงในกระเป๋า (ที่ไม่ใช่ตัวที่สวมใส่)');
  if (pet.is_locked) return fail('สัตว์ตัวนี้ถูกล็อคอยู่');

  await sb.from('inventory').update({ is_locked: true, locked_reason: 'farming' }).eq('item_id', petItemId);

  const { error } = await sb.from('guild_farm').upsert({
    user_id: uid, slot_index: Number(slotIndex) || 0,
    pet_item_id: petItemId, started_at: new Date().toISOString(),
    farm_multiplier: Number(farmMultiplier) || 1
  }, { onConflict: 'user_id,slot_index' });
  if (error) {
    await sb.from('inventory').update({ is_locked: false, locked_reason: '' }).eq('item_id', petItemId);
    return fail(error.message);
  }
  return ok({ message: 'เริ่มฟาร์มแล้ว!' });
}

async function collectFarmExp(ctx, userId, slotIndex) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  const sb = getSupabase();
  const { data: f } = await sb.from('guild_farm').select('*').eq('user_id', uid).eq('slot_index', Number(slotIndex) || 0).maybeSingle();
  if (!f || !f.pet_item_id) return fail('slot นี้ไม่มี pet ฟาร์มอยู่');
  const settings = await loadSettings(sb);
  const expPerHour = Number(settings.farm_per_hour) || 1000;
  const elapsedHours = Math.min(FARM_MAX_HOURS, (Date.now() - new Date(f.started_at).getTime()) / 3600000);
  const exp = Math.floor(elapsedHours * expPerHour * (Number(f.farm_multiplier) || 1));
  if (exp <= 0) return fail('ยังไม่ถึงเวลาเก็บ EXP');

  // update pet exp
  const { data: pet } = await sb.from('inventory').select('pet_exp').eq('item_id', f.pet_item_id).maybeSingle();
  const newExp = (Number(pet && pet.pet_exp) || 0) + exp;
  await sb.from('inventory').update({ pet_exp: newExp }).eq('item_id', f.pet_item_id);

  // reset start_time
  await sb.from('guild_farm').update({ started_at: new Date().toISOString() }).eq('user_id', uid).eq('slot_index', Number(slotIndex) || 0);
  return ok({ message: `เก็บ EXP +${exp} สำเร็จ!`, expGained: exp });
}

async function stopFarming(ctx, userId, slotIndex) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  const sb = getSupabase();
  const { data: f } = await sb.from('guild_farm').select('pet_item_id').eq('user_id', uid).eq('slot_index', Number(slotIndex) || 0).maybeSingle();
  if (f && f.pet_item_id) {
    await sb.from('inventory').update({ is_locked: false, locked_reason: '' }).eq('item_id', f.pet_item_id);
  }
  await sb.from('guild_farm').delete().eq('user_id', uid).eq('slot_index', Number(slotIndex) || 0);
  return ok({ message: 'หยุดฟาร์มแล้ว' });
}

async function buyFarmSlot(ctx, userId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  const sb = getSupabase();

  // ต้องอยู่กิล + กิลถึง level req + funds พอ
  const { data: m } = await sb.from('guild_members').select('guild_id, role').eq('user_id', uid).neq('role', 'pending').maybeSingle();
  if (!m) return fail('ต้องอยู่ในกิลก่อนถึงจะขยาย farm ได้');
  const { data: g } = await sb.from('guilds').select('funds, exp_total').eq('guild_id', m.guild_id).maybeSingle();
  const lvl = calcGuildLevel(Number(g && g.exp_total) || 0);
  if (lvl.level < FARM_NEXT_LEVEL_REQ) return fail(`ต้องการกิลด์เลเวล ≥ ${FARM_NEXT_LEVEL_REQ} (ปัจจุบัน Lv.${lvl.level})`);
  if (Number(g && g.funds || 0) < FARM_NEXT_COST) return fail(`คลังกิลด์ไม่พอ (ต้องการ ${FARM_NEXT_COST.toLocaleString()} G)`);

  const settings = await loadSettings(sb);
  const bought = Number(settings['farm_slot_extra_' + uid]) || 0;
  if (FARM_DEFAULT_SLOTS + bought >= FARM_MAX_SLOTS) return fail(`ขยายได้สูงสุด ${FARM_MAX_SLOTS} ช่องแล้ว`);

  // หักเงินกิล
  await sb.from('guilds').update({ funds: Number(g.funds) - FARM_NEXT_COST }).eq('guild_id', m.guild_id);
  // เพิ่ม slot
  await sb.from('settings').upsert({ key: 'farm_slot_extra_' + uid, value: bought + 1 }, { onConflict: 'key' });
  return ok({ message: `ขยายช่องฟาร์มสำเร็จ! ตอนนี้มี ${FARM_DEFAULT_SLOTS + bought + 1}/${FARM_MAX_SLOTS} ช่อง` });
}

// ============================================================
// Guild War — STUB (Phase 2E)
// ============================================================
function _stubWar() { return { active: false, message: 'Guild War ยังไม่เปิด (Phase 2E)' }; }
async function getGuildWarList()    { return []; }
async function getGuildWarStatus()  { return _stubWar(); }
async function getGuildRanking2()   { return getGuildList(); }
async function joinGuildWar()       { return fail('Guild War ยังไม่เปิด (Phase 2E)'); }
async function getWarBattlefield()  { return _stubWar(); }
async function getWarBattlefieldLite() { return _stubWar(); }
async function checkWarParticipant() { return { isParticipant: false }; }
async function placeDefender()      { return fail('Guild War ยังไม่เปิด'); }
async function attackDefender()     { return fail('Guild War ยังไม่เปิด'); }
async function attackFortress()     { return fail('Guild War ยังไม่เปิด'); }
async function useWarItem()         { return fail('Guild War ยังไม่เปิด'); }
async function createGuildWar()     { return fail('Guild War ยังไม่เปิด'); }
async function cancelGuildWar()     { return fail('Guild War ยังไม่เปิด'); }
async function startGuildWar()      { return fail('Guild War ยังไม่เปิด'); }
async function endGuildWar()        { return fail('Guild War ยังไม่เปิด'); }

module.exports = {
  // basic
  getGuildList, getMyGuild, createGuild, joinGuild,
  approveGuildJoin, rejectGuildJoin, leaveGuild, kickGuildMember,
  setGuildJoinMode, donateToGuild, expandGuildLimit, sendGuildChat,
  getGuildRanking, buyGuildShopItem,
  // farm
  getGuildFarmData, startFarming, collectFarmExp, stopFarming, buyFarmSlot,
  // war (stub)
  getGuildWarList, getGuildWarStatus, joinGuildWar, getWarBattlefield, getWarBattlefieldLite,
  checkWarParticipant, placeDefender, attackDefender, attackFortress, useWarItem,
  createGuildWar, cancelGuildWar, startGuildWar, endGuildWar
};
