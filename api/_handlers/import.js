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
    label: 'Classes (ชั้นเรียน)',
    pk: 'class_id', kind: 'auto',
    cols: ['class_name','year','term']
  },
  subjects: {
    label: 'Subjects (รายวิชา)',
    pk: 'subject_id', kind: 'auto',
    cols: ['subject_code','subject_name','class_id','teacher_id']
  }
};

function requireAdmin(ctx) {
  if (!ctx.user || ctx.user.role !== 'Admin') throw new Error('สิทธิ์ไม่เพียงพอ (เฉพาะ Admin)');
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
  const cleaned = rows.map(r => {
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

  if (cleaned.length === 0) return fail('ข้อมูลทุกแถวว่าง — ตรวจ headers ให้ตรงกับคอลัมน์ที่อนุญาต');

  // ตรวจว่า natural PK ต้องมีค่า
  if (meta.kind === 'natural') {
    const missing = cleaned.findIndex(r => !r[meta.pk]);
    if (missing >= 0) return fail(`แถวที่ ${missing + 1} ขาดค่า ${meta.pk} (ต้องมีทุกแถว)`);
  }

  const sb = getSupabase();

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

  return ok({ count: cleaned.length, mode });
}

module.exports = { getImportTables, bulkImportTable };
