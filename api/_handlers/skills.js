// ============================================================
// Skills handlers — get skills, reroll, admin config
// ============================================================
const { getSupabase } = require('../_lib/supabase');
const { ok, fail } = require('../_lib/util');
const { loadAllSkillDefs, rollRandomSkill } = require('../_lib/skills');

async function loadSettings(sb) {
  const { data } = await sb.from('settings').select('key,value');
  const m = {};
  (data || []).forEach(r => { m[r.key] = r.value; });
  return m;
}

// mirror: getAllSkillDefinitions()
async function getAllSkillDefinitions() {
  const sb = getSupabase();
  return await loadAllSkillDefs(sb);
}

// mirror: getPetSkills(petItemId)
async function getPetSkills(_ctx, petItemId) {
  const sb = getSupabase();
  const [defs, learned] = await Promise.all([
    loadAllSkillDefs(sb),
    sb.from('pet_learned_skills').select('*').eq('pet_item_id', petItemId).then(r => r.data || [])
  ]);
  const defMap = {};
  defs.forEach(d => { defMap[d.id] = d; });
  return learned.map(l => {
    const d = defMap[l.skill_id];
    return d ? { ...d, learnedId: l.learned_id, source: l.source } : null;
  }).filter(Boolean);
}

// mirror: getEquippedPetSkills(userId) — สกิลของ pet ที่กำลัง equipped
async function getEquippedPetSkills(ctx, userId) {
  const uid = userId || (ctx.user && ctx.user.userId);
  if (!uid) return [];
  const sb = getSupabase();
  const { data: eq } = await sb.from('inventory').select('item_id')
    .eq('user_id', uid).eq('category', 'equipped').maybeSingle();
  if (!eq) return [];
  return getPetSkills(ctx, eq.item_id);
}

// mirror: getSkillRerollConfig() — ค่า config สำหรับ admin
async function getSkillRerollConfig() {
  const sb = getSupabase();
  const settings = await loadSettings(sb);
  return {
    rarityRates: {
      C:   Number(settings.skill_rarity_rate_C   ?? 50),
      R:   Number(settings.skill_rarity_rate_R   ?? 30),
      SR:  Number(settings.skill_rarity_rate_SR  ?? 15),
      SSR: Number(settings.skill_rarity_rate_SSR ??  4),
      UR:  Number(settings.skill_rarity_rate_UR  ??  1)
    },
    perSkillWeight: Object.keys(settings).filter(k => k.startsWith('skill_rate_'))
      .reduce((m, k) => { m[k.replace('skill_rate_', '')] = Number(settings[k]) || 0; return m; }, {})
  };
}

// mirror: saveSkillRerollConfig(config)
async function saveSkillRerollConfig(ctx, config) {
  if (!ctx.user || ctx.user.role !== 'Admin') return fail('สิทธิ์ไม่เพียงพอ');
  if (!config) return fail('ข้อมูลไม่ครบ');
  const sb = getSupabase();
  const rows = [];
  if (config.rarityRates) {
    for (const r of ['C','R','SR','SSR','UR']) {
      if (config.rarityRates[r] !== undefined) rows.push({ key: 'skill_rarity_rate_' + r, value: Number(config.rarityRates[r]) || 0 });
    }
  }
  if (config.perSkillWeight) {
    for (const sid in config.perSkillWeight) {
      rows.push({ key: 'skill_rate_' + sid, value: Number(config.perSkillWeight[sid]) || 0 });
    }
  }
  if (rows.length === 0) return ok({ message: 'ไม่มีอะไรต้องบันทึก' });
  const { error } = await sb.from('settings').upsert(rows, { onConflict: 'key' });
  if (error) return fail(error.message);
  return ok({ message: 'บันทึกการตั้งค่าสกิลสำเร็จ' });
}

// mirror: confirmSkillReroll(userId, petItemId, action, newSkillId, replaceLearnedId)
//   action: 'keep' (ยกเลิก ไม่เปลี่ยน) | 'replace' (เปลี่ยน learnedId เป็น newSkillId)
async function confirmSkillReroll(ctx, userId, petItemId, action, newSkillId, replaceLearnedId) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const uid = userId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && uid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  if (action === 'keep') return ok({ message: 'ยกเลิกการเปลี่ยนสกิล' });
  if (action !== 'replace' || !newSkillId || !replaceLearnedId) return fail('ข้อมูลไม่ครบ');

  const sb = getSupabase();
  const { data: defs } = await sb.from('pet_skills').select('skill_id, type').eq('skill_id', newSkillId).maybeSingle();
  if (!defs) return fail('ไม่พบสกิลใหม่');

  const { error } = await sb.from('pet_learned_skills').update({
    skill_id: newSkillId,
    skill_type: defs.type,
    source: 'reroll',
    acquired_at: new Date().toISOString()
  }).eq('learned_id', replaceLearnedId).eq('pet_item_id', petItemId);
  if (error) return fail(error.message);
  return ok({ message: 'เปลี่ยนสกิลใหม่เรียบร้อย!' });
}

// mirror: migrateSkillsOnEquip(userId, petItemId) — จริง ๆ Phase 2A เราย้าย row category ตรงๆ
//   ตรงนี้ขอเป็น noop เพราะสกิลผูกกับ pet_item_id ไม่ใช่ category
async function migrateSkillsOnEquip(_ctx, _userId, _petItemId) {
  return ok({ message: 'no migration needed (skills bound to pet_item_id)' });
}

// helper exposed: assign a rolled skill to a pet (used by gacha confirm Phase 2C+)
async function _assignRolledSkill(sb, petItemId, ownerId, skillId, skillType, source) {
  const { error } = await sb.from('pet_learned_skills').insert({
    pet_item_id: petItemId,
    owner_user_id: ownerId,
    skill_id: skillId,
    skill_type: skillType || 'passive',
    source: source || 'gacha'
  });
  if (error) console.error('[assignRolledSkill]', error);
}

module.exports = {
  getAllSkillDefinitions,
  getPetSkills,
  getEquippedPetSkills,
  getSkillRerollConfig,
  saveSkillRerollConfig,
  confirmSkillReroll,
  migrateSkillsOnEquip,
  _assignRolledSkill
};
