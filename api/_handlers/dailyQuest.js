// ============================================================
// Daily Quest — เควสรายวัน
// ============================================================
const { getSupabase } = require('../_lib/supabase');
const { ok, fail } = require('../_lib/util');

function todayDate() { return new Date().toISOString().substring(0, 10); }

async function getOrCreatePetStats(sb, userId) {
  let { data: ps } = await sb.from('pet_stats').select('*').eq('user_id', userId).maybeSingle();
  if (!ps) {
    const { data: created } = await sb.from('pet_stats').insert({ user_id: userId }).select('*').single();
    ps = created;
  }
  return ps;
}

// progress ของ user สำหรับ quest แต่ละชนิด (อ่านจาก pet_stats.daily_items + อื่น ๆ ตาม progress_type)
async function calcProgress(sb, userId, ps, type, today) {
  const di = (ps && ps.daily_items && typeof ps.daily_items === 'object') ? ps.daily_items : {};
  switch (type) {
    case 'login':       return 1; // เปิดหน้านี้ = ถือว่า login
    case 'submit': {
      const { data: subs } = await sb.from('submissions').select('submit_date').eq('student_id', userId).gte('submit_date', today + 'T00:00:00Z');
      return (subs || []).length;
    }
    case 'pvp_win':     return Number(di.pvpWins) || 0;
    case 'gacha':       return Number(di.gacha) || 0;
    case 'shop_buy':    return Number(di.shopBuys) || 0;
    case 'pet_upgrade': return Number(di.petUpgrades) || 0;
    default: return 0;
  }
}

// mirror: getDailyQuests(userId)
async function getDailyQuests(ctx, userId) {
  if (!ctx.user) return [];
  const uid = userId || ctx.user.userId;
  const sb = getSupabase();
  const today = todayDate();

  const [{ data: cfgs }, { data: claims }, ps] = await Promise.all([
    sb.from('daily_quest_config').select('*').eq('is_active', true).order('quest_id'),
    sb.from('daily_quest_claims').select('quest_id').eq('user_id', uid).eq('claim_date', today),
    getOrCreatePetStats(sb, uid)
  ]);
  const claimedSet = new Set((claims || []).map(c => c.quest_id));

  const result = [];
  for (const c of cfgs || []) {
    const progress = await calcProgress(sb, uid, ps, c.progress_type, today);
    result.push({
      id: c.quest_id, name: c.name, desc: c.description,
      progressType: c.progress_type, target: c.target,
      rewardGold: c.reward_gold, rewardExp: c.reward_exp,
      progress, isComplete: progress >= c.target,
      isClaimed: claimedSet.has(c.quest_id)
    });
  }
  return result;
}

// mirror: claimDailyQuestReward(userId, questId)
async function claimDailyQuestReward(ctx, userId, questId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  const sb = getSupabase();
  const today = todayDate();

  const { data: cfg } = await sb.from('daily_quest_config').select('*').eq('quest_id', questId).maybeSingle();
  if (!cfg || !cfg.is_active) return fail('ภารกิจนี้ปิดอยู่');

  // เช็คเคยรับมั้ย
  const { data: existing } = await sb.from('daily_quest_claims').select('quest_id').eq('user_id', uid).eq('quest_id', questId).eq('claim_date', today).maybeSingle();
  if (existing) return fail('รับรางวัลไปแล้ว');

  // เช็ค progress
  const ps = await getOrCreatePetStats(sb, uid);
  const progress = await calcProgress(sb, uid, ps, cfg.progress_type, today);
  if (progress < cfg.target) return fail(`ยังทำไม่ครบ (${progress}/${cfg.target})`);

  // mark claimed
  await sb.from('daily_quest_claims').insert({ user_id: uid, quest_id: questId, claim_date: today });

  // give reward (gold = free_coins, exp = exp_offset)
  const updates = { updated_at: new Date().toISOString() };
  if (cfg.reward_gold) updates.free_coins = (Number(ps.free_coins) || 0) + cfg.reward_gold;
  if (cfg.reward_exp) updates.exp_offset = (Number(ps.exp_offset) || 0) + cfg.reward_exp;
  await sb.from('pet_stats').update(updates).eq('user_id', uid);

  await sb.from('notifications').insert({
    user_id: uid, type: 'system',
    message: `✅ ภารกิจรายวัน "${cfg.name}" สำเร็จ! ได้รับ ${cfg.reward_gold} G + ${cfg.reward_exp} EXP`
  });

  return ok({ message: 'รับรางวัลเรียบร้อย!', rewardGold: cfg.reward_gold, rewardExp: cfg.reward_exp });
}

// =========== Admin =============
async function getAdminDailyQuestConfig(ctx) {
  if (!ctx.user || ctx.user.role !== 'Admin') return [];
  const sb = getSupabase();
  const { data } = await sb.from('daily_quest_config').select('*').order('quest_id');
  return (data || []).map(c => ({
    id: c.quest_id, name: c.name, desc: c.description,
    progressType: c.progress_type, target: c.target,
    rewardGold: c.reward_gold, rewardExp: c.reward_exp, isActive: c.is_active
  }));
}

async function updateDailyQuestConfig(ctx, quest) {
  if (!ctx.user || ctx.user.role !== 'Admin') return fail('สิทธิ์ไม่เพียงพอ');
  if (!quest || !quest.id) return fail('ข้อมูลไม่ครบ');
  const sb = getSupabase();
  const { error } = await sb.from('daily_quest_config').update({
    name: quest.name, description: quest.desc,
    progress_type: quest.progressType, target: Number(quest.target) || 1,
    reward_gold: Number(quest.rewardGold) || 0, reward_exp: Number(quest.rewardExp) || 0
  }).eq('quest_id', quest.id);
  if (error) return fail(error.message);
  return ok();
}

async function toggleDailyQuest(ctx, questId, newActive) {
  if (!ctx.user || ctx.user.role !== 'Admin') return fail('สิทธิ์ไม่เพียงพอ');
  const sb = getSupabase();
  const { error } = await sb.from('daily_quest_config').update({ is_active: !!newActive }).eq('quest_id', questId);
  if (error) return fail(error.message);
  return ok();
}

async function addDailyQuest(ctx, quest) {
  if (!ctx.user || ctx.user.role !== 'Admin') return fail('สิทธิ์ไม่เพียงพอ');
  if (!quest || !quest.id || !quest.name) return fail('ข้อมูลไม่ครบ');
  const sb = getSupabase();
  const { error } = await sb.from('daily_quest_config').insert({
    quest_id: quest.id, name: quest.name, description: quest.desc || '',
    progress_type: quest.progressType || 'login', target: Number(quest.target) || 1,
    reward_gold: Number(quest.rewardGold) || 0, reward_exp: Number(quest.rewardExp) || 0,
    is_active: true
  });
  if (error) return fail(error.message);
  return ok({ message: 'สร้างภารกิจสำเร็จ' });
}

async function deleteDailyQuest(ctx, questId) {
  if (!ctx.user || ctx.user.role !== 'Admin') return fail('สิทธิ์ไม่เพียงพอ');
  const sb = getSupabase();
  const { error } = await sb.from('daily_quest_config').delete().eq('quest_id', questId);
  if (error) return fail(error.message);
  return ok({ message: 'ลบภารกิจเรียบร้อย' });
}

module.exports = {
  getDailyQuests, claimDailyQuestReward,
  getAdminDailyQuestConfig, updateDailyQuestConfig, toggleDailyQuest, addDailyQuest, deleteDailyQuest
};
