// ============================================================
// Skills helpers — load defs, roll random, calc combat stats
// ============================================================

async function loadAllSkillDefs(sb) {
  const { data } = await sb.from('pet_skills').select('*');
  return (data || []).map(r => ({
    id: r.skill_id, name: r.name, type: r.type, effect: r.effect,
    value: Number(r.value) || 0, description: r.description || '',
    minRarity: r.min_rarity || 'C', cooldown: Number(r.cooldown) || 0,
    rerollWeight: Number(r.reroll_weight) || 100
  }));
}

// 2-step: เลือก rarity จาก rate ก่อน → ค่อยสุ่มสกิลในกลุ่ม
function rollRandomSkill(allSkills, skillType, settings) {
  const pool = allSkills.filter(s => s.type === skillType);
  if (pool.length === 0) return null;
  const rates = {
    C:  Number(settings.skill_rarity_rate_C  ?? 50),
    R:  Number(settings.skill_rarity_rate_R  ?? 30),
    SR: Number(settings.skill_rarity_rate_SR ?? 15),
    SSR:Number(settings.skill_rarity_rate_SSR?? 4),
    UR: Number(settings.skill_rarity_rate_UR ?? 1)
  };
  const groups = {};
  for (const s of pool) {
    const r = s.minRarity || 'C';
    if (!groups[r]) groups[r] = [];
    groups[r].push(s);
  }
  const avail = [];
  let totalW = 0;
  for (const r in groups) {
    const w = rates[r] || 0;
    if (w > 0) { avail.push({ r, w }); totalW += w; }
  }
  if (avail.length === 0) {
    // fallback weighted
    const tw = pool.reduce((sum, s) => sum + s.rerollWeight, 0);
    let roll = Math.random() * tw;
    for (const s of pool) { roll -= s.rerollWeight; if (roll <= 0) return s; }
    return pool[pool.length - 1];
  }
  let roll = Math.random() * totalW;
  let chosen = avail[0].r;
  for (const it of avail) { roll -= it.w; if (roll <= 0) { chosen = it.r; break; } }
  const grp = groups[chosen];
  if (!grp || grp.length === 0) return pool[0];
  const tw = grp.reduce((sum, s) => sum + (Number(settings['skill_rate_' + s.id]) || s.rerollWeight), 0);
  let r2 = Math.random() * tw;
  for (const s of grp) {
    const w = Number(settings['skill_rate_' + s.id]) || s.rerollWeight;
    r2 -= w;
    if (r2 <= 0) return s;
  }
  return grp[grp.length - 1];
}

// คำนวณ combat stats จาก passive skills ของ user (battleCount ไว้ตรวจ cooldown)
function calcPassiveCombatStats(equippedSkills, battleCount) {
  const stats = { hpBoostPct: 0, atkBoostPct: 0, def: 0, spd: 0, evadeBonus: 0 };
  for (const sk of equippedSkills) {
    if (sk.type !== 'passive') continue;
    // skip if cooldown not ready (skill.cooldown > 0 และ battleCount ยังไม่ครบรอบ)
    if (sk.cooldown > 0 && (battleCount % sk.cooldown !== 0)) continue;
    if (sk.effect === 'hpBoost')  stats.hpBoostPct  += sk.value;
    if (sk.effect === 'atkBoost') stats.atkBoostPct += sk.value;
    if (sk.effect === 'defBoost') stats.def         += sk.value;
    if (sk.effect === 'spdBoost') stats.spd         += sk.value;
    // lifeSteal/thorns ใช้ใน PvP path เอง, lucky ใน drop
  }
  return stats;
}

// passive value ของ effect เฉพาะ (เช่น lifeSteal, thorns) — คำนึง cooldown
function getPassiveValue(equippedSkills, effect, battleCount) {
  for (const sk of equippedSkills) {
    if (sk.type !== 'passive' || sk.effect !== effect) continue;
    if (sk.cooldown > 0 && (battleCount % sk.cooldown !== 0)) continue;
    return sk.value;
  }
  return 0;
}

module.exports = { loadAllSkillDefs, rollRandomSkill, calcPassiveCombatStats, getPassiveValue };
