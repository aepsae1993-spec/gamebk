const { getSupabase } = require('../_lib/supabase');
const { ok, fail } = require('../_lib/util');

// mirror: createSubject(data)
async function createSubject(ctx, data) {
  if (!ctx.user || !['Admin','Teacher'].includes(ctx.user.role)) return fail('สิทธิ์ไม่เพียงพอ');
  if (!data || !data.name || !data.classId) return fail('ข้อมูลไม่ครบ');
  const sb = getSupabase();
  const teacherId = data.teacherId || (ctx.user.role === 'Teacher' ? ctx.user.userId : null);
  const { error } = await sb.from('subjects').insert({
    subject_code: data.code || '',
    subject_name: data.name,
    class_id: data.classId,
    teacher_id: teacherId
  });
  if (error) return fail(error.message);
  return ok({ message: 'สร้างรายวิชาสำเร็จ' });
}

// mirror: getAllSubjects(user)
async function getAllSubjects(ctx) {
  const sb = getSupabase();
  const { data: subs } = await sb.from('subjects').select('*');
  if (!subs || subs.length === 0) return [];

  let user = ctx.user;
  let allowed = subs;
  if (user) {
    if (user.role === 'Student' && user.grade) {
      const { data: classes } = await sb.from('classes').select('class_id, class_name');
      const classMap = {};
      (classes || []).forEach(c => { classMap[c.class_id] = c.class_name || ''; });
      allowed = subs.filter(s => (classMap[s.class_id] || '').includes(user.grade));
    } else if (user.role === 'Teacher') {
      allowed = subs.filter(s => String(s.teacher_id || '') === String(user.userId));
    }
  }
  return allowed.map(s => ({
    SubjectID: s.subject_id, SubjectCode: s.subject_code || '',
    SubjectName: s.subject_name, ClassID: s.class_id || '', TeacherID: s.teacher_id || ''
  }));
}

module.exports = { createSubject, getAllSubjects };
