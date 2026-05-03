// ============================================================
// Bulk Import — รับข้อมูลที่ paste จาก Google Sheets / Excel
// แล้ว upsert ลง Supabase
// ============================================================
const { getSupabase } = require('../_lib/supabase');
const { ok, fail } = require('../_lib/util');

// whitelist ตาราง + คอลัมน์ที่อนุญาตให้ import
// natural = มี primary key เอง (รองรับ upsert/replace)
// auto    = PK auto-gen (รองรับ append เท่านั้น)
const TABLES = {
  pet_config: {
    label: 'PetConfig (สัตว์เลี้ยง: emoji + ชื่อ ตามเลเวล)',
    pk: 'pet_type', kind: 'natural',
    cols: ['pet_type','rarity','emoji1','emoji2','emoji3','emoji4','emoji5','name1','name2','name3','name4','name5']
  },
  pet_images: {
    label: 'PetImages (รูปสัตว์เลี้ยง 5 ร่าง)',
    pk: 'pet_type', kind: 'natural',
    cols: ['pet_type','stage1_url','stage2_url','stage3_url','stage4_url','stage5_url']
  },
  equip_images: {
    label: 'EquipImages (อุปกรณ์)',
    pk: 'equip_id', kind: 'natural',
    cols: ['equip_id','name','slot','rarity','image_url']
  },
  material_images: {
    label: 'MaterialImages (วัตถุดิบ)',
    pk: 'mat_key', kind: 'natural',
    cols: ['mat_key','name','image_url']
  },
  classes: {
    label: 'Classes (ชั้นเรียน — ใส่ class_id เดิมได้)',
    pk: 'class_id', kind: 'natural',
    cols: ['class_id','class_name','year','term']
  },
  subjects: {
    label: 'Subjects (รายวิชา — ใส่ subject_id เดิมได้)',
    pk: 'subject_id', kind: 'natural',
    cols: ['subject_id','subject_code','subject_name','class_id','teacher_id']
  },
  users: {
    label: 'Users (นักเรียน/ครู — รองรับนำเข้าจากชีทเดิม / ใส่ user_id เดิมได้)',
    pk: 'user_id', kind: 'natural',
    // ลำดับตามชีทเดิม: UserID, Username, Password, Role, Name, Profile(=email/ว่าง), Status, CreatedAt, CitizenID, Grade, TeacherDailyG, TeacherLastGDate
    cols: ['user_id','username','password_hash','role','name','email','status','created_at','citizen_id','grade','teacher_daily_g','teacher_last_g_date']
  },
  assignments: {
    label: 'Assignments (ภารกิจ — ใส่ assign_id เดิมได้)',
    pk: 'assign_id', kind: 'natural',
    cols: ['assign_id','subject_id','title','due_date','max_score','bonus_gold']
  },
  announcements: {
    label: 'Announcements (ประกาศ — ใส่ id เดิมได้)',
    pk: 'id', kind: 'natural',
    cols: ['id','title','content','scope','author_id','author_name','created_at']
  },
  settings: {
    label: 'Settings (key-value — ค่า config ของระบบ)',
    pk: 'key', kind: 'natural',
    cols: ['key','value']
  }
};

function requireAdmin(ctx) {
  if (!ctx.user || ctx.user.role !== 'Admin') throw new Error('สิทธิ์ไม่เพียงพอ (เฉพาะ Admin)');
}

// แปลงวันที่หลายรูปแบบเป็น ISO 8601 (Postgres parse ได้)
//   - "2026-02-21" / "2026-02-21T20:12:00Z" → ปล่อยตามเดิม
//   - "21/2/2026, 20:12" / "21/2/2026 20:12" / "21/2/2026" → ISO
//   - parse ไม่ออก / empty → null (เพื่อให้ Postgres ใช้ default แทน error)
function parseFlexibleDate(s) {
  if (s === undefined || s === null) return null;
  if (s instanceof Date) return s.toISOString();
  if (typeof s !== 'string') return null;
  s = s.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s; // ISO already
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const day = m[1].padStart(2, '0');
    const mon = m[2].padStart(2, '0');
    const year = m[3];
    if (m[4]) {
      const hh = m[4].padStart(2, '0');
      const mm = m[5];
      const ss = (m[6] || '00').padStart(2, '0');
      return `${year}-${mon}-${day}T${hh}:${mm}:${ss}+07:00`;
    }
    return `${year}-${mon}-${day}`;
  }
  return null; // parse ไม่ออก → ไม่ใส่ค่า ดีกว่าสร้าง error
}

// คืน metadata ของตารางที่ import ได้ ให้ frontend ใช้ render dropdown
async function getImportTables(ctx) {
  requireAdmin(ctx);
  const out = {};
  Object.keys(TABLES).forEach(k => {
    out[k] = { label: TABLES[k].label, pk: TABLES[k].pk, kind: TABLES[k].kind, cols: TABLES[k].cols };
  });
  return out;
}

// payload: { table, mode, rows }
//  - rows: array ของ object ที่ frontend parse แล้ว { col1: 'v', col2: 'v' }
//  - mode: 'append' | 'upsert' | 'replace'
async function bulkImportTable(ctx, payload) {
  requireAdmin(ctx);
  if (!payload || !payload.table) return fail('ระบุตาราง');
  const meta = TABLES[payload.table];
  if (!meta) return fail('ตารางนี้ไม่อนุญาตให้ import: ' + payload.table);

  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (rows.length === 0) return fail('ไม่มีข้อมูล');

  let mode = String(payload.mode || 'upsert');
  if (meta.kind === 'auto' && mode !== 'append') mode = 'append';
  if (!['append','upsert','replace'].includes(mode)) mode = 'upsert';

  // sanitize: เก็บเฉพาะคอลัมน์ที่อนุญาต + ตัด empty
  let cleaned = rows.map(r => {
    const out = {};
    for (const c of meta.cols) {
      let v = r[c];
      if (v === undefined || v === null) continue;
      if (typeof v === 'string') v = v.trim();
      if (v === '') continue;
      out[c] = v;
    }
    return out;
  }).filter(o => Object.keys(o).length > 0);

  // ===== per-table preprocessing =====
  let autoClearedDuplicates = [];

  // users: default role='Student', status='Advance' + แปลงวันที่ Thai → ISO
  if (payload.table === 'users') {
    cleaned = cleaned.map(r => {
      if (!r.role) r.role = 'Student';
      if (!r.status) r.status = 'Advance';
      if (r.created_at) r.created_at = parseFlexibleDate(r.created_at);
      if (r.teacher_last_g_date) r.teacher_last_g_date = parseFlexibleDate(r.teacher_last_g_date);
      if (r.teacher_daily_g !== undefined) r.teacher_daily_g = Number(r.teacher_daily_g) || 0;
      // citizen_id / username / user_id ตัดช่องว่างหัวท้าย เผื่อมีจาก sheet
      if (r.citizen_id) r.citizen_id = String(r.citizen_id).trim();
      if (r.username)   r.username   = String(r.username).trim();
      if (r.user_id)    r.user_id    = String(r.user_id).trim();
      // ตัด field ที่เป็น null (จาก parseFlexibleDate กับค่าว่าง) ออก
      Object.keys(r).forEach(k => { if (r[k] === null) delete r[k]; });
      return r;
    });

    // dedup ภายในชุดข้อมูลที่ paste มา — keep "ตัวสุดท้าย" ถ้า user_id ซ้ำ
    const byUserId = new Map();
    cleaned.forEach((r, i) => {
      const k = r.user_id || ('__noid_' + i);
      byUserId.set(k, r);
    });
    cleaned = Array.from(byUserId.values());

    // ตรวจ duplicate ของ unique field (username, citizen_id) — auto-clear ตัวที่ซ้ำ (เก็บอันแรก)
    const seen = { username: new Map(), citizen_id: new Map() };
    cleaned.forEach((r, i) => {
      ['username', 'citizen_id'].forEach(field => {
        if (r[field]) {
          if (seen[field].has(r[field])) {
            autoClearedDuplicates.push(`${field}="${r[field]}" (เคลียร์แถว ${i + 1} "${r.name || ''}", เก็บแถว ${seen[field].get(r[field]) + 1})`);
            delete r[field];
          } else {
            seen[field].set(r[field], i);
          }
        }
      });
    });
  }

  // assignments: แปลง due_date ที่อาจเป็น Thai format → ISO
  if (payload.table === 'assignments') {
    cleaned = cleaned.map(r => {
      if (r.due_date) r.due_date = parseFlexibleDate(r.due_date);
      if (r.max_score !== undefined) r.max_score = Number(r.max_score) || 0;
      if (r.bonus_gold !== undefined) r.bonus_gold = Number(r.bonus_gold) || 0;
      Object.keys(r).forEach(k => { if (r[k] === null) delete r[k]; });
      return r;
    });
  }

  // settings: แปลง value string เป็น JSON value (number/boolean/object) ถ้าทำได้
  if (payload.table === 'settings') {
    cleaned = cleaned.map(r => {
      if (typeof r.value === 'string') {
        const s = r.value.trim();
        // ลอง parse เป็น JSON ก่อน
        try {
          r.value = JSON.parse(s);
        } catch {
          // ถ้าไม่ใช่ JSON valid → ตรวจ true/false/number ด้วยมือ
          const lower = s.toLowerCase();
          if (lower === 'true') r.value = true;
          else if (lower === 'false') r.value = false;
          else if (s !== '' && !isNaN(s)) r.value = Number(s);
          else r.value = s;
        }
      }
      return r;
    });
  }

  if (cleaned.length === 0) return fail('ข้อมูลทุกแถวว่าง — ตรวจ headers ให้ตรงกับคอลัมน์ที่อนุญาต');

  // PK ต้องมีค่าเฉพาะเมื่อใช้ upsert (เพราะต้องใช้ระบุ conflict)
  // append/replace → ปล่อย DB ใส่ default ให้ได้ ถ้ามี
  if (meta.kind === 'natural' && mode === 'upsert') {
    const missing = cleaned.findIndex(r => !r[meta.pk]);
    if (missing >= 0) return fail(`แถวที่ ${missing + 1} ขาดค่า ${meta.pk} (โหมด upsert ต้องมีทุกแถว)`);
  }
  // ถ้ามีบาง row PK ว่าง ตอน append → ลบ key ออกให้ DB default ทำงาน
  if (meta.kind === 'natural' && mode !== 'upsert') {
    cleaned.forEach(r => { if (!r[meta.pk]) delete r[meta.pk]; });
  }

  const sb = getSupabase();

  // === users upsert: เคลียร์ row เดิมที่ unique field (username/citizen_id) ซ้ำกับชุดใหม่ก่อน
  // ป้องกัน upsert by user_id ชนกับ unique constraint อื่น
  let preDeleted = 0;
  if (payload.table === 'users' && (mode === 'upsert' || mode === 'replace')) {
    const incomingUserIds = new Set(cleaned.map(r => r.user_id).filter(Boolean));
    const incomingUsernames = cleaned.map(r => r.username).filter(Boolean);
    const incomingCitizenIds = cleaned.map(r => r.citizen_id).filter(Boolean);

    async function clearConflict(field, values) {
      if (values.length === 0) return null;
      // batch ทีละ 100 ค่า ป้องกัน URL ยาวเกินสำหรับ sheet ใหญ่ ๆ
      const all = [];
      for (let i = 0; i < values.length; i += 100) {
        const batch = values.slice(i, i + 100);
        const { data: rows, error } = await sb.from('users').select('user_id, ' + field).in(field, batch);
        if (error) return 'Query เพื่อหา conflict ล้มเหลว (' + field + '): ' + error.message;
        all.push(...(rows || []));
      }
      const conflictIds = all
        .map(r => r.user_id)
        .filter(id => !incomingUserIds.has(id));
      if (conflictIds.length > 0) {
        for (let i = 0; i < conflictIds.length; i += 100) {
          const batch = conflictIds.slice(i, i + 100);
          const { error: delErr } = await sb.from('users').delete().in('user_id', batch);
          if (delErr) return 'ลบ row ที่ conflict (' + field + ') ล้มเหลว: ' + delErr.message;
          preDeleted += batch.length;
        }
      }
      return null;
    }
    let err = await clearConflict('username', incomingUsernames);
    if (err) return fail(err);
    err = await clearConflict('citizen_id', incomingCitizenIds);
    if (err) return fail(err);
  }

  // mode = replace → ลบหมดแล้วค่อย insert
  if (mode === 'replace') {
    const { error: delErr } = await sb.from(payload.table).delete().not(meta.pk, 'is', null);
    if (delErr) return fail('ลบข้อมูลเดิมไม่สำเร็จ: ' + delErr.message);
  }

  if (mode === 'upsert' || mode === 'replace') {
    const { error } = await sb.from(payload.table).upsert(cleaned, { onConflict: meta.pk });
    if (error) return fail('Upsert ล้มเหลว: ' + error.message);
  } else {
    // append
    const { error } = await sb.from(payload.table).insert(cleaned);
    if (error) return fail('Insert ล้มเหลว: ' + error.message);
  }

  return ok({
    count: cleaned.length,
    mode,
    preDeleted,
    autoClearedDuplicates: autoClearedDuplicates.length > 0 ? autoClearedDuplicates : undefined
  });
}

module.exports = { getImportTables, bulkImportTable };
