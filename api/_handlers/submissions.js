const { getSupabase } = require('../_lib/supabase');
const { ok, fail } = require('../_lib/util');

function safe(v) { return v === null || v === undefined ? '' : String(v); }

function rowToSub(r) {
  // Apps Script เดิมแยก WorkLink เป็น 2 ส่วน: link ของนักเรียน | drive link
  let raw = safe(r.work_link);
  let studentLink = '', driveLink = '';
  if (raw.includes(' | ')) {
    const parts = raw.split(' | ');
    studentLink = parts[0]; driveLink = parts[1];
  } else if (raw.includes('drive.google.com') || raw.includes('docs.google.com')) {
    driveLink = raw;
  } else {
    studentLink = raw;
  }
  return {
    SubID: r.sub_id, AssignID: r.assign_id, StudentID: r.student_id,
    StudentName: safe(r.student_name),
    WorkLink: driveLink, Link: studentLink,
    Note: safe(r.note),
    Score: r.score === null || r.score === undefined ? '' : String(r.score),
    Feedback: safe(r.feedback)
  };
}

// mirror: submitAssignmentWork(data)  — student ส่งงาน (link-only ใน Phase 1)
async function submitAssignmentWork(ctx, data) {
  if (!ctx.user) return fail('ต้องล็อกอิน');
  if (!data || !data.assignId) return fail('ข้อมูลไม่ครบ');
  const sb = getSupabase();
  const studentId = ctx.user.role === 'Student' ? ctx.user.userId : (data.studentId || ctx.user.userId);
  const studentName = data.studentName || ctx.user.name;
  const workLink = data.workLink || data.link || '';

  // upsert ตาม unique (assign_id, student_id)
  const { data: ups, error } = await sb.from('submissions').upsert({
    assign_id: data.assignId,
    student_id: studentId,
    student_name: studentName,
    work_link: workLink,
    note: data.note || ''
  }, { onConflict: 'assign_id,student_id' }).select('sub_id').single();
  if (error) return fail(error.message);

  // แจ้งเตือนครูเจ้าของวิชา
  try {
    const { data: a } = await sb.from('assignments').select('subject_id, title').eq('assign_id', data.assignId).maybeSingle();
    if (a) {
      const { data: s } = await sb.from('subjects').select('teacher_id').eq('subject_id', a.subject_id).maybeSingle();
      if (s && s.teacher_id) {
        await sb.from('notifications').insert({
          user_id: s.teacher_id, type: 'submit',
          message: `<b>${studentName}</b> ส่งผลงานใหม่: ${a.title}`
        });
      }
    }
  } catch {}

  return ok({ message: 'ส่งผลงานเรียบร้อย', subId: ups.sub_id });
}

// mirror: getMySubmissions(studentId)
async function getMySubmissions(ctx, studentId) {
  const sid = studentId || (ctx.user && ctx.user.userId);
  if (!sid) return [];
  const sb = getSupabase();
  const { data } = await sb.from('submissions').select('*').eq('student_id', sid);
  return (data || []).map(r => ({
    SubID: r.sub_id,
    AssignID: r.assign_id,
    Score: r.score === null || r.score === undefined ? '' : String(r.score),
    Feedback: safe(r.feedback)
  }));
}

// mirror: getSubmissionsByAssignment(assignId)
async function getSubmissionsByAssignment(_ctx, assignId) {
  if (!assignId) return [];
  const sb = getSupabase();
  const { data } = await sb.from('submissions').select('*').eq('assign_id', assignId);
  return (data || []).map(rowToSub);
}

// mirror: getStudentsForGrading(assignId)
async function getStudentsForGrading(_ctx, assignId) {
  if (!assignId) return [];
  const sb = getSupabase();
  const { data: a } = await sb.from('assignments').select('subject_id').eq('assign_id', assignId).maybeSingle();
  if (!a) return [];
  const { data: subj } = await sb.from('subjects').select('class_id').eq('subject_id', a.subject_id).maybeSingle();
  if (!subj || !subj.class_id) return [];
  const { data: cls } = await sb.from('classes').select('class_name').eq('class_id', subj.class_id).maybeSingle();
  const className = cls ? cls.class_name : '';
  if (!className) return [];

  const { data: students } = await sb.from('users')
    .select('user_id, name, grade').eq('role', 'Student').eq('status', 'Active');
  const targets = (students || []).filter(s => s.grade && className.includes(s.grade));

  const { data: subs } = await sb.from('submissions').select('*').eq('assign_id', assignId);
  const subMap = {};
  (subs || []).forEach(r => { subMap[r.student_id] = rowToSub(r); });

  return targets.map(s => subMap[s.user_id] || ({
    SubID: '', AssignID: assignId, StudentID: s.user_id, StudentName: s.name,
    WorkLink: '', Link: '', Note: '', Score: '', Feedback: ''
  }));
}

// mirror: gradeSubmission(data)
async function gradeSubmission(ctx, data) {
  if (!ctx.user || !['Admin','Teacher'].includes(ctx.user.role)) return fail('สิทธิ์ไม่เพียงพอ');
  if (!data) return fail('ข้อมูลไม่ครบ');
  const sb = getSupabase();
  const graderId = data.graderId || ctx.user.userId;

  if (data.subId) {
    const { error } = await sb.from('submissions').update({
      score: data.score, feedback: data.feedback || '', grader_id: graderId
    }).eq('sub_id', data.subId);
    if (error) return fail(error.message);
    return ok({ message: 'ให้คะแนนสำเร็จ', subId: data.subId });
  }

  // ไม่มี subId → upsert ตาม (assign_id, student_id)
  const { data: ups, error } = await sb.from('submissions').upsert({
    assign_id: data.assignId,
    student_id: data.studentId,
    student_name: data.studentName || '',
    work_link: data.workLink || '',
    score: data.score, feedback: data.feedback || '', grader_id: graderId
  }, { onConflict: 'assign_id,student_id' }).select('sub_id').single();
  if (error) return fail(error.message);
  return ok({ subId: ups.sub_id });
}

// mirror: gradeSubmissionsBulk(payloads)
async function gradeSubmissionsBulk(ctx, payloads) {
  if (!Array.isArray(payloads) || payloads.length === 0) return fail('ไม่มีข้อมูล');
  for (const p of payloads) {
    const r = await gradeSubmission(ctx, p);
    if (!r || r.success === false) return r;
  }
  return ok({ message: 'บันทึกข้อมูลคะแนนทั้งหมดสำเร็จ' });
}

// mirror: exportSubjectGradesCSV(subjectId)
async function exportSubjectGradesCSV(ctx, subjectId) {
  if (!ctx.user || !['Admin','Teacher'].includes(ctx.user.role)) return fail('สิทธิ์ไม่เพียงพอ');
  if (!subjectId) return fail('ระบุรายวิชา');
  const sb = getSupabase();
  const { data: subj } = await sb.from('subjects').select('subject_name, class_id').eq('subject_id', subjectId).maybeSingle();
  if (!subj) return fail('ไม่พบรายวิชา');
  const { data: cls } = await sb.from('classes').select('class_name').eq('class_id', subj.class_id).maybeSingle();
  const className = cls ? cls.class_name : '';

  const { data: studentsAll } = await sb.from('users')
    .select('user_id, name, grade').eq('role', 'Student');
  const students = (studentsAll || []).filter(s => s.grade && className.includes(s.grade));

  const { data: assignments } = await sb.from('assignments')
    .select('assign_id, title').eq('subject_id', subjectId).order('created_at', { ascending: true });

  const { data: subs } = await sb.from('submissions').select('assign_id, student_id, score');
  const map = {};
  (subs || []).forEach(r => { map[r.assign_id + '|' + r.student_id] = r.score; });

  let csv = '﻿Student ID,Student Name';
  (assignments || []).forEach(a => { csv += ',' + a.title.replace(/,/g, ' ') + ' (Score)'; });
  csv += '\n';
  students.forEach(s => {
    let row = `"${s.user_id}","${s.name}"`;
    (assignments || []).forEach(a => {
      const v = map[a.assign_id + '|' + s.user_id];
      row += `,"${v === undefined || v === null ? '' : v}"`;
    });
    csv += row + '\n';
  });
  return ok({ csv, filename: `Grades_ALL_${subj.subject_name}.csv` });
}

module.exports = {
  submitAssignmentWork,
  getMySubmissions,
  getSubmissionsByAssignment,
  getStudentsForGrading,
  gradeSubmission,
  gradeSubmissionsBulk,
  exportSubjectGradesCSV
};
