// ============================================================
// Weekly Boss
// ============================================================
const { getSupabase } = require('../_lib/supabase');
const { ok, fail } = require('../_lib/util');
const { calculatePetLevelFromExp, calcEnhanceHpBonus, calculateMaxHp } = require('../_lib/pet');
const { pickEquippedPetRow } = require('../_lib/equippedPet');

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

function elementMultiplier(a, t) {
  if (!a) a = 'normal'; if (!t) t = 'normal';
  if (t === 'normal' && a !== 'normal') return 2.0;
  if (a === 'normal' || t === 'normal') return 1.0;
  if (a === 'light' && t === 'dark') return 1.5;
  if (a === 'dark' && t === 'light') return 1.5;
  const wheel = { fire: 'wind', wind: 'earth', earth: 'water', water: 'fire' };
  if (wheel[a] === t) return 1.5;
  if (wheel[t] === a) return 0.5;
  return 1.0;
}

// mirror: getWeeklyBoss(userId)
async function getWeeklyBoss(ctx) {
  const sb = getSupabase();
  const { data: bosses } = await sb.from('weekly_boss').select('*').eq('status', 'active').order('started_at', { ascending: false }).limit(1);
  const boss = bosses && bosses[0];
  if (!boss) return { active: false };

  // top damagers
  const { data: logs } = await sb.from('weekly_boss_log')
    .select('user_id, damage, attacked_at').eq('boss_id', boss.boss_id);
  const damageMap = {};
  (logs || []).forEach(l => { damageMap[l.user_id] = (damageMap[l.user_id] || 0) + (l.damage || 0); });
  const topDamagers = Object.entries(damageMap).map(([uid, d]) => ({ userId: uid, damage: d }))
    .sort((a, b) => b.damage - a.damage).slice(0, 10);

  // ใส่ชื่อ
  if (topDamagers.length > 0) {
    const ids = topDamagers.map(t => t.userId);
    const { data: users } = await sb.from('users').select('user_id, name').in('user_id', ids);
    const nameMap = {};
    (users || []).forEach(u => { nameMap[u.user_id] = u.name; });
    topDamagers.forEach(t => { t.name = nameMap[t.userId] || 'Unknown'; });
  }

  // myDamage
  const uid = ctx.user && ctx.user.userId;
  const myDamage = uid ? (damageMap[uid] || 0) : 0;

  return {
    active: true,
    bossId: boss.boss_id, name: boss.name, emoji: boss.emoji, imageUrl: boss.image_url,
    bossElement: boss.boss_element, bossAtk: boss.boss_atk, bossReflect: boss.boss_reflect,
    maxHp: boss.max_hp, currentHp: boss.current_hp,
    rewardGold: boss.reward_gold, rewardSouls: boss.reward_souls,
    rewardMatBox: boss.reward_mat_box, rewardEquipBox: boss.reward_equip_box,
    startedAt: boss.started_at, endedAt: boss.ended_at,
    myDamage, topDamagers
  };
}

// mirror: attackWeeklyBoss(userId, petItemId, useActiveSkill)
async function attackWeeklyBoss(ctx, userId, petItemId, _useActiveSkill) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');

  const sb = getSupabase();
  const settings = await loadSettings(sb);
  const cooldownSec = Number(settings.boss_cooldown) || 60;

  const { data: bosses } = await sb.from('weekly_boss').select('*').eq('status', 'active').order('started_at', { ascending: false }).limit(1);
  const boss = bosses && bosses[0];
  if (!boss) return fail('ไม่มี boss ที่กำลัง active');
  if (boss.current_hp <= 0) return fail('Boss ตายไปแล้ว!');

  // cooldown check
  const { data: lastLog } = await sb.from('weekly_boss_log').select('attacked_at')
    .eq('boss_id', boss.boss_id).eq('user_id', uid)
    .order('attacked_at', { ascending: false }).limit(1).maybeSingle();
  if (lastLog) {
    const elapsed = (Date.now() - new Date(lastLog.attacked_at).getTime()) / 1000;
    if (elapsed < cooldownSec) return fail(`รอ cooldown อีก ${Math.ceil(cooldownSec - elapsed)} วินาที`);
  }

  // load attacker pet
  const ps = await getOrCreatePetStats(sb, uid);
  const { data: invItems } = await sb.from('inventory').select('item_id, category, item_key, element, pet_exp, enhance_level')
    .eq('user_id', uid).in('category', ['equipped','pets']);
  let attackerPet = null;
  if (petItemId) attackerPet = (invItems || []).find(i => i.item_id === petItemId);
  if (!attackerPet) attackerPet = pickEquippedPetRow(invItems, ps);
  if (!attackerPet) return fail('ไม่พบสัตว์เลี้ยงสำหรับโจมตี');

  // calc damage
  const petCalc = calculatePetLevelFromExp(attackerPet.pet_exp || 0);
  const petLevel = petCalc.petLevel;
  const enhance = Number(attackerPet.enhance_level) || 0;
  let bonus = calcEnhanceHpBonus(enhance);
  if (ps.pet_aura) bonus += (Number(settings.enhance_15_aura_atk_buff) || 5) / 100;
  if (ps.pet_title) bonus += (Number(settings.enhance_20_title_atk_buff) || 10) / 100;

  const baseAtk = 20 + petLevel * 5;
  const elemMult = elementMultiplier(attackerPet.element || ps.element || 'normal', boss.boss_element || 'fire');
  let damage = Math.floor(baseAtk * (1 + bonus) * elemMult * 5); // boost ×5 ให้สู้บอสรู้สึกเด่น

  // boss reflect → HP สัตว์ลด
  const reflect = Number(boss.boss_reflect) || 0;
  const reflectDmg = Math.floor(damage * reflect / 100);

  const newBossHp = Math.max(0, boss.current_hp - damage);

  // update boss
  await sb.from('weekly_boss').update({
    current_hp: newBossHp,
    status: newBossHp <= 0 ? 'ended' : 'active',
    ended_at: newBossHp <= 0 ? new Date().toISOString() : boss.ended_at
  }).eq('boss_id', boss.boss_id);

  // log
  await sb.from('weekly_boss_log').insert({
    boss_id: boss.boss_id, user_id: uid, damage, pet_item_id: attackerPet.item_id
  });

  // damage to attacker pet (HP loss แสดงผล)
  let messages = [`⚔️ โจมตี ${damage} DMG!`];
  if (elemMult > 1) messages.push(`(ธาตุได้เปรียบ ×${elemMult})`);
  if (elemMult < 1) messages.push(`(ธาตุเสียเปรียบ /2)`);
  if (reflectDmg > 0) messages.push(`🔥 Boss reflect ${reflectDmg} DMG กลับมา!`);

  // boss dead → distribute rewards
  if (newBossHp <= 0) {
    await _distributeBossRewards(sb, boss);
    messages.push(`💀 Boss ตายแล้ว! แจกรางวัลให้ทุกคนที่โจมตี`);
  }

  return ok({ message: messages.join(' '), damage, bossHp: newBossHp, bossDead: newBossHp <= 0, reflectDmg });
}

async function _distributeBossRewards(sb, boss) {
  const { data: logs } = await sb.from('weekly_boss_log').select('user_id, damage').eq('boss_id', boss.boss_id);
  const damageMap = {};
  (logs || []).forEach(l => { damageMap[l.user_id] = (damageMap[l.user_id] || 0) + (l.damage || 0); });
  const totalDamage = Object.values(damageMap).reduce((s, d) => s + d, 0);
  if (totalDamage <= 0) return;

  for (const [uid, dmg] of Object.entries(damageMap)) {
    const share = dmg / totalDamage;
    const gold = Math.floor((boss.reward_gold || 0) * share);
    const souls = Math.floor((boss.reward_souls || 0) * share);
    if (gold > 0 || souls > 0) {
      const ps = await getOrCreatePetStats(sb, uid);
      await sb.from('pet_stats').update({
        free_coins: (Number(ps.free_coins) || 0) + gold,
        souls: (Number(ps.souls) || 0) + souls,
        updated_at: new Date().toISOString()
      }).eq('user_id', uid);
      await sb.from('notifications').insert({
        user_id: uid, type: 'system',
        message: `🐉 Boss ตายแล้ว! ได้รับ ${gold} G + ${souls} 👻 (สัดส่วน ${(share*100).toFixed(1)}%)`
      });
    }
  }
}

// mirror: healBossPet(userId, petItemId)
async function healBossPet(ctx, userId, petItemId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  // simplified — not tracking pet HP separately for boss; just no-op success
  return ok({ message: 'สัตว์เลี้ยงถูกฟื้นฟู (boss HP ไม่กระทบ)' });
}

// =========== Admin ==============
async function getAdminBossList(ctx) {
  if (!ctx.user || ctx.user.role !== 'Admin') return [];
  const sb = getSupabase();
  const { data } = await sb.from('weekly_boss').select('*').order('started_at', { ascending: false, nullsFirst: false });
  return (data || []).map(b => ({
    id: b.boss_id, name: b.name, emoji: b.emoji, imageUrl: b.image_url,
    bossAtk: b.boss_atk, bossReflect: b.boss_reflect, bossElement: b.boss_element,
    maxHp: b.max_hp, currentHp: b.current_hp,
    day: b.day_of_week, time: b.start_time, duration: b.duration_min,
    rewardGold: b.reward_gold, rewardSouls: b.reward_souls,
    rewardMatBox: b.reward_mat_box, rewardEquipBox: b.reward_equip_box,
    status: b.status, startedAt: b.started_at, endedAt: b.ended_at
  }));
}

async function adminSetWeeklyBoss(ctx, data) {
  if (!ctx.user || ctx.user.role !== 'Admin') return fail('สิทธิ์ไม่เพียงพอ');
  if (!data || !data.name) return fail('ข้อมูลไม่ครบ');
  const sb = getSupabase();
  const { data: ins, error } = await sb.from('weekly_boss').insert({
    name: data.name, emoji: data.emoji || '🐲', image_url: data.imageUrl || '',
    boss_element: data.bossElement || 'fire',
    boss_atk: Number(data.bossAtk) || 500, boss_reflect: Number(data.bossReflect) || 10,
    max_hp: Number(data.maxHp) || 100000, current_hp: Number(data.maxHp) || 100000,
    day_of_week: data.day || '', start_time: data.time || '',
    duration_min: Number(data.duration) || 60,
    reward_gold: Number(data.rewardGold) || 5000, reward_souls: Number(data.rewardSouls) || 50,
    reward_mat_box: Number(data.rewardMatBox) || 1, reward_equip_box: Number(data.rewardEquipBox) || 0,
    status: 'pending'
  }).select('boss_id').single();
  if (error) return fail(error.message);
  return ok({ message: 'สร้าง Boss สำเร็จ', bossId: ins.boss_id });
}

async function adminStartBoss(ctx, bossId) {
  if (!ctx.user || ctx.user.role !== 'Admin') return fail('สิทธิ์ไม่เพียงพอ');
  const sb = getSupabase();
  // ปิด active boss เดิมก่อน
  await sb.from('weekly_boss').update({ status: 'ended', ended_at: new Date().toISOString() }).eq('status', 'active');
  // เริ่ม boss นี้
  const { data: b } = await sb.from('weekly_boss').select('max_hp').eq('boss_id', bossId).maybeSingle();
  if (!b) return fail('ไม่พบ boss');
  await sb.from('weekly_boss').update({
    status: 'active', current_hp: b.max_hp, started_at: new Date().toISOString(), ended_at: null
  }).eq('boss_id', bossId);
  return ok({ message: 'เริ่ม Boss แล้ว!' });
}

async function adminEndBoss(ctx, bossId) {
  if (!ctx.user || ctx.user.role !== 'Admin') return fail('สิทธิ์ไม่เพียงพอ');
  const sb = getSupabase();
  await sb.from('weekly_boss').update({ status: 'ended', ended_at: new Date().toISOString() }).eq('boss_id', bossId);
  return ok({ message: 'จบ Boss แล้ว' });
}

module.exports = {
  getWeeklyBoss, attackWeeklyBoss, healBossPet,
  getAdminBossList, adminSetWeeklyBoss, adminStartBoss, adminEndBoss
};
