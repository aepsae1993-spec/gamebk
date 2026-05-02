const { getSupabase } = require('../_lib/supabase');
const { ok, fail, dateStr } = require('../_lib/util');
const { getAllSubjects } = require('./subjects');

// mirror: createAssignment(data) — สร้าง notification ให้นักเรียนในชั้นเรียนของวิชานั้น
async function createAssignment(ctx, data) {
  if (!ctx.user || !['Admin','Teacher'].includes(ctx.user.role)) return fail('สิทธิ์ไม่เพียงพอ');
  if (!data || !data.subjectId || !data.title) return fail('ข้อมูลไม่ครบ');
  const sb = getSupabase();
  const { data: ins, error } = await sb.from('assignments').insert({
    subject_id: data.subjectId,
    title: data.title,
    due_date: data.dueDate || null,
    max_score: Number(data.maxScore) || 10,
    bonus_gold: Number(data.bonusGold) || 0
  }).select('assign_id').single();
  if (error) return fail(error.message);

  // แจ้งเตือนนักเรียนในชั้นเรียน
  try {
    const { data: subj } = await sb.from('subjects').select('class_id').eq('subject_id', data.subjectId).maybeSingle();
    if (subj && subj.class_id) {
      const { data: cls } = await sb.from('classes').select('class_name').eq('class_id', subj.class_id).maybeSingle();
      const className = cls ? cls.class_name : '';
      if (className) {
        const { data: students } = await sb.from('users')
          .select('user_id, grade').eq('role', 'Student').eq('status', 'Active');
        const targets = (students || []).filter(s => s.grade && className.includes(s.grade));
        if (targets.length > 0) {
          const rows = targets.map(s => ({
            user_id: s.user_id, type: 'assignment',
            message: `มี Quest ใหม่: <b>${data.title}</b> กำหนดส่ง ${data.dueDate || '-'}`
          }));
          await sb.from('notifications').insert(rows);
        }
      }
    }
  } catch {}

  return ok({ message: 'สร้างภารกิจสำเร็จ', assignId: ins.assign_id });
}

// mirror: getAllAssignments(user, page, pageSize)
async function getAllAssignments(ctx, page, pageSize) {
  const subjects = await getAllSubjects(ctx);
  const allowedIds = subjects.map(s => s.SubjectID);
  if (allowedIds.length === 0) {
    return page ? { items: [], total: 0, page: 1, totalPages: 0 } : [];
  }
  const sb = getSupabase();
  const { data } = await sb.from('assignments')
    .select('*').in('subject_id', allowedIds).order('created_at', { ascending: false });
  const all = (data || []).map(a => ({
    AssignID: a.assign_id, SubjectID: a.subject_id, Title: a.title,
    DueDate: dateStr(a.due_date), MaxScore: a.max_score, BonusGold: a.bonus_gold || 0
  }));
  if (!page) return all;
  const pg = Math.max(1, parseInt(page) || 1);
  const ps = Math.max(1, Math.min(50, parseInt(pageSize) || 20));
  const start = (pg - 1) * ps;
  return {
    items: all.slice(start, start + ps),
    total: all.length, page: pg, pageSize: ps,
    totalPages: Math.ceil(all.length / ps)
  };
}

module.exports = { createAssignment, getAllAssignments };
