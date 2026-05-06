// ============================================================
// Guild War (Phase 2E) — สงครามกิลด์
// ============================================================
const { getSupabase } = require('../_lib/supabase');
const { ok, fail } = require('../_lib/util');
const { calculatePetLevelFromExp, calcEnhanceHpBonus, calculateMaxHp } = require('../_lib/pet');

const ATTACK_CD_MS = 30 * 1000;        // 30 วินาที CD ต่อการโจมตี

async function loadSettings(sb) {
  const { data } = await sb.from('settings').select('key,value');
  const m = {}; (data || []).forEach(r => { m[r.key] = r.value; });
  return m;
}

function todayISO() { return new Date().toISOString(); }
function nowMs() { return Date.now(); }

// ============================================================
// ADMIN: createGuildWar(config)
// ============================================================
async function createGuildWar(ctx, config) {
  if (!ctx.user || ctx.user.role !== 'Admin') return fail('สิทธิ์ไม่เพียงพอ');
  if (!config) return fail('ข้อมูลไม่ครบ');
  const sb = getSupabase();

  // create war
  const { data: war, error } = await sb.from('guild_wars').insert({
    name: config.name || 'สงครามกิลด์',
    start_at: config.startAt || null,
    duration_min: Number(config.duration) || 60,
    reward_gold: Number(config.rewardGold) || 5000,
    reward_souls: Number(config.rewardSouls) || 50,
    reward_gp_win: Number(config.rewardGPWin) || 100,
    reward_gp_lose: Number(config.rewardGPLose) || 30,
    fortress_max_hp: Number(config.fortressMaxHp) || 20000
  }).select('*').single();
  if (error) return fail(error.message);

  // auto-create fortress for every existing guild
  const { data: guilds } = await sb.from('guilds').select('guild_id');
  if (guilds && guilds.length > 0) {
    const rows = guilds.map(g => ({
      war_id: war.war_id, guild_id: g.guild_id,
      fortress_hp: war.fortress_max_hp, max_hp: war.fortress_max_hp
    }));
    await sb.from('guild_war_fortresses').insert(rows);
  }

  return ok({ message: '⚔️ สร้างสงครามกิลด์สำเร็จ!', warId: war.war_id });
}

async function cancelGuildWar(ctx, warId) {
  if (!ctx.user || ctx.user.role !== 'Admin') return fail('สิทธิ์ไม่เพียงพอ');
  const sb = getSupabase();
  const { error } = await sb.from('guild_wars').update({ status: 'cancelled', ended_at: todayISO() }).eq('war_id', warId);
  if (error) return fail(error.message);
  return ok({ message: 'ยกเลิกสงครามแล้ว' });
}

async function startGuildWar(ctx, warId) {
  if (!ctx.user || ctx.user.role !== 'Admin') return fail('สิทธิ์ไม่เพียงพอ');
  const sb = getSupabase();
  // ปิด war active เดิมก่อน
  await sb.from('guild_wars').update({ status: 'ended', ended_at: todayISO() }).eq('status', 'active');
  const { error } = await sb.from('guild_wars').update({
    status: 'active', start_at: todayISO()
  }).eq('war_id', warId);
  if (error) return fail(error.message);
  return ok({ message: '⚔️ เริ่มสงครามแล้ว!' });
}

async function endGuildWar(ctx, warId) {
  if (!ctx.user || ctx.user.role !== 'Admin') return fail('สิทธิ์ไม่เพียงพอ');
  const sb = getSupabase();

  const { data: war } = await sb.from('guild_wars').select('*').eq('war_id', warId).maybeSingle();
  if (!war) return fail('ไม่พบสงคราม');
  if (war.status === 'ended') return fail('สงครามจบไปแล้ว');

  // หา winner = กิลด์ที่ป้อมเหลือ HP มากที่สุด (ถ้าเสมอ → ที่สมาชิก damage รวมสูงสุด)
  const { data: forts } = await sb.from('guild_war_fortresses').select('*').eq('war_id', warId);
  let winnerId = null;
  if (forts && forts.length > 0) {
    forts.sort((a, b) => (b.fortress_hp || 0) - (a.fortress_hp || 0));
    winnerId = forts[0].guild_id;
  }

  await sb.from('guild_wars').update({
    status: 'ended', ended_at: todayISO(), winner_guild_id: winnerId
  }).eq('war_id', warId);

  // distribute rewards
  await _distributeRewards(sb, war, winnerId);

  return ok({ message: '🏆 จบสงครามแล้ว!', winnerGuildId: winnerId });
}

async function _distributeRewards(sb, war, winnerId) {
  const { data: parts } = await sb.from('guild_war_participants').select('*').eq('war_id', war.war_id);
  for (const p of parts || []) {
    const isWin = p.guild_id === winnerId;
    const gold = isWin ? Number(war.reward_gold) || 0 : Math.floor((Number(war.reward_gold) || 0) / 4);
    const souls = isWin ? Number(war.reward_souls) || 0 : Math.floor((Number(war.reward_souls) || 0) / 4);
    const gp = isWin ? Number(war.reward_gp_win) || 100 : Number(war.reward_gp_lose) || 30;
    if (gold > 0 || souls > 0) {
      const { data: ps } = await sb.from('pet_stats').select('free_coins, souls').eq('user_id', p.user_id).maybeSingle();
      if (ps) {
        await sb.from('pet_stats').update({
          free_coins: (Number(ps.free_coins) || 0) + gold,
          souls: (Number(ps.souls) || 0) + souls,
          updated_at: new Date().toISOString()
        }).eq('user_id', p.user_id);
      }
    }
    if (gp > 0 && p.guild_id) {
      const { data: m } = await sb.from('guild_members').select('guild_points').eq('user_id', p.user_id).eq('guild_id', p.guild_id).maybeSingle();
      if (m) {
        await sb.from('guild_members').update({
          guild_points: (Number(m.guild_points) || 0) + gp
        }).eq('user_id', p.user_id).eq('guild_id', p.guild_id);
      }
    }
    await sb.from('notifications').insert({
      user_id: p.user_id, type: 'system',
      message: isWin
        ? `🏆 กิลด์ของคุณ <b>ชนะสงคราม!</b> ได้รับ ${gold} G + ${souls} 👻 + ${gp} GP`
        : `⚔️ สงครามจบแล้ว ได้รับ ${gold} G + ${souls} 👻 + ${gp} GP`
    });
  }
}

// ============================================================
// READ: list / status / battlefield
// ============================================================
async function getGuildWarList(ctx) {
  if (!ctx.user || ctx.user.role !== 'Admin') return [];
  const sb = getSupabase();
  const { data } = await sb.from('guild_wars').select('*').order('created_at', { ascending: false });
  return (data || []).map(w => ({
    warId: w.war_id, name: w.name, startAt: w.start_at, duration: w.duration_min,
    status: w.status, rewardGold: w.reward_gold, rewardSouls: w.reward_souls,
    rewardGPWin: w.reward_gp_win, rewardGPLose: w.reward_gp_lose,
    fortressMaxHp: w.fortress_max_hp,
    winnerGuildId: w.winner_guild_id, createdAt: w.created_at, endedAt: w.ended_at
  }));
}

async function getGuildWarStatus() {
  const sb = getSupabase();
  const { data } = await sb.from('guild_wars').select('*')
    .in('status', ['active','scheduled']).order('created_at', { ascending: false }).limit(1);
  const war = data && data[0];
  if (!war) return { active: false, scheduled: false };

  const startMs = war.start_at ? new Date(war.start_at).getTime() : 0;
  const endMs = startMs + ((Number(war.duration_min) || 60) * 60 * 1000);
  const now = Date.now();
  return {
    active: war.status === 'active',
    scheduled: war.status === 'scheduled',
    warId: war.war_id, name: war.name, status: war.status,
    startAt: war.start_at, startTime: startMs, endTime: endMs,
    durationMin: war.duration_min,
    rewardGold: war.reward_gold, rewardSouls: war.reward_souls,
    fortressMaxHp: war.fortress_max_hp,
    timeRemainingMs: Math.max(0, endMs - now)
  };
}

async function checkWarParticipant(ctx, userId) {
  const uid = userId || (ctx.user && ctx.user.userId);
  if (!uid) return { isParticipant: false };
  const sb = getSupabase();
  const status = await getGuildWarStatus();
  if (!status.active) return { isParticipant: false, warId: null };
  const { data: p } = await sb.from('guild_war_participants').select('*').eq('war_id', status.warId).eq('user_id', uid).maybeSingle();
  return { isParticipant: !!p, warId: status.warId, participant: p ? {
    petIds: p.pet_ids || [], activePet: p.active_pet,
    damageDealt: p.damage_dealt, lastAttackCd: p.last_attack_cd
  } : null };
}

// ============================================================
// USER: joinGuildWar(petId1, petId2, petId3)
// ============================================================
async function joinGuildWar(ctx, userId, pet1, pet2, pet3) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');

  const sb = getSupabase();
  const status = await getGuildWarStatus();
  if (!status.active && !status.scheduled) return fail('ไม่มีสงครามตอนนี้');

  // ต้องอยู่ในกิลด์
  const { data: m } = await sb.from('guild_members').select('guild_id, role').eq('user_id', uid).neq('role', 'pending').maybeSingle();
  if (!m) return fail('ต้องอยู่ในกิลด์ก่อนถึงจะเข้าร่วมสงครามได้');

  // ตรวจ pets ที่เลือก
  const petIds = [pet1, pet2, pet3].filter(Boolean);
  if (petIds.length < 1) return fail('กรุณาเลือกอย่างน้อย 1 ตัว');

  const { data: pets } = await sb.from('inventory').select('item_id, category, item_key, is_locked')
    .eq('user_id', uid).in('item_id', petIds);
  const petMap = {};
  (pets || []).forEach(p => { petMap[p.item_id] = p; });
  for (const id of petIds) {
    if (!petMap[id]) return fail('ไม่พบสัตว์เลี้ยงในกระเป๋า: ' + id);
    if (petMap[id].category !== 'pets' && petMap[id].category !== 'equipped') return fail('ต้องเป็นสัตว์เลี้ยงเท่านั้น');
    if (petMap[id].is_locked) return fail('สัตว์เลี้ยงถูกล็อค (ตลาด/ฟาร์ม) ไม่สามารถใช้ในสงครามได้');
  }

  // ล็อค pets ระหว่างสงคราม
  await sb.from('inventory').update({ is_locked: true, locked_reason: 'guild_war' }).in('item_id', petIds);

  // upsert participant
  const { error } = await sb.from('guild_war_participants').upsert({
    war_id: status.warId, user_id: uid, guild_id: m.guild_id,
    pet_ids: petIds, active_pet: petIds[0],
    damage_dealt: 0, last_attack_cd: 0
  }, { onConflict: 'war_id,user_id' });
  if (error) return fail(error.message);

  return ok({ message: '✅ เข้าร่วมสงครามเรียบร้อย!', petIds, activePet: petIds[0] });
}

// ============================================================
// USER: placeDefender(slotIndex, petId)
// ============================================================
async function placeDefender(ctx, userId, slotIndex, petId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  const slot = Number(slotIndex);
  if (![1, 2, 3].includes(slot)) return fail('slot ต้อง 1-3');

  const sb = getSupabase();
  const status = await getGuildWarStatus();
  if (!status.active) return fail('สงครามยังไม่เริ่ม');

  const { data: m } = await sb.from('guild_members').select('guild_id').eq('user_id', uid).neq('role', 'pending').maybeSingle();
  if (!m) return fail('ต้องอยู่ในกิลด์');

  const { data: pet } = await sb.from('inventory').select('item_id, item_key, pet_exp, enhance_level').eq('item_id', petId).eq('user_id', uid).maybeSingle();
  if (!pet) return fail('ไม่พบสัตว์เลี้ยงนี้');

  const petLevel = calculatePetLevelFromExp(Number(pet.pet_exp) || 0).petLevel;
  const enhBonus = calcEnhanceHpBonus(Number(pet.enhance_level) || 0);
  const maxHp = Math.floor(calculateMaxHp(petLevel) * (1 + enhBonus));

  const { error } = await sb.from('guild_war_defenders').upsert({
    war_id: status.warId, guild_id: m.guild_id, slot,
    user_id: uid, pet_item_id: petId,
    current_hp: maxHp, max_hp: maxHp, cd_until: 0
  }, { onConflict: 'war_id,guild_id,slot' });
  if (error) return fail(error.message);

  await sb.from('guild_war_log').insert({
    war_id: status.warId, attacker_id: uid,
    attacker_name: ctx.user.name || '', attacker_guild: m.guild_id,
    target_guild: m.guild_id, action: 'place_defender',
    target_slot: slot, details: pet.item_key
  });

  return ok({ message: `🛡️ วางสัตว์ป้องกันใน slot ${slot} แล้ว`, slot, maxHp });
}

// ============================================================
// USER: attackDefender(targetGuildId, slot)
// ============================================================
async function attackDefender(ctx, userId, targetGuildId, slot) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');

  const sb = getSupabase();
  const status = await getGuildWarStatus();
  if (!status.active) return fail('สงครามยังไม่เริ่ม');

  const { data: p } = await sb.from('guild_war_participants').select('*').eq('war_id', status.warId).eq('user_id', uid).maybeSingle();
  if (!p) return fail('คุณยังไม่ได้เข้าร่วมสงคราม');
  if (p.guild_id === targetGuildId) return fail('โจมตีกิลด์ตัวเองไม่ได้');

  const now = nowMs();
  if (Number(p.last_attack_cd) > now) {
    const remain = Math.ceil((p.last_attack_cd - now) / 1000);
    return fail(`รอ cooldown อีก ${remain} วินาที`);
  }

  // ดึงข้อมูล active pet ของ attacker
  const activeId = p.active_pet || (p.pet_ids && p.pet_ids[0]);
  if (!activeId) return fail('ไม่มี active pet');
  const { data: aPet } = await sb.from('inventory').select('*').eq('item_id', activeId).maybeSingle();
  if (!aPet) return fail('ไม่พบ pet');
  const aLevel = calculatePetLevelFromExp(Number(aPet.pet_exp) || 0).petLevel;
  const aEnh = calcEnhanceHpBonus(Number(aPet.enhance_level) || 0);
  const baseAtk = 20 + aLevel * 5;
  const damage = Math.floor(baseAtk * (1 + aEnh) * 3); // ×3 ให้ feel เด่น

  // ดึง defender
  const { data: def } = await sb.from('guild_war_defenders')
    .select('*').eq('war_id', status.warId).eq('guild_id', targetGuildId).eq('slot', Number(slot)).maybeSingle();
  if (!def || !def.pet_item_id) return fail('ไม่มี defender ใน slot นี้');
  if (Number(def.cd_until) > now) {
    const remain = Math.ceil((def.cd_until - now) / 1000);
    return fail(`Defender slot นี้ kill แล้ว รอเกิดใหม่อีก ${remain} วินาที`);
  }

  const newHp = (def.current_hp || 0) - damage;
  let killed = false;
  let cdUntil = 0;
  if (newHp <= 0) {
    killed = true;
    cdUntil = now + 60 * 1000; // 1 นาที CD
  }

  await sb.from('guild_war_defenders').update({
    current_hp: Math.max(0, newHp),
    cd_until: cdUntil
  }).eq('war_id', status.warId).eq('guild_id', targetGuildId).eq('slot', Number(slot));

  await sb.from('guild_war_participants').update({
    damage_dealt: (Number(p.damage_dealt) || 0) + damage,
    last_attack_cd: now + ATTACK_CD_MS
  }).eq('war_id', status.warId).eq('user_id', uid);

  await sb.from('guild_war_log').insert({
    war_id: status.warId, attacker_id: uid,
    attacker_name: ctx.user.name || '', attacker_guild: p.guild_id,
    target_guild: targetGuildId, action: 'attack_defender',
    damage, target_slot: Number(slot),
    details: killed ? `💀 KO defender! (60s CD)` : ''
  });

  return ok({ message: `⚔️ โจมตี defender ${damage} DMG${killed ? ' 💀 KO!' : ''}`, damage, killed, defenderHp: Math.max(0, newHp) });
}

// ============================================================
// USER: attackFortress(targetGuildId)
// ============================================================
async function attackFortress(ctx, userId, targetGuildId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');

  const sb = getSupabase();
  const status = await getGuildWarStatus();
  if (!status.active) return fail('สงครามยังไม่เริ่ม');

  const { data: p } = await sb.from('guild_war_participants').select('*').eq('war_id', status.warId).eq('user_id', uid).maybeSingle();
  if (!p) return fail('คุณยังไม่ได้เข้าร่วมสงคราม');
  if (p.guild_id === targetGuildId) return fail('โจมตีกิลด์ตัวเองไม่ได้');

  const now = nowMs();
  if (Number(p.last_attack_cd) > now) {
    const remain = Math.ceil((p.last_attack_cd - now) / 1000);
    return fail(`รอ cooldown อีก ${remain} วินาที`);
  }

  // ตรวจว่าศัตรูยังมี defender ที่ live อยู่หรือเปล่า — ถ้ามี → ตี fortress ไม่ได้
  const { data: defs } = await sb.from('guild_war_defenders').select('current_hp')
    .eq('war_id', status.warId).eq('guild_id', targetGuildId).gt('current_hp', 0);
  if (defs && defs.length > 0) {
    return fail(`ต้องเคลียร์ defender ทั้ง ${defs.length} ตัวก่อน ถึงจะตีป้อมได้!`);
  }

  // calc damage
  const activeId = p.active_pet || (p.pet_ids && p.pet_ids[0]);
  let damage = 200;
  if (activeId) {
    const { data: aPet } = await sb.from('inventory').select('pet_exp, enhance_level').eq('item_id', activeId).maybeSingle();
    if (aPet) {
      const lvl = calculatePetLevelFromExp(Number(aPet.pet_exp) || 0).petLevel;
      const enh = calcEnhanceHpBonus(Number(aPet.enhance_level) || 0);
      damage = Math.floor((20 + lvl * 5) * (1 + enh) * 3);
    }
  }

  // ป้อม
  const { data: fort } = await sb.from('guild_war_fortresses')
    .select('*').eq('war_id', status.warId).eq('guild_id', targetGuildId).maybeSingle();
  if (!fort) return fail('ไม่พบป้อมเป้าหมาย');
  const newHp = Math.max(0, (fort.fortress_hp || 0) - damage);

  await sb.from('guild_war_fortresses').update({ fortress_hp: newHp })
    .eq('war_id', status.warId).eq('guild_id', targetGuildId);

  await sb.from('guild_war_participants').update({
    damage_dealt: (Number(p.damage_dealt) || 0) + damage,
    last_attack_cd: now + ATTACK_CD_MS
  }).eq('war_id', status.warId).eq('user_id', uid);

  await sb.from('guild_war_log').insert({
    war_id: status.warId, attacker_id: uid,
    attacker_name: ctx.user.name || '', attacker_guild: p.guild_id,
    target_guild: targetGuildId, action: 'attack_fortress', damage,
    details: newHp <= 0 ? '💥 ป้อมถูกตีแตก!' : ''
  });

  return ok({ message: `💥 ตีป้อม ${damage} DMG${newHp === 0 ? ' — ป้อมแตก!' : ''}`, damage, fortressHp: newHp, fortressDestroyed: newHp === 0 });
}

// ============================================================
// READ: getWarBattlefield(userId) — full state
// ============================================================
async function getWarBattlefield(ctx, userId) {
  const uid = userId || (ctx.user && ctx.user.userId);
  const status = await getGuildWarStatus();
  if (!status.active) return { active: false };

  const sb = getSupabase();
  const [fortRes, defRes, partRes, logRes, guildRes] = await Promise.all([
    sb.from('guild_war_fortresses').select('*').eq('war_id', status.warId),
    sb.from('guild_war_defenders').select('*').eq('war_id', status.warId),
    sb.from('guild_war_participants').select('*').eq('war_id', status.warId),
    sb.from('guild_war_log').select('*').eq('war_id', status.warId).order('timestamp', { ascending: false }).limit(30),
    sb.from('guilds').select('guild_id, name')
  ]);

  const guildMap = {};
  (guildRes.data || []).forEach(g => { guildMap[g.guild_id] = g.name; });

  const defByGuild = {};
  (defRes.data || []).forEach(d => {
    if (!defByGuild[d.guild_id]) defByGuild[d.guild_id] = [];
    defByGuild[d.guild_id].push({
      slot: d.slot, userId: d.user_id, petItemId: d.pet_item_id,
      currentHp: d.current_hp, maxHp: d.max_hp, cdUntil: Number(d.cd_until) || 0
    });
  });

  const fortresses = (fortRes.data || []).map(f => ({
    guildId: f.guild_id, name: guildMap[f.guild_id] || '?',
    fortressHp: f.fortress_hp, maxHp: f.max_hp,
    defenders: (defByGuild[f.guild_id] || []).sort((a, b) => a.slot - b.slot)
  })).sort((a, b) => b.fortressHp - a.fortressHp);

  // damage leaderboard
  const damageMap = {};
  (partRes.data || []).forEach(p => {
    damageMap[p.user_id] = (Number(p.damage_dealt) || 0);
  });
  const me = uid ? (partRes.data || []).find(p => p.user_id === uid) : null;

  // logs with names
  const logs = (logRes.data || []).map(l => ({
    logId: l.log_id, attackerId: l.attacker_id, attackerName: l.attacker_name,
    attackerGuild: guildMap[l.attacker_guild] || l.attacker_guild,
    targetGuild: guildMap[l.target_guild] || l.target_guild,
    action: l.action, damage: l.damage, targetSlot: l.target_slot,
    details: l.details, timestamp: l.timestamp
  }));

  return {
    active: true, warId: status.warId, name: status.name,
    timeRemainingMs: status.timeRemainingMs,
    fortresses, logs,
    me: me ? {
      petIds: me.pet_ids || [], activePet: me.active_pet,
      damageDealt: me.damage_dealt, lastAttackCd: Number(me.last_attack_cd) || 0,
      guildId: me.guild_id
    } : null,
    damageLeaderboard: Object.entries(damageMap)
      .map(([id, d]) => ({ userId: id, damage: d }))
      .sort((a, b) => b.damage - a.damage).slice(0, 20)
  };
}

// lite version — สำหรับ polling (เฉพาะ HP/log changes)
async function getWarBattlefieldLite(ctx, userId, lastLogCount) {
  const status = await getGuildWarStatus();
  if (!status.active) return { active: false };

  const sb = getSupabase();
  const [fortRes, logRes] = await Promise.all([
    sb.from('guild_war_fortresses').select('guild_id, fortress_hp, max_hp').eq('war_id', status.warId),
    sb.from('guild_war_log').select('log_id, attacker_name, action, damage, target_guild, timestamp')
      .eq('war_id', status.warId).order('timestamp', { ascending: false }).limit(50)
  ]);

  return {
    active: true, warId: status.warId,
    timeRemainingMs: status.timeRemainingMs,
    fortresses: (fortRes.data || []).map(f => ({ guildId: f.guild_id, fortressHp: f.fortress_hp, maxHp: f.max_hp })),
    logs: (logRes.data || []).map(l => ({
      logId: l.log_id, attackerName: l.attacker_name, action: l.action,
      damage: l.damage, targetGuild: l.target_guild, timestamp: l.timestamp
    })),
    logCount: (logRes.data || []).length
  };
}

// useWarItem — Phase 2E เริ่มต้นยังไม่ implement (return success message)
async function useWarItem(ctx, userId, itemId, _targetGuildId) {
  return fail('ระบบไอเทมสงครามยังไม่เปิด (จะมาในเฟสถัดไป)');
}

module.exports = {
  // admin
  createGuildWar, cancelGuildWar, startGuildWar, endGuildWar, getGuildWarList,
  // public/user
  getGuildWarStatus, checkWarParticipant,
  joinGuildWar, placeDefender, attackDefender, attackFortress, useWarItem,
  getWarBattlefield, getWarBattlefieldLite
};
