const { getSupabase } = require('../_lib/supabase');
const { md5 } = require('../_lib/auth');
const { ok, fail } = require('../_lib/util');

function requireRole(ctx, roles) {
  if (!ctx.user) throw new Error('ต้องล็อกอิน');
  if (roles && !roles.includes(ctx.user.role)) throw new Error('สิทธิ์ไม่เพียงพอ');
}

function rowToUser(u) {
  return {
    UserID: u.user_id, Username: u.username || '', Role: u.role,
    Name: u.name, Email: u.email || '', Status: u.status,
    CitizenID: u.citizen_id || '', Grade: u.grade || '',
    CreatedAt: u.created_at
  };
}

// mirror: getAllUsers(currentUser) — เฉพาะ Admin/Teacher (student เรียก = []  เงียบ ๆ)
async function getAllUsers(ctx) {
  if (!ctx.user) return [];
  if (!['Admin','Teacher'].includes(ctx.user.role)) return [];
  const sb = getSupabase();
  const { data, error } = await sb.from('users')
    .select('*').order('created_at', { ascending: false });
  if (error) return [];
  return (data || []).map(rowToUser);
}

// mirror: approveUserAccount(userId)
async function approveUserAccount(ctx, userId) {
  requireRole(ctx, ['Admin']);
  const sb = getSupabase();
  const { error } = await sb.from('users').update({ status: 'Active' }).eq('user_id', userId);
  if (error) return fail(error.message);
  return ok({ message: 'เปิดใช้งานบัญชีสำเร็จ' });
}

// mirror: resetUserPassword(userId)
async function resetUserPassword(ctx, userId) {
  requireRole(ctx, ['Admin']);
  const sb = getSupabase();
  const { error } = await sb.from('users')
    .update({ password_hash: md5('1234'), status: 'Active' }).eq('user_id', userId);
  if (error) return fail(error.message);
  return ok({ message: 'รีเซ็ตรหัสผ่านเป็น 1234 แล้ว' });
}

// mirror: addStudentInAdvance(data)
async function addStudentInAdvance(ctx, data) {
  requireRole(ctx, ['Admin','Teacher']);
  if (!data || !data.name || !data.citizenId || !data.grade) return fail('ข้อมูลไม่ครบ');
  const sb = getSupabase();
  const cid = String(data.citizenId).trim();
  const { data: exist } = await sb.from('users').select('user_id').eq('citizen_id', cid).maybeSingle();
  if (exist) return fail('เลขประจำตัวประชาชนนี้ มีอยู่ในระบบแล้ว');

  const { error } = await sb.from('users').insert({
    role: 'Student', name: data.name, citizen_id: cid, grade: data.grade, status: 'Advance'
  });
  if (error) return fail(error.message);
  return ok({ message: 'เพิ่มนักเรียนเรียบร้อย' });
}

module.exports = { getAllUsers, approveUserAccount, resetUserPassword, addStudentInAdvance };
