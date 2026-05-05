// ============================================================
// PvP — apply battle damage (simplified Phase 2B+)
// ตัด skills/equipment/guild/material drop ออก จะเติมใน Phase 2C/2D
// ============================================================
const { getSupabase } = require('../_lib/supabase');
const { ok, fail } = require('../_lib/util');
const {
  calculateLevelAndExp, calculateMaxHp, calcUserBaseFromSubmissions,
  calculatePetLevelFromExp, calcEnhanceHpBonus
} = require('../_lib/pet');
const { hasBuff, addBuff, removeBuff, getPvpCount, setPvpCount } = require('../_lib/buff');
const { loadAllSkillDefs, calcPassiveCombatStats, getPassiveValue } = require('../_lib/skills');
const { _getEquipmentBonusForUser } = require('./equipment');
const { pickEquippedPetRow, ensureEquippedRow } = require('../_lib/equippedPet');

async function loadSettings(sb) {
  const { data } = await sb.from('settings').select('key,value');
  const m = {};
  (data || []).forEach(r => { m[r.key] = r.value; });
  return m;
}

function todayDate() { return new Date().toISOString().substring(0, 10); }

async function getOrCreatePetStats(sb, userId) {
  let { data: ps } = await sb.from('pet_stats').select('*').eq('user_id', userId).maybeSingle();
  if (!ps) {
    const { data: created } = await sb.from('pet_stats').insert({ user_id: userId }).select('*').single();
    ps = created;
  }
  return ps;
}

async function getPetRarity(sb, petType) {
  const { data } = await sb.from('pet_config').select('rarity').eq('pet_type', petType).maybeSingle();
  return data ? (data.rarity || 'C') : 'C';
}

function baseAtkFromRarity(rarity) {
  if (rarity === 'UR') return 50;
  if (rarity === 'SSR') return 40;
  if (rarity === 'SR') return 30;
  if (rarity === 'R') return 25;
  return 20;
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

// load player snapshot — รวม pet_stats + base exp + equipped pet level + skills + equipment
async function loadPlayer(sb, userId, skillDefs) {
  const ps = await getOrCreatePetStats(sb, userId);
  const { data: subs } = await sb.from('submissions').select('score').eq('student_id', userId);
  const base = calcUserBaseFromSubmissions(subs || []);

  const { data: invItems } = await sb.from('inventory').select('item_id, category, pet_exp, pet_level, item_key, element, enhance_level')
    .eq('user_id', userId).in('category', ['equipped','pets']);
  let petLevel = 1, equippedItemId = null;
  const eq = pickEquippedPetRow(invItems, ps);
  if (eq) {
    const calc = calculatePetLevelFromExp(eq.pet_exp || 0);
    petLevel = calc.petLevel;
    equippedItemId = eq.item_id;
  }
  const playerLevel = calculateLevelAndExp(base.exp + (Number(ps.exp_offset) || 0)).level;

  // skills ของ equipped pet
  let equippedSkills = [];
  if (equippedItemId) {
    const { data: ls } = await sb.from('pet_learned_skills').select('skill_id').eq('pet_item_id', equippedItemId);
    const ids = (ls || []).map(r => r.skill_id);
    equippedSkills = (skillDefs || []).filter(s => ids.includes(s.id));
  }

  // equipment bonus
  const equipBonus = await _getEquipmentBonusForUser(sb, userId);

  return { ps, base, petLevel, playerLevel, equippedItemId, equippedSkills, equipBonus };
}

// reset daily counters ถ้าวันเปลี่ยน
function rollDailyState(ps) {
  const today = todayDate();
  const lastAtk = ps.last_attacked_date ? String(ps.last_attacked_date).substring(0,10) : '';
  const lastBattle = ps.last_battle_date ? String(ps.last_battle_date).substring(0,10) : '';
  const lostToday = lastAtk === today ? Number(ps.levels_lost_today) || 0 : 0;
  const bCount = lastBattle === today ? Number(ps.battle_count_today) || 0 : 0;
  let dailyBattles = lastBattle === today ? (Array.isArray(ps.daily_battles) ? ps.daily_battles : []) : [];
  let dailyItems = lastBattle === today ? (ps.daily_items && typeof ps.daily_items === 'object' ? { ...ps.daily_items } : {}) : {};
  return { lostToday, bCount, dailyBattles, dailyItems };
}

// คำนวณ HP max รวม skill+equipment bonus
function calcHpStat(ps, settings, petLevel, skillStats, equipBonus) {
  let bonus = calcEnhanceHpBonus(Number(ps.enhance_level) || 0);
  if (ps.pet_aura) bonus += (Number(settings.enhance_15_aura_hp_buff) || 5) / 100;
  if (ps.pet_title) bonus += (Number(settings.enhance_20_title_hp_buff) || 10) / 100;
  bonus += (skillStats.hpBoostPct || 0) / 100;
  return Math.floor(calculateMaxHp(petLevel) * (1 + bonus)) + (equipBonus.hp || 0);
}

async function calcAtkStat(sb, ps, settings, petLevel, _playerLevel, skillStats, equipBonus) {
  let bonus = calcEnhanceHpBonus(Number(ps.enhance_level) || 0);
  if (ps.pet_aura) bonus += (Number(settings.enhance_15_aura_atk_buff) || 5) / 100;
  if (ps.pet_title) bonus += (Number(settings.enhance_20_title_atk_buff) || 10) / 100;
  bonus += (skillStats.atkBoostPct || 0) / 100;
  const rarity = await getPetRarity(sb, ps.pet_type || 'dog');
  const baseAtk = baseAtkFromRarity(rarity) + petLevel * 5;
  return Math.floor(baseAtk * (1 + bonus)) + (equipBonus.atk || 0);
}

async function notify(sb, userId, type, message) {
  try { await sb.from('notifications').insert({ user_id: userId, type, message }); } catch {}
}

// ============================================================
// applyBattleDamage(targetId, baseDamage, attackerId, battleResult, useActiveSkill)
// battleResult: 'win' | 'lose' | 'draw' | 'auto_win'
// ============================================================
async function applyBattleDamage(ctx, targetId, baseDamage, attackerId, battleResult, _useActiveSkill) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const aid = attackerId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && aid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  if (!targetId || aid === targetId) return fail('เป้าหมายไม่ถูกต้อง');

  const sb = getSupabase();
  const settings = await loadSettings(sb);
  const nowMs = Date.now();
  const today = todayDate();
  const skillDefs = await loadAllSkillDefs(sb);

  // auto-promote pet ที่ตรงกับ pet_stats.pet_type → category='equipped' (ครั้งเดียวต่อ user)
  await ensureEquippedRow(sb, aid);
  await ensureEquippedRow(sb, targetId);

  // load both (with skills + equipment)
  const A = await loadPlayer(sb, aid, skillDefs);
  const T = await loadPlayer(sb, targetId, skillDefs);

  // mutable state
  let aActive = A.ps.active_buff || '';
  let aOffset = Number(A.ps.exp_offset) || 0;
  let aFreeCoins = Number(A.ps.free_coins) || 0;
  let aHp = Number(A.ps.current_hp) || 0;
  let aShield = Number(A.ps.shield_expiry) || 0;
  const aDaily = rollDailyState(A.ps);

  let tActive = T.ps.active_buff || '';
  let tOffset = Number(T.ps.exp_offset) || 0;
  let tHp = Number(T.ps.current_hp) || 0;
  let tShield = Number(T.ps.shield_expiry) || 0;
  const tDaily = rollDailyState(T.ps);

  // หัก PvP item counters
  if (battleResult === 'auto_win') {
    const c = getPvpCount(aActive, 'auto_win');
    if (c > 0) aActive = setPvpCount(aActive, 'auto_win', c - 1);
  }
  const isRematch = aDaily.dailyBattles.includes(targetId);
  if (isRematch) {
    const c = getPvpCount(aActive, 'rematch_ticket');
    if (c > 0) aActive = setPvpCount(aActive, 'rematch_ticket', c - 1);
  }

  // เพิ่ม battle count + บันทึกเป้าหมายในวันนี้
  aDaily.bCount += 1;
  if (!aDaily.dailyBattles.includes(targetId)) aDaily.dailyBattles.push(targetId);
  if (aDaily.bCount > 3) {
    const c = getPvpCount(aActive, 'extra_battle');
    if (c > 0) aActive = setPvpCount(aActive, 'extra_battle', c - 1);
  }

  // calc stats (skills + equipment integrated)
  const aSkillStats = calcPassiveCombatStats(A.equippedSkills, aDaily.bCount);
  const tSkillStats = calcPassiveCombatStats(T.equippedSkills, tDaily.bCount);

  // ===== ACTIVE SKILLS — apply เฉพาะตอนชนะ + user เลือกใช้ =====
  let dmgMult = 1;
  let isThunderBolt = false;
  let attackerATKBoost = 0; // % เพิ่ม ATK
  let counterATKDebuff = 0; // % ลด ATK ฝ่ายตรงข้าม
  let iceShieldReduction = 0; // % ลด counter dmg
  let activeReflect100 = false;
  let activeHealPct = 0;
  let activeRevivePct = 0;
  let activeSkillMsg = '';
  if (_useActiveSkill) {
    const activeSkills = (A.equippedSkills || []).filter(s => s.type === 'active');
    for (const sk of activeSkills) {
      // cooldown check
      if (sk.cooldown > 0 && (aDaily.bCount % sk.cooldown !== 0)) continue;
      if (sk.effect === 'fireStrike')  { dmgMult = sk.value / 100; activeSkillMsg += `🔥 ${sk.name} ดาเมจ ×${dmgMult}! `; }
      else if (sk.effect === 'thunderBolt') { isThunderBolt = true; dmgMult = sk.value / 100; activeSkillMsg += `⚡ ${sk.name} ทะลุเกราะ ×${dmgMult}! `; }
      else if (sk.effect === 'atkBoost' && sk.type === 'active') { attackerATKBoost += sk.value; activeSkillMsg += `⚔️ ${sk.name} ATK +${sk.value}%! `; }
      else if (sk.effect === 'debuff') { counterATKDebuff += sk.value; activeSkillMsg += `☠️ ${sk.name} ลด ATK ศัตรู ${sk.value}%! `; }
      else if (sk.effect === 'iceShield') { iceShieldReduction = sk.value / 100; activeSkillMsg += `🧊 ${sk.name} ลดดาเมจโต้ ${sk.value}%! `; }
      else if (sk.effect === 'reflect') { activeReflect100 = true; activeSkillMsg += `🪞 ${sk.name} สะท้อน ${sk.value}%! `; }
      else if (sk.effect === 'heal') { activeHealPct += sk.value; activeSkillMsg += `💚 ${sk.name} ฟื้น ${sk.value}% HP! `; }
      else if (sk.effect === 'revive') { activeRevivePct = sk.value; }
    }
  }

  const aMaxHp = calcHpStat(A.ps, settings, A.petLevel, aSkillStats, A.equipBonus);
  const tMaxHp = calcHpStat(T.ps, settings, T.petLevel, tSkillStats, T.equipBonus);
  if (aHp <= 0 || aHp > aMaxHp) aHp = aMaxHp;
  if (tHp <= 0 || tHp > tMaxHp) tHp = tMaxHp;

  let attackerATK = await calcAtkStat(sb, A.ps, settings, A.petLevel, A.playerLevel, aSkillStats, A.equipBonus);
  let counterATK = await calcAtkStat(sb, T.ps, settings, T.petLevel, T.playerLevel, tSkillStats, T.equipBonus);
  attackerATK += A.playerLevel * 10;
  counterATK += T.playerLevel * 10;

  // ลด damage จาก DEF (skill + equipment) — สูตร RPG: dmg × (1 - def/(def+100))
  const aDef = (aSkillStats.def || 0) + (A.equipBonus.def || 0);
  const tDef = (tSkillStats.def || 0) + (T.equipBonus.def || 0) - (A.equipBonus.armorPen || 0);
  const aDefReduction = Math.max(0, aDef) / (Math.max(0, aDef) + 100);
  const tDefReduction = Math.max(0, tDef) / (Math.max(0, tDef) + 100);

  // element multiplier
  const elemA = elementMultiplier(A.ps.element || 'normal', T.ps.element || 'normal');
  const elemT = elementMultiplier(T.ps.element || 'normal', A.ps.element || 'normal');
  attackerATK = Math.floor(attackerATK * elemA);
  counterATK = Math.floor(counterATK * elemT);

  // shield flags
  let isTargetProtected = tShield > nowMs;
  let isTargetSemiShield = hasBuff(tActive, 'semi_shield') && !isTargetProtected;

  let result = battleResult;
  let msg = '';
  let targetTook = 0, attackerTook = 0;
  let pvpGoldEarned = 0;

  // auto_win → ทำลายโล่ทั้งหมดและบังคับชนะ
  if (result === 'auto_win') {
    result = 'win';
    if (isTargetProtected || isTargetSemiShield) {
      await notify(sb, targetId, 'pvp', '📜 <b>เกราะถูกทำลาย!</b> บาเรียถูกลบล้างด้วยคัมภีร์ประกาศิต');
    }
    tShield = 0; tActive = removeBuff(tActive, 'semi_shield');
    isTargetProtected = false; isTargetSemiShield = false;
    msg += '📜 คัมภีร์ประกาศิตทำงาน! สั่งชนะและทำลายการป้องกันทั้งหมด! ';
  }

  if (result === 'win') {
    // apply active skill: ATK boost + dmg multiplier
    let dmg = Math.floor(attackerATK * (1 + attackerATKBoost / 100) * dmgMult);
    if (activeSkillMsg) msg += activeSkillMsg;
    if (hasBuff(aActive, 'berserk')) {
      dmg *= 2;
      aActive = removeBuff(aActive, 'berserk');
      msg += '🔥 สถานะบ้าคลั่งทำงาน! ดาเมจ x2! ';
    }
    // active heal: ฟื้น HP attacker ตั้งแต่ก่อนตี
    if (activeHealPct > 0) {
      const heal = Math.floor(aMaxHp * activeHealPct / 100);
      aHp = Math.min(aMaxHp, aHp + heal);
    }
    if (elemA > 1) msg += `✨ ชนะทางธาตุ! (x${elemA}) `;
    else if (elemA < 1) msg += `💦 แพ้ทางธาตุ (/2) `;

    if (hasBuff(tActive, 'reflect')) {
      attackerTook = dmg;
      tActive = removeBuff(tActive, 'reflect');
      msg += `🪞 ศัตรูมีกระจกสะท้อน! ดาเมจ ${dmg} เด้งกลับ! `;
    } else if (isTargetProtected) {
      if (hasBuff(aActive, 'shield_breaker')) {
        targetTook = dmg;
        tShield = 0; tActive = removeBuff(tActive, 'semi_shield');
        aActive = removeBuff(aActive, 'shield_breaker');
        msg += '🔨 ค้อนพิฆาตทุบบาเรียศัตรูแตก! ';
        await notify(sb, targetId, 'pvp', '🛡️ <b>เกราะถูกทำลาย!</b>');
      } else {
        msg += '🛡️ ศัตรูกางบาเรียป้องกัน! การโจมตีไร้ผล!';
      }
    } else if (isTargetSemiShield) {
      targetTook = Math.floor(dmg * 0.5);
      tActive = removeBuff(tActive, 'semi_shield');
      msg += `🛡️ กึ่งบาเรีย! ดาเมจลด 50% (${targetTook} DMG) เกราะแตก! `;
      await notify(sb, targetId, 'pvp', '🛡️ <b>กึ่งบาเรียแตก!</b>');
    } else {
      targetTook = dmg;
    }

    // apply target DEF reduction (skip ถ้า thunderBolt)
    if (targetTook > 0 && !isThunderBolt) {
      targetTook = Math.max(1, Math.floor(targetTook * (1 - tDefReduction)));
      if (tDef > 0) msg += `🛡️ DEF ศัตรู ${tDef} ลดดาเมจ ${Math.floor(tDefReduction*100)}% `;
    } else if (isThunderBolt && targetTook > 0) {
      msg += `⚡ ทะลุเกราะ! DEF ศัตรูถูกมองข้าม `;
    }

    if (targetTook > 0) {
      const goldReward = Number(settings.pvp_reward_gold) || 1000;
      pvpGoldEarned = goldReward;
      aFreeCoins += pvpGoldEarned;
      msg += ` 🏆 ได้รับ ${pvpGoldEarned} G! `;

      // counter-attack จากฝ่ายที่โดน — ลดด้วย debuff + iceShield + DEF ของ attacker
      let counterEffective = counterATK * (1 - counterATKDebuff / 100) * (1 - iceShieldReduction);
      let counterDmg = Math.max(1, Math.floor(counterEffective * (1 - aDefReduction)));
      // active reflect 100% — สะท้อนกลับศัตรู ไม่โดนเอง
      if (activeReflect100) {
        targetTook += counterDmg;
        msg += `🪞 สะท้อนดาเมจโต้กลับ ${counterDmg} กลับไปที่ศัตรู! `;
      } else {
        attackerTook += counterDmg;
        msg += `⚔️ ศัตรูโจมตีโต้กลับ ${counterDmg} DMG! `;
      }

      // lifesteal — heal attacker
      const lifeStealPct = (getPassiveValue(A.equippedSkills, 'lifeSteal', aDaily.bCount) || 0) + (A.equipBonus.lifesteal || 0);
      if (lifeStealPct > 0) {
        const heal = Math.floor(targetTook * lifeStealPct / 100);
        aHp = Math.min(aMaxHp, aHp + heal);
        if (heal > 0) msg += `🧛 ดูดเลือด +${heal} HP! `;
      }

      // thorns — sacrificial reflect from target
      const tThorns = getPassiveValue(T.equippedSkills, 'thorns', tDaily.bCount) || 0;
      if (tThorns > 0) {
        const thornsDmg = Math.floor(targetTook * tThorns / 100);
        attackerTook += thornsDmg;
        msg += `🌿 หนามศัตรูสะท้อนดาเมจ ${thornsDmg}! `;
      }
    }
  } else if (result === 'lose' || result === 'draw') {
    if (hasBuff(aActive, 'berserk')) {
      attackerTook = Math.floor((Number(baseDamage) || attackerATK) / 2);
      aActive = removeBuff(aActive, 'berserk');
      msg += `🩸 ผลจากยาบ้าคลั่ง คุณ${result === 'lose' ? 'แพ้' : 'เสมอ'}โดนดาเมจย้อนกลับ ${attackerTook}! `;
    } else {
      msg += result === 'lose' ? '💀 คุณพ่ายแพ้ สัตว์เลี้ยงหนีมาได้ทัน' : '⚔️ พลังสูสีกัน กินกันไม่ลง!';
    }
  }

  // apply damage
  if (targetTook > 0) {
    tHp -= targetTook;
    if (tHp <= 0) {
      tDaily.lostToday += 1;
      if (tDaily.lostToday === 2 && !hasBuff(tActive, 'semi_shield')) tActive = addBuff(tActive, 'semi_shield');
      else if (tDaily.lostToday >= 3 && tShield <= nowMs) {
        tShield = nowMs + 24 * 60 * 60 * 1000;
        tActive = removeBuff(tActive, 'semi_shield');
      }
      tHp = tMaxHp;
      msg += '💥 CRITICAL HIT! ศัตรูเลือดหมดหลอด ';
      await notify(sb, targetId, 'pvp', '💀 <b>ฐานที่มั่นถูกตีแตก!</b> เลือดหมดหลอด');
    } else {
      msg += `🗡️ สร้างความเสียหาย ${targetTook} DMG! `;
      await notify(sb, targetId, 'pvp', `⚔️ สัตว์เลี้ยงถูกโจมตีเสีย <b>${targetTook} HP</b>`);
    }
  }
  if (attackerTook > 0) {
    aHp -= attackerTook;
    // active skill revive
    if (aHp <= 0 && activeRevivePct > 0) {
      aHp = Math.floor(aMaxHp * activeRevivePct / 100);
      msg += `✨ คืนชีพ! ฟื้น ${activeRevivePct}% HP `;
    } else if (aHp <= 0) {
      aDaily.lostToday += 1;
      if (aDaily.lostToday === 2 && !hasBuff(aActive, 'semi_shield')) aActive = addBuff(aActive, 'semi_shield');
      else if (aDaily.lostToday >= 3 && aShield <= nowMs) {
        aShield = nowMs + 24 * 60 * 60 * 1000;
        aActive = removeBuff(aActive, 'semi_shield');
      }
      aHp = aMaxHp;
      msg += '💀 โดนโต้กลับจนเลือดหมด! ';
      await notify(sb, aid, 'pvp', '🩸 โดนโต้กลับจนเลือดหมด');
    } else {
      await notify(sb, aid, 'pvp', `🩸 โดนโจมตีโต้กลับ <b>${attackerTook} HP</b>`);
    }
  }

  // ===== PvP Player EXP (offset) =====
  const pvpExpWin = Number(settings.player_exp_pvp_win) || 500;
  const pvpExpLose = Number(settings.player_exp_pvp_lose) || 200;
  const pvpExpDraw = Number(settings.player_exp_pvp_draw) || 300;
  let aPlayerExp = result === 'win' ? pvpExpWin : (result === 'lose' ? pvpExpLose : pvpExpDraw);
  let tPlayerExp = result === 'win' ? pvpExpLose : (result === 'lose' ? pvpExpWin : pvpExpDraw);
  aOffset += aPlayerExp;
  tOffset += tPlayerExp;
  msg += ` 👤 +${aPlayerExp} Player EXP `;

  // ===== PvP Pet EXP (เพิ่มที่ equipped capsule) =====
  const petExpWin = Number(settings.pet_exp_pvp_win) || 2000;
  const petExpLose = Number(settings.pet_exp_pvp_lose) || 1000;
  const petExpDraw = Number(settings.pet_exp_pvp_draw) || 1500;
  const aPetExp = result === 'win' ? petExpWin : (result === 'lose' ? petExpLose : petExpDraw);
  const tPetExp = result === 'win' ? petExpLose : (result === 'lose' ? petExpWin : petExpDraw);
  if (A.equippedItemId && aPetExp > 0) {
    const { data: aInv } = await sb.from('inventory').select('pet_exp').eq('item_id', A.equippedItemId).maybeSingle();
    const newExp = (Number(aInv && aInv.pet_exp) || 0) + aPetExp;
    await sb.from('inventory').update({ pet_exp: newExp }).eq('item_id', A.equippedItemId);
    msg += ` 🐾 +${aPetExp} Pet EXP `;
  }
  if (T.equippedItemId && tPetExp > 0) {
    const { data: tInv } = await sb.from('inventory').select('pet_exp').eq('item_id', T.equippedItemId).maybeSingle();
    const newExp = (Number(tInv && tInv.pet_exp) || 0) + tPetExp;
    await sb.from('inventory').update({ pet_exp: newExp }).eq('item_id', T.equippedItemId);
  }

  // Track pvpWins ใน daily_items
  if (result === 'win') aDaily.dailyItems.pvpWins = (Number(aDaily.dailyItems.pvpWins) || 0) + 1;

  // commit to DB
  await sb.from('pet_stats').update({
    active_buff: aActive,
    exp_offset: aOffset,
    free_coins: aFreeCoins,
    current_hp: aHp,
    shield_expiry: aShield,
    levels_lost_today: aDaily.lostToday,
    last_attacked_date: today,
    battle_count_today: aDaily.bCount,
    daily_battles: aDaily.dailyBattles,
    last_battle_date: today,
    daily_items: aDaily.dailyItems,
    updated_at: new Date().toISOString()
  }).eq('user_id', aid);

  await sb.from('pet_stats').update({
    active_buff: tActive,
    exp_offset: tOffset,
    current_hp: tHp,
    shield_expiry: tShield,
    levels_lost_today: tDaily.lostToday,
    last_attacked_date: today,
    daily_items: tDaily.dailyItems,
    updated_at: new Date().toISOString()
  }).eq('user_id', targetId);

  return ok({
    message: msg || (result === 'win' ? 'Victory!' : 'Finished'),
    materialDrop: '' // Phase 2C
  });
}

// ============================================================
// usePvpItem — เพิ่ม counter ของ PvP item ใน activeBuff (ใช้ตอนซื้อ → ที่ shop ทำให้แล้ว
// แต่ frontend อาจเรียกแยกเพื่อ "ใช้" → หักทีละชิ้น)
// ============================================================
async function usePvpItem(ctx, userId, itemKey, useQty) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  const qty = Math.max(1, parseInt(useQty) || 1);

  const sb = getSupabase();
  const ps = await getOrCreatePetStats(sb, uid);
  const cur = getPvpCount(ps.active_buff || '', itemKey);
  if (cur < qty) return fail('ไอเทมไม่พอ');
  const newBuff = setPvpCount(ps.active_buff || '', itemKey, cur - qty);
  await sb.from('pet_stats').update({ active_buff: newBuff, updated_at: new Date().toISOString() }).eq('user_id', uid);
  return ok({ remaining: cur - qty });
}

module.exports = { applyBattleDamage, usePvpItem };
