const { getSupabase } = require('../_lib/supabase');
const { ok, fail } = require('../_lib/util');

// mirror: createClass(data)
async function createClass(ctx, data) {
  if (!ctx.user || !['Admin','Teacher'].includes(ctx.user.role)) return fail('สิทธิ์ไม่เพียงพอ');
  if (!data || !data.name) return fail('ระบุชื่อชั้นเรียน');
  const sb = getSupabase();
  const { error } = await sb.from('classes').insert({
    class_name: data.name, year: data.year || '', term: data.term || ''
  });
  if (error) return fail(error.message);
  return ok({ message: 'สร้างชั้นเรียนสำเร็จ' });
}

// mirror: getAllClasses()
async function getAllClasses() {
  const sb = getSupabase();
  const { data } = await sb.from('classes')
    .select('*').order('created_at', { ascending: true });
  return (data || []).map(c => ({
    ClassID: c.class_id, ClassName: c.class_name, Year: c.year || '', Term: c.term || ''
  }));
}

// mirror: getClassNameById(classId)
async function getClassNameById(_ctx, classId) {
  if (!classId) return '';
  const sb = getSupabase();
  const { data } = await sb.from('classes').select('class_name').eq('class_id', classId).maybeSingle();
  return data ? data.class_name : '';
}

module.exports = { createClass, getAllClasses, getClassNameById };
