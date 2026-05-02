-- ============================================================
-- LMS Quest - Supabase Schema (Phase 1: LMS Core)
-- ============================================================
-- รันสคริปต์นี้ใน Supabase SQL Editor (Settings > SQL Editor > New Query)
-- ใช้ snake_case ใน DB; layer API จะ map เป็นชื่อเดิม (UserID, ClassID, ...) ให้ frontend
-- ============================================================

-- Extension สำหรับ uuid_generate_v4 / gen_random_uuid (Supabase มี pgcrypto อยู่แล้ว)
create extension if not exists "pgcrypto";

-- ============================================================
-- USERS
-- ============================================================
create table if not exists users (
    user_id           text primary key default ('U-' || substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    username          text unique,
    password_hash     text,                        -- MD5 hex (เหมือน Apps Script เดิม)
    role              text not null check (role in ('Admin','Teacher','Student')),
    name              text not null,
    email             text,
    status            text not null default 'Active' check (status in ('Active','Advance','Disabled')),
    citizen_id        text,
    grade             text,
    teacher_daily_g   integer default 0,
    teacher_last_g_date date,
    created_at        timestamptz not null default now()
);

create unique index if not exists users_citizen_id_unique
    on users (citizen_id) where citizen_id is not null and citizen_id <> '';

-- ============================================================
-- SETTINGS (key-value)
-- ============================================================
create table if not exists settings (
    key       text primary key,
    value     jsonb,
    updated_at timestamptz not null default now()
);

-- ============================================================
-- CLASSES
-- ============================================================
create table if not exists classes (
    class_id    text primary key default ('C-' || substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    class_name  text not null,
    year        text,
    term        text,
    created_at  timestamptz not null default now()
);

-- ============================================================
-- SUBJECTS
-- ============================================================
create table if not exists subjects (
    subject_id    text primary key default ('S-' || substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    subject_code  text,
    subject_name  text not null,
    class_id      text references classes(class_id) on delete set null,
    teacher_id    text references users(user_id) on delete set null,
    created_at    timestamptz not null default now()
);

create index if not exists subjects_class_id_idx on subjects(class_id);
create index if not exists subjects_teacher_id_idx on subjects(teacher_id);

-- ============================================================
-- ASSIGNMENTS
-- ============================================================
create table if not exists assignments (
    assign_id    text primary key default ('A-' || substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    subject_id   text not null references subjects(subject_id) on delete cascade,
    title        text not null,
    due_date     date,
    max_score    integer default 10,
    bonus_gold   integer default 0,
    created_at   timestamptz not null default now()
);

create index if not exists assignments_subject_id_idx on assignments(subject_id);

-- ============================================================
-- SUBMISSIONS
-- ============================================================
create table if not exists submissions (
    sub_id       text primary key default ('SUB-' || substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    assign_id    text not null references assignments(assign_id) on delete cascade,
    student_id   text not null references users(user_id) on delete cascade,
    student_name text,
    work_link    text,
    note         text,
    score        numeric,
    feedback     text,
    grader_id    text,
    submit_date  timestamptz not null default now(),
    constraint submissions_unique_per_student unique (assign_id, student_id)
);

create index if not exists submissions_assign_idx on submissions(assign_id);
create index if not exists submissions_student_idx on submissions(student_id);

-- ============================================================
-- ANNOUNCEMENTS
-- ============================================================
create table if not exists announcements (
    id           text primary key default ('ANN-' || substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    title        text not null,
    content      text,
    scope        text default 'global',
    author_id    text,
    author_name  text,
    created_at   timestamptz not null default now()
);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
create table if not exists notifications (
    notif_id    text primary key default ('NOTIF-' || substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    user_id     text not null references users(user_id) on delete cascade,
    type        text,
    message     text,
    is_read     boolean default false,
    created_at  timestamptz not null default now()
);

create index if not exists notifications_user_idx on notifications(user_id, created_at desc);

-- ============================================================
-- IMAGE / CONFIG DICTIONARIES (admin paste Drive URLs here)
-- ============================================================
create table if not exists pet_images (
    pet_type    text primary key,
    stage1_url  text,
    stage2_url  text,
    stage3_url  text,
    stage4_url  text,
    stage5_url  text
);

create table if not exists equip_images (
    equip_id    text primary key,
    name        text,
    slot        text,
    rarity      text,
    image_url   text
);

create table if not exists material_images (
    mat_key     text primary key,
    name        text,
    image_url   text
);

create table if not exists pet_config (
    pet_type    text primary key,
    rarity      text default 'C',
    emoji1      text,
    emoji2      text,
    emoji3      text,
    emoji4      text,
    emoji5      text,
    name1       text,
    name2       text,
    name3       text,
    name4       text,
    name5       text
);

-- ============================================================
-- SEED — สร้างผู้ดูแลระบบเริ่มต้น
-- เปลี่ยน password ก่อน deploy! (default = 'admin123' MD5 hash)
-- ============================================================
insert into users (user_id, username, password_hash, role, name, status)
values (
    'U-admin0001',
    'admin',
    '0192023a7bbd73250516f069df18b500',  -- md5('admin123')
    'Admin',
    'ผู้ดูแลระบบ',
    'Active'
)
on conflict (user_id) do nothing;

-- ============================================================
-- SEED — image dictionaries (default rows; admin paste URLs later)
-- ============================================================
insert into pet_images (pet_type) values
    ('dog'),('cat'),('chicken'),('bird'),('mouse'),
    ('unicorn'),('kitsune'),('slime'),
    ('phoenix'),('cerberus'),('kraken'),
    ('dragon'),('monkeyking'),('mecha'),('naga'),('angel')
on conflict (pet_type) do nothing;

insert into material_images (mat_key, name) values
    ('mat_iron','แร่เหล็กกิล'),
    ('mat_leather','หนังสัตว์ประเสริฐ'),
    ('mat_gem','อัญมณีสงคราม'),
    ('mat_fabric','ผ้าเวทมนตร์'),
    ('mat_essence','แก่นพลังโบราณ')
on conflict (mat_key) do nothing;

insert into equip_images (equip_id, name, slot, rarity) values
    ('weapon_c','⚔️ ดาบเหล็กกิล','weapon','C'),
    ('armor_c','🛡️ เกราะหนังสัตว์','armor','C'),
    ('necklace_c','📿 สร้อยอัญมณี','necklace','C'),
    ('ring_c','💍 แหวนพลัง','ring','C'),
    ('shoes_c','👟 รองเท้าเวท','shoes','C'),
    ('weapon_r','⚔️ ดาบมังกรเหล็ก','weapon','R'),
    ('armor_r','🛡️ เกราะมังกร','armor','R'),
    ('necklace_r','📿 สร้อยจันทรา','necklace','R'),
    ('ring_r','💍 แหวนสายฟ้า','ring','R'),
    ('shoes_r','👟 รองเท้าสายลม','shoes','R'),
    ('weapon_sr','⚔️ ดาบเพลิงนรก','weapon','SR'),
    ('armor_sr','🛡️ เกราะจักรพรรดิ','armor','SR'),
    ('necklace_sr','📿 สร้อยดาวตก','necklace','SR'),
    ('ring_sr','💍 แหวนราชัน','ring','SR'),
    ('shoes_sr','👟 รองเท้าสุริยัน','shoes','SR'),
    ('weapon_ssr','⚔️ ดาบเทพสังหาร','weapon','SSR'),
    ('armor_ssr','🛡️ เกราะเทพสวรรค์','armor','SSR'),
    ('necklace_ssr','📿 สร้อยเทพจันทร์','necklace','SSR'),
    ('ring_ssr','💍 แหวนเทพเจ้า','ring','SSR'),
    ('shoes_ssr','👟 รองเท้าเทพพายุ','shoes','SSR'),
    ('weapon_ur','⚔️ ดาบพิฆาตเทพ','weapon','UR'),
    ('armor_ur','🛡️ เกราะจักรวาล','armor','UR'),
    ('necklace_ur','📿 สร้อยดวงดาว','necklace','UR'),
    ('ring_ur','💍 แหวนสรรพสิ่ง','ring','UR'),
    ('shoes_ur','👟 รองเท้าเวลา','shoes','UR')
on conflict (equip_id) do nothing;

insert into pet_config (pet_type, rarity, emoji1, emoji2, emoji3, emoji4, emoji5, name1, name2, name3, name4, name5) values
    ('dog','C','🐶','🐕','🦮','🐺','','ลูกหมา','หมาโต','หมานำทาง','หมาป่า',''),
    ('cat','C','🐱','🐈','🐈‍⬛','🦁','','ลูกแมว','แมวบ้าน','แมวดำ','สิงโต',''),
    ('chicken','C','🥚','🐥','🐓','🦖','','ไข่','ลูกเจี๊ยบ','พ่อไก่','ไดโนเสาร์',''),
    ('bird','C','🐣','🐦','🦜','🦅','','นกแรกเกิด','นกเล็ก','นกแก้ว','พญาอินทรี',''),
    ('mouse','C','🐭','🐹','🐿️','🦫','','หนูตัวจิ๋ว','แฮมสเตอร์','กระรอก','บีเวอร์',''),
    ('unicorn','R','🦄','🦄✨','🐎👼','👑🦄','','ลูกม้ายูนิคอร์น','ยูนิคอร์นฝึกหัด','เพกาซัส','ราชายูนิคอร์น',''),
    ('kitsune','R','🦊','🦊✨','🦊🔥','🦊👑','','ลูกจิ้งจอก','จิ้งจอกมนตรา','จิ้งจอกเพลิงเวท','จิ้งจอกเก้าหางสวรรค์',''),
    ('slime','R','💧','🍮','👾','👑💧','','หยดน้ำ','สไลม์เด้งดึ๋ง','สไลม์ยักษ์','ราชาสไลม์',''),
    ('phoenix','SR','🥚🔥','🐤🔥','🦩🔥','🦅🔥','','ไข่ฟีนิกซ์','ลูกนกเพลิง','นกฟีนิกซ์หนุ่ม','พญานกฟีนิกซ์อมตะ',''),
    ('cerberus','SR','🐶🔥','🐺🔥','🐺⛓️','🐺👹','','ลูกหมาไฟ','หมาป่าอัคคี','หมาป่าโซ่ตรวน','เซอร์เบอรัส 3 หัว',''),
    ('kraken','SR','🐟','🦑','🐙','🐙🌊','','ปลาตัวน้อย','หมึกยักษ์','อสูรหนวดทะลวง','จ้าวสมุทรคราเคน',''),
    ('dragon','SSR','🦎','🐍🔥','🐉','🐲👑','','กิ้งก่าจิ๋ว','งูยักษ์พ่นไฟ','มังกรฟ้า','จอมราชันย์มังกร',''),
    ('monkeyking','SSR','🐵','🐒','🥷🐵','🐵👑','','ลูกลิงซน','ลิงกังนักสู้','วานรพเนจร','ฉีเทียนต้าเซิ่ง (ราชาวานร)',''),
    ('mecha','SSR','🔋','🤖','⚙️🤖','🚀👾','','แบตเตอรี่จิ๋ว','หุ่นกระป๋อง','หุ่นรบหุ้มเกราะ','สุดยอดหุ่นรบกันดั้ม',''),
    ('naga','SSR','🐍','🐍✨','🐉🌊','👑🐉','','งูน้อย','งูจงอางเผือก','มังกรน้ำ','องค์พญานาคราช',''),
    ('angel','UR','👼','😇✨','👼🕊️','⚜️👼','🌟👑👼','เทวฑูตน้อย','นักบุญฝึกหัด','เทพบุตรปีกเงิน','อัครเทวฑูต','เทวฑูตสวรรค์ชั้นสูงสุด')
on conflict (pet_type) do nothing;

-- ============================================================
-- DONE
-- หลังรันสคริปต์: เข้าระบบได้ด้วย admin / admin123
-- (เปลี่ยน password ทันทีหลัง login ครั้งแรก)
-- ============================================================
