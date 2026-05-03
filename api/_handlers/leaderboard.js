// ============================================================
// Leaderboard / Player Stats — รวมข้อมูลผู้เล่น+สัตว์เลี้ยง+inventory
// (Phase 2A — ยังไม่รวม skills/equipment/guild buff — มาทีหลัง)
// ============================================================
const { getSupabase } = require('../_lib/supabase');
const {
  calculateLevelAndExp, calculateMaxHp,
  calculatePetLevelFromExp, calcUserBaseFromSubmissions, calcEnhanceHpBonus
} = require('../_lib/pet');

function safeStr(v) { return v === null || v === undefined ? '' : String(v); }

// ดึง settings ที่เกี่ยวกับ buff (มี default ถ้าไม่มี)
async function loadGameSettings(sb) {
  const { data } = await sb.from('settings').select('key,value');
  const out = {
    enhance_15_aura_hp_buff: 5,
    enhance_15_aura_atk_buff: 5,
    enhance_20_title_hp_buff: 10,
    enhance_20_title_atk_buff: 10
  };
  (data || []).forEach(r => {
    if (r.value !== undefined && r.value !== null) {
      const v = typeof r.value === 'string' && !isNaN(r.value) ? Number(r.value) : r.value;
      out[r.key] = v;
    }
  });
  return out;
}

// mirror: getLeaderboardData()
// คืน array ของผู้เล่น เรียงตาม level
async function getLeaderboardData() {
  const sb = getSupabase();

  // load all data in parallel
  const [usersRes, petStatsRes, inventoryRes, submissionsRes, settings] = await Promise.all([
    sb.from('users').select('user_id, name, grade, role').eq('role', 'Student'),
    sb.from('pet_stats').select('*'),
    sb.from('inventory').select('*'),
    sb.from('submissions').select('student_id, score'),
    loadGameSettings(sb)
  ]);

  const users = usersRes.data || [];
  const allPetStats = petStatsRes.data || [];
  const allInventory = inventoryRes.data || [];
  const submissions = submissionsRes.data || [];

  // group inventory by user_id
  const invByUser = {};
  allInventory.forEach(it => {
    if (!invByUser[it.user_id]) invByUser[it.user_id] = [];
    invByUser[it.user_id].push({
      id: it.item_id,
      category: it.category,
      type: it.item_key || '',
      element: it.element || 'normal',
      createdAt: it.created_at ? String(it.created_at).substring(0, 10) : '',
      enhance: it.enhance_level || 0,
      amount: it.quantity || 1,
      petExp: it.pet_exp || 0,
      petLevel: it.pet_level || 0,
      isLocked: !!it.is_locked,
      lockedReason: it.locked_reason || '',
      customName: it.custom_name || '',
      petAura: it.pet_aura || '',
      petTitle: it.pet_title || '',
      petSkills: [] // Phase 2C จะเติม
    });
  });

  // group submissions by user → exp/coins base
  const subByUser = {};
  submissions.forEach(s => {
    if (!subByUser[s.student_id]) subByUser[s.student_id] = [];
    subByUser[s.student_id].push(s);
  });

  // build pet_stats lookup
  const psMap = {};
  allPetStats.forEach(p => { psMap[p.user_id] = p; });

  const todayStr = new Date().toISOString().substring(0, 10);
  const nowMs = Date.now();
  const result = [];

  for (const u of users) {
    const ps = psMap[u.user_id] || {};
    const subs = subByUser[u.user_id] || [];
    const inv = invByUser[u.user_id] || [];

    const base = calcUserBaseFromSubmissions(subs);
    const offset = Number(ps.exp_offset) || 0;
    const totalExp = base.exp + offset;
    const lvl = calculateLevelAndExp(totalExp);

    const earnedCoins = base.coins;
    const spentCoins = Number(ps.coins_spent) || 0;
    const freeCoins = Number(ps.free_coins) || 0;
    const currentCoins = Math.max(0, earnedCoins + freeCoins - spentCoins);

    const enhanceLvl = Number(ps.enhance_level) || 0;
    let hpBonus = calcEnhanceHpBonus(enhanceLvl);
    if (ps.pet_aura) hpBonus += (Number(settings.enhance_15_aura_hp_buff) || 5) / 100;
    if (ps.pet_title) hpBonus += (Number(settings.enhance_20_title_hp_buff) || 10) / 100;

    // pet level จาก equipped capsule
    let equippedPetLevel = 1, equippedPetExp = 0, equippedPetMaxExp = 1000;
    let eqInv = inv.find(i => i.category === 'equipped') || inv.find(i => i.category === 'pets');
    if (eqInv) {
      const calc = calculatePetLevelFromExp(eqInv.petExp || 0);
      equippedPetLevel = calc.petLevel;
      equippedPetExp = calc.currentPetExp;
      equippedPetMaxExp = calc.maxPetExp;
    }

    const maxHp = Math.floor(calculateMaxHp(equippedPetLevel) * (1 + hpBonus));
    const petHpRaw = Number(ps.current_hp);
    const currentHp = (!petHpRaw || petHpRaw <= 0 || petHpRaw > maxHp) ? maxHp : petHpRaw;

    const shieldExpiry = Number(ps.shield_expiry) || 0;
    const lastAtkDate = ps.last_attacked_date ? String(ps.last_attacked_date).substring(0,10) : '';
    const lostToday = lastAtkDate === todayStr ? (Number(ps.levels_lost_today) || 0) : 0;
    const isProtected = shieldExpiry > nowMs;
    const activeBuff = safeStr(ps.active_buff);
    const isSemiShield = activeBuff.includes('semi_shield');

    const lastBattleDate = ps.last_battle_date ? String(ps.last_battle_date).substring(0,10) : '';
    const bCount = lastBattleDate === todayStr ? (Number(ps.battle_count_today) || 0) : 0;
    const dBattles = lastBattleDate === todayStr ? (ps.daily_battles || []) : [];
    const dailyItems = lastBattleDate === todayStr ? (ps.daily_items || {}) : {};

    result.push({
      UserID: u.user_id,
      Name: u.name,
      Grade: u.grade || '',
      petExp: lvl.currentExp,
      petMaxExp: lvl.maxExp,
      petLv: lvl.level,
      petHp: currentHp,
      petMaxHp: maxHp,
      coins: currentCoins,
      petType: safeStr(ps.pet_type) || (eqInv ? eqInv.type : 'dog'),
      isProtected,
      isSemiShield,
      protectionEndTime: isProtected ? new Date(shieldExpiry).toISOString() : null,
      battleCountToday: bCount,
      dailyBattles: JSON.stringify(dBattles),
      customName: safeStr(ps.custom_name),
      activeBuff,
      element: safeStr(ps.element) || 'normal',
      dailyItems: JSON.stringify(dailyItems),
      enhance: enhanceLvl,
      inventory: JSON.stringify(inv),
      inventoryLimit: Number(ps.inventory_limit) || 5,
      souls: Number(ps.souls) || 0,
      petAura: safeStr(ps.pet_aura),
      petTitle: safeStr(ps.pet_title),
      petSkills: '[]', // Phase 2C
      skillStats: { hpBoostPct: 0, atkBoostPct: 0, def: 0, spd: 0, guildPermAtk: 0, guildPermHp: 0 },
      guildBuff: { atkPct: 0, hpPct: 0 },
      guildName: '',
      equippedPetLevel,
      equippedPetExp,
      equippedPetMaxExp,
      playerLevelBonus: lvl.level * 10
    });
  }

  result.sort((a, b) => b.petLv !== a.petLv ? b.petLv - a.petLv : b.petExp - a.petExp);
  return result;
}

module.exports = { getLeaderboardData };
