const { getSupabase } = require('../_lib/supabase');
const { md5, signToken } = require('../_lib/auth');
const { ok, fail } = require('../_lib/util');

// mirror: registerUser(data)
// Student: ต้องมี citizenId ที่ถูก addStudentInAdvance ไว้ก่อน (status='Advance')
// Teacher/Admin: สร้างใหม่ตรง ๆ
async function registerUser(_ctx, data) {
  if (!data || !data.username || !data.password || !data.role || !data.name) {
    return fail('ข้อมูลไม่ครบถ้วน');
  }
  const sb = getSupabase();

  // กัน username ซ้ำ
  const { data: existU } = await sb.from('users')
    .select('user_id').eq('username', data.username).maybeSingle();
  if (existU) return fail('ชื่อผู้ใช้นี้ถูกใช้ไปแล้ว');

  const pwdHex = md5(data.password);

  if (data.role === 'Student') {
    if (!data.citizenId) return fail('ต้องระบุเลขประจำตัวประชาชน');
    const { data: adv } = await sb.from('users')
      .select('user_id, status').eq('citizen_id', String(data.citizenId).trim()).maybeSingle();
    if (!adv) return fail('ไม่พบข้อมูลที่คุณครูเตรียมไว้ — กรุณาให้คุณครูเพิ่มชื่อก่อน');
    if (adv.status !== 'Advance') return fail('เลขประจำตัวประชาชนนี้ ถูกลงทะเบียนและเปิดใช้งานไปแล้ว');

    const { error } = await sb.from('users').update({
      username: data.username, password_hash: pwdHex, status: 'Active'
    }).eq('user_id', adv.user_id);
    if (error) return fail(error.message);
    return ok({ message: 'ลงทะเบียนสำเร็จ! ดึงข้อมูลสถานะจากที่คุณครูเตรียมไว้เรียบร้อย' });
  }

  // Teacher / Admin
  const { error } = await sb.from('users').insert({
    username: data.username,
    password_hash: pwdHex,
    role: data.role,
    name: data.name,
    email: data.email || null,
    status: 'Active'
  });
  if (error) return fail(error.message);
  return ok({ message: 'สมัครสมาชิกสำเร็จ' });
}

// mirror: loginUser(username, password)
async function loginUser(_ctx, username, password) {
  if (!username || !password) return fail('กรอกข้อมูลให้ครบ');
  const sb = getSupabase();
  const { data: u } = await sb.from('users')
    .select('*').eq('username', username).maybeSingle();
  if (!u) return fail('ไม่พบบัญชีนี้');
  if (u.status !== 'Active') return fail('บัญชีนี้ยังไม่เปิดใช้งาน');
  if (u.password_hash !== md5(password)) return fail('รหัสผ่านไม่ถูกต้อง');

  const userPayload = {
    userId: u.user_id, username: u.username, role: u.role,
    name: u.name, grade: u.grade, citizenId: u.citizen_id
  };
  const token = signToken(userPayload);
  return ok({ user: userPayload, token });
}

module.exports = { registerUser, loginUser };
