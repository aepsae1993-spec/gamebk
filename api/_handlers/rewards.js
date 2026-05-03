// ============================================================
// Rewards — แจก Gold/EXP/Souls โดยครู/แอดมิน
// ============================================================
const { getSupabase } = require('../_lib/supabase');
const { ok, fail } = require('../_lib/util');

async function loadSettings(sb) {
  const { data } = await sb.from('settings').select('key,value');
  const m = {};
  (data || []).forEach(r => { m[r.key] = r.value; });
  return m;
}

function todayStr() { return new Date().toISOString().substring(0, 10); }

async function getOrCreatePetStats(sb, userId) {
  let { data: ps } = await sb.from('pet_stats').select('*').eq('user_id', userId).maybeSingle();
  if (!ps) {
    const { data: created, error } = await sb.from('pet_stats').insert({ user_id: userId }).select('*').single();
    if (error) throw new Error(error.message);
    ps = created;
  }
  return ps;
}

// mirror: getTeacherQuota(teacherId)
async function getTeacherQuota(ctx, teacherId) {
  const tid = teacherId || (ctx.user && ctx.user.userId);
  if (!tid) return { quota: 0, isUnlimited: false, maxQuota: 100 };
  const sb = getSupabase();
  const { data: u } = await sb.from('users').select('role, teacher_daily_g, teacher_last_g_date').eq('user_id', tid).maybeSingle();
  if (!u) return { quota: 0, isUnlimited: false, maxQuota: 100 };
  if (u.role === 'Admin') return { quota: 999999, isUnlimited: true };

  const settings = await loadSettings(sb);
  const dailyQuota = settings.teacher_daily_quota !== undefined ? Number(settings.teacher_daily_quota) : 100;
  const lastDate = u.teacher_last_g_date ? String(u.teacher_last_g_date).substring(0,10) : '';
  const usedG = lastDate === todayStr() ? (Number(u.teacher_daily_g) || 0) : 0;
  return { quota: Math.max(0, dailyQuota - usedG), isUnlimited: false, maxQuota: dailyQuota };
}

// helper: หักโควต้าครู
async function consumeTeacherQuota(sb, teacherId, amount) {
  const { data: u } = await sb.from('users').select('role, teacher_daily_g, teacher_last_g_date').eq('user_id', teacherId).maybeSingle();
  if (!u || u.role === 'Admin') return;
  const lastDate = u.teacher_last_g_date ? String(u.teacher_last_g_date).substring(0,10) : '';
  const usedG = lastDate === todayStr() ? (Number(u.teacher_daily_g) || 0) : 0;
  await sb.from('users').update({
    teacher_daily_g: usedG + amount,
    teacher_last_g_date: todayStr()
  }).eq('user_id', teacherId);
}

async function notify(sb, userId, type, message) {
  try { await sb.from('notifications').insert({ user_id: userId, type, message }); } catch {}
}

// mirror: giveRewardCoins(teacherId, studentId, amount) — ครูแจก gold ทีละคน
async function giveRewardCoins(ctx, teacherId, studentId, amount) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const tid = teacherId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && tid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');
  if (!['Teacher','Admin'].includes(ctx.user.role)) return fail('สิทธิ์ไม่เพียงพอ');

  const amt = Number(amount);
  if (!isFinite(amt) || amt <= 0) return fail('จำนวนไม่ถูกต้อง');

  const sb = getSupabase();
  const quota = await getTeacherQuota(ctx, tid);
  if (!quota.isUnlimited && quota.quota < amt) return fail('โควต้าแจกเหรียญของวันนี้ไม่พอ');

  if (!quota.isUnlimited) await consumeTeacherQuota(sb, tid, amt);

  const ps = await getOrCreatePetStats(sb, studentId);
  await sb.from('pet_stats').update({
    free_coins: (Number(ps.free_coins) || 0) + amt,
    updated_at: new Date().toISOString()
  }).eq('user_id', studentId);

  await notify(sb, studentId, 'coin', `คุณได้รับรางวัล <b>${amt} Gold</b> จากคุณครู!`);
  return ok({ message: `มอบ ${amt} Gold ให้นักเรียนเรียบร้อยแล้ว` });
}

// mirror: giveBulkRewardCoins(adminId, targetType, targetValue, amount)
//   targetType: 'all' | 'class' (ใช้ grade เป็น targetValue)
async function giveBulkRewardCoins(ctx, adminId, targetType, targetValue, amount) {
  if (!ctx.user || ctx.user.role !== 'Admin') return fail('สิทธิ์ถูกปฏิเสธ (ระบบนี้สำหรับแอดมินเท่านั้น)');
  const amt = Number(amount);
  if (!isFinite(amt) || amt <= 0) return fail('จำนวนไม่ถูกต้อง');

  const sb = getSupabase();
  let q = sb.from('users').select('user_id, grade').eq('role', 'Student').eq('status', 'Active');
  const { data: students } = await q;
  const targets = (students || []).filter(s => {
    if (targetType === 'all') return true;
    if (targetType === 'class') return String(s.grade || '').trim() === String(targetValue).trim();
    return false;
  });
  if (targets.length === 0) return fail('ไม่พบนักเรียนในกลุ่มเป้าหมายนี้');

  // load existing pet_stats สำหรับ users ทั้งหมด
  const ids = targets.map(t => t.user_id);
  const { data: existing } = await sb.from('pet_stats').select('user_id, free_coins').in('user_id', ids);
  const existMap = {};
  (existing || []).forEach(r => { existMap[r.user_id] = r; });

  // upsert ทีละ user (Postgres rpc would be cleaner, but keep simple)
  const upserts = targets.map(t => ({
    user_id: t.user_id,
    free_coins: (existMap[t.user_id] ? Number(existMap[t.user_id].free_coins) || 0 : 0) + amt,
    updated_at: new Date().toISOString()
  }));
  const { error } = await sb.from('pet_stats').upsert(upserts, { onConflict: 'user_id' });
  if (error) return fail(error.message);

  // notify ทุกคน
  const notifs = targets.map(t => ({ user_id: t.user_id, type: 'coin', message: `คุณได้รับเงินอุดหนุน <b>${amt} Gold</b> จากระบบ!` }));
  if (notifs.length > 0) await sb.from('notifications').insert(notifs);

  return ok({ message: `แจก ${amt} Gold ให้นักเรียนจำนวน ${targets.length} คน เรียบร้อยแล้ว!` });
}

// mirror: adminGiveReward(adminId, targetUserId, rewardType, amount)
//   rewardType: 'gold' | 'exp' | 'souls'
async function adminGiveReward(ctx, adminId, targetUserId, rewardType, amount) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  const aid = adminId || ctx.user.userId;
  if (ctx.user.role !== 'Admin' && aid !== ctx.user.userId) return fail('สิทธิ์ไม่เพียงพอ');

  const amt = Number(amount);
  if (!isFinite(amt) || amt <= 0) return fail('จำนวนไม่ถูกต้อง');

  // EXP / Souls = Admin only
  if ((rewardType === 'exp' || rewardType === 'souls') && ctx.user.role !== 'Admin') {
    return fail('สิทธิ์ถูกปฏิเสธ: เฉพาะแอดมินเท่านั้นที่แจก EXP/Souls ได้');
  }

  const sb = getSupabase();

  // เช็ค & หักโควต้า (เฉพาะ gold + ครูที่ไม่ unlimited)
  if (rewardType === 'gold') {
    const quota = await getTeacherQuota(ctx, aid);
    if (!quota.isUnlimited && quota.quota < amt) return fail(`โควต้าแจก Gold ไม่พอ (เหลือ ${quota.quota} G)`);
    if (!quota.isUnlimited) await consumeTeacherQuota(sb, aid, amt);
  }

  const ps = await getOrCreatePetStats(sb, targetUserId);
  const updates = { updated_at: new Date().toISOString() };
  let notifMsg = '';

  if (rewardType === 'gold') {
    updates.free_coins = (Number(ps.free_coins) || 0) + amt;
    notifMsg = `คุณได้รับรางวัลพิเศษ <b>${amt} Gold</b>!`;
  } else if (rewardType === 'exp') {
    updates.exp_offset = (Number(ps.exp_offset) || 0) + amt;
    notifMsg = `คู่หูของคุณได้รับพลังพิเศษ <b>+${amt} EXP</b>!`;
  } else if (rewardType === 'souls') {
    updates.souls = (Number(ps.souls) || 0) + amt;
    notifMsg = `คุณได้รับ <b>+${amt} เศษวิญญาณ (Souls)</b>!`;
  } else {
    return fail('ประเภทรางวัลไม่ถูกต้อง');
  }

  await sb.from('pet_stats').update(updates).eq('user_id', targetUserId);
  await notify(sb, targetUserId, rewardType === 'gold' ? 'coin' : 'system', notifMsg);

  return ok({ message: `แจก ${amt} ${rewardType.toUpperCase()} สำเร็จ!` });
}

module.exports = {
  getTeacherQuota,
  giveRewardCoins,
  giveBulkRewardCoins,
  adminGiveReward
};
