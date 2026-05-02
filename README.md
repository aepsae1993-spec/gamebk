# LMS Quest — Vercel + Supabase Edition

โปรเจกต์ที่ย้ายมาจาก Google Apps Script
- **Hosting + API**: Vercel (Serverless Functions)
- **Database**: Supabase Postgres
- **Auth**: Username/Password (MD5 + JWT) — เหมือนเดิม
- **รูปภาพในระบบ (Pet/Equip/Material)**: Google Drive (เก็บลิงก์ใน DB; แอดมินอัปโหลดเองแล้วเอาลิงก์มาใส่)
- **อัปโหลดงานนักเรียน → Drive**: Apps Script Web App ตัวเล็ก ๆ ทำหน้าที่เป็น "upload proxy" (ดูข้อ 3)

> ⚠️ **Phase 1** = LMS core เท่านั้น (ล็อกอิน, ผู้ใช้, ชั้นเรียน/วิชา/ภารกิจ, ส่งงาน, ตรวจคะแนน, ประกาศ, แจ้งเตือน, image dictionaries) ระบบเกม (สัตว์เลี้ยง/Inventory/Gacha/Market/Guild/Boss/PvP) จะมาใน Phase ถัดไป

---

## 0. โครงสร้างโปรเจกต์

```
lms-quest-web/
├── api/
│   ├── rpc.js                 ← single endpoint (POST /api/rpc {fn, args})
│   ├── _lib/                  ← supabase client, auth, util
│   └── _handlers/             ← business logic (1 ไฟล์ต่อ 1 หมวด)
├── public/
│   └── index.html             ← frontend (patched serverCall())
├── supabase/
│   └── schema.sql             ← รันใน Supabase SQL Editor
├── apps-script/
│   └── Code.gs                ← upload proxy (deploy เป็น Web App)
├── package.json
├── vercel.json
└── .env.example
```

---

## 1. ตั้งค่า Supabase

1. สร้างโปรเจกต์ใหม่ที่ <https://supabase.com>
2. ไปที่ **SQL Editor → New Query** → คัดลอกเนื้อหาทั้งหมดจาก `supabase/schema.sql` มาวาง → กด **Run**
3. ที่ **Settings → API** เก็บค่าทั้ง 2 ไว้:
    - `Project URL` → ใช้เป็น `SUPABASE_URL`
    - `service_role secret` → ใช้เป็น `SUPABASE_SERVICE_ROLE_KEY` ⚠️ **ห้ามเอาขึ้น GitHub เด็ดขาด**

หลังรันเสร็จระบบจะมีบัญชีแอดมินเริ่มต้น:
- username: `admin`
- password: `admin123`
- **เปลี่ยนทันทีหลังล็อกอินครั้งแรก**

---

## 2. ตั้งค่า Apps Script Drive Upload Proxy

ใช้ Apps Script เฉพาะ "อัปโหลดไฟล์งานนักเรียนไป Drive" อย่างเดียว — ส่วนอื่น Vercel + Supabase ทำหมด

1. ไปที่ <https://script.google.com> → New project
2. ลบเนื้อหา default แล้ว paste จาก `apps-script/Code.gs`
3. แก้ `DRIVE_ROOT_FOLDER_ID` ให้เป็น Folder ID ของโฟลเดอร์ที่จะเก็บงาน
   - หา ID จาก URL: `https://drive.google.com/drive/folders/<FOLDER_ID>`
4. กด **Deploy → New deployment**
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. คัดลอก **Web app URL** (รูปแบบ `https://script.google.com/macros/s/AKfy.../exec`)
6. เก็บลง Supabase: ไปที่ **Table Editor → settings** กด *Insert row*:
   - `key` = `drive_upload_url`
   - `value` = `"https://script.google.com/macros/s/AKfycbz-mD1vMsfLAaH0PNPpfsHJWWrAYhZsiyrkuw3HY_5DtI6-9bFQVF2eFe_kc6qeJgRH4w/exec"` (ใส่ในเครื่องหมายคำพูดเพราะเป็น JSON)
7. ทุกครั้งที่แก้ `Code.gs` ต้อง **Deploy → Manage deployments → Edit → New version**

> ⚠️ ครั้งแรกจะมี popup ให้อนุญาตสิทธิ์เข้าถึง Drive — กด *Advanced → Go to (unsafe)* ได้ เพราะเป็นสคริปต์ของคุณเอง

---

## 3. Push ขึ้น GitHub

```bash
cd lms-quest-web
git init
git add .
git commit -m "init: phase 1 LMS migration"
gh repo create lms-quest-web --private --source=. --remote=origin --push
# หรือสร้าง repo ใน github.com แล้ว
git remote add origin https://github.com/<you>/lms-quest-web.git
git branch -M main
git push -u origin main
```

---

## 4. Deploy บน Vercel

1. ไปที่ <https://vercel.com/new> → Import GitHub repo ที่เพิ่ง push
2. **Framework Preset**: Other (ไม่ต้องเลือก)
3. **Root Directory**: ปล่อยตามค่า default (root ของ repo)
4. **Build Command**: ปล่อยว่าง
5. **Output Directory**: `public`
6. ที่ **Environment Variables** กรอก 3 ค่าจาก `.env.example`:
    | Key | Value |
    |---|---|
    | `SUPABASE_URL` | `https://xxxxx.supabase.co` |
    | `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbGc...` (service_role) |
    | `JWT_SECRET` | สุ่มยาวๆ เช่น `openssl rand -hex 32` |
7. กด **Deploy** → รอประมาณ 1 นาที

เปิด URL ที่ Vercel ให้มา (เช่น `https://lms-quest-web.vercel.app`) → จะเห็นหน้าล็อกอิน

---

## 5. ทดสอบ Local (ทางเลือก)

```bash
npm install
npm install -g vercel
vercel login
vercel link              # เชื่อมโปรเจกต์กับ Vercel
vercel env pull .env     # ดึง env vars ลงเครื่อง
npm run dev              # ใช้ vercel dev (รันที่ localhost:3000)
```

---

## 6. การใช้งานหลัง deploy

### 6.1 ล็อกอินครั้งแรก (admin)
- เข้า `/` → ใส่ `admin / admin123`
- ไปที่หน้าจัดการผู้ใช้ → เปลี่ยนรหัสผ่านตัวเอง

### 6.2 เพิ่มนักเรียน (Workflow เดิม)
1. แอดมิน/ครู เพิ่มนักเรียนล่วงหน้า (ระบบจะตั้ง status = `Advance`)
2. นักเรียนเข้าหน้าสมัคร ใส่ `เลขประจำตัวประชาชน` ที่เพิ่มไว้ → ระบบจะ activate บัญชีให้

### 6.3 ใส่ลิงก์รูปภาพ (Drive)
ไปที่ Supabase **Table Editor** → เลือกตาราง:
- `pet_images` → ใส่ `stage1_url`...`stage5_url` ของแต่ละ `pet_type`
- `equip_images` → ใส่ `image_url`
- `material_images` → ใส่ `image_url`

ลิงก์ที่ใส่ต้องเป็นแบบ "ใครก็ดูได้" และเป็นรูปแบบ `https://drive.google.com/file/d/<FILE_ID>/view?...` — ระบบจะแปลงเป็น direct image link (`lh3.googleusercontent.com/d/<FILE_ID>`) ให้อัตโนมัติ

### 6.4 ส่งงาน (อัปโหลดไฟล์ → Drive ผ่าน Apps Script proxy)
นักเรียนเลือกไฟล์ + ใส่ลิงก์เพิ่มเติมได้ตามปกติ ระบบทำงาน 2 step:
1. Frontend → POST ไฟล์ base64 ไปที่ **Apps Script Web App** (URL อยู่ใน `settings.drive_upload_url`)
   - Apps Script สร้างโฟลเดอร์ตามชื่อภารกิจ + ชื่อนักเรียน → save ไฟล์
   - return URL ของไฟล์/โฟลเดอร์กลับ
2. Frontend → POST ลิงก์ที่รวมแล้ว ไปที่ `/api/rpc submitAssignmentWork` → บันทึกลง Supabase

ถ้าไม่ได้ตั้ง `drive_upload_url` แต่นักเรียนพยายามแนบไฟล์ → ระบบจะแจ้ง error ให้ติดต่อแอดมิน
(ถ้าส่งเฉพาะลิงก์ Google Drive ที่นักเรียนอัพเองมาเลยก็ใช้ได้ ไม่ต้องผ่าน proxy)

---

## 7. อะไรอยู่ใน Phase 2+

ฟังก์ชันใน `code.gs` เดิมที่ **ยังไม่ถูก migrate**:
- ระบบเกมทั้งหมด: PetStats, Inventory, Gacha, Enhance, Skills
- Market / PvP / Guild / Guild War / Guild Farm
- Weekly Boss / Daily Quest
- Leaderboard, Event multipliers

ฟังก์ชันที่หายไปจะตอบกลับ `404 Unknown fn: <name>` — frontend จะแสดง toast error

---

## 8. ไฟล์/ฟังก์ชันใน Phase 1

| Frontend เรียก (`serverCall`) | Backend handler |
|---|---|
| `loginUser`, `registerUser` | `_handlers/auth.js` |
| `getAllUsers`, `approveUserAccount`, `resetUserPassword`, `addStudentInAdvance` | `_handlers/users.js` |
| `getSettings`, `saveSettings` | `_handlers/settings.js` |
| `createClass`, `getAllClasses`, `getClassNameById` | `_handlers/classes.js` |
| `createSubject`, `getAllSubjects` | `_handlers/subjects.js` |
| `createAssignment`, `getAllAssignments` | `_handlers/assignments.js` |
| `submitAssignmentWork`, `getMySubmissions`, `getSubmissionsByAssignment`, `getStudentsForGrading`, `gradeSubmission`, `gradeSubmissionsBulk`, `exportSubjectGradesCSV` | `_handlers/submissions.js` |
| `createAnnouncement`, `getAnnouncements` | `_handlers/announcements.js` |
| `getNotifications`, `markNotificationRead`, `markAllNotificationsRead`, `deleteNotification` | `_handlers/notifications.js` |
| `getPetImagesDictionary`, `getEquipImagesDictionary`, `getMaterialImages`, `getPetConfigDictionary` | `_handlers/images.js` |

เพิ่มฟังก์ชันใหม่:
1. เขียน export ใน `api/_handlers/<file>.js`
2. (ถ้าเป็น file ใหม่) require เพิ่มใน `api/rpc.js`
3. ถ้าให้คนยังไม่ล็อกอินเรียกได้ → เพิ่มชื่อใน `PUBLIC_FNS` ใน `api/rpc.js`

---

## 9. ความปลอดภัย / หมายเหตุ

- `SUPABASE_SERVICE_ROLE_KEY` มีสิทธิ์ bypass RLS — เก็บใน Vercel env vars เท่านั้น **ห้าม** commit
- API ใช้ JWT 30 วัน เก็บใน `localStorage` → ถูกขโมยได้ถ้ามี XSS — ระวังการเอา HTML จากผู้ใช้มา render โดยไม่ escape
- MD5 hash อ่อนแอ (ตามของเดิม Apps Script) — Phase 2+ ควรเปลี่ยนเป็น bcrypt + migration script
- Vercel Hobby plan: timeout 30s, ไม่จำกัด invocation มาก — ใช้ได้กับโรงเรียน
