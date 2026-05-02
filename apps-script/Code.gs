// ============================================================
// LMS Quest — Drive Upload Proxy (Apps Script Web App)
// ============================================================
// หน้าที่เดียว: รับไฟล์ base64 จาก frontend → save ลง Google Drive
// → return URL ของไฟล์/โฟลเดอร์กลับ
//
// Deploy: Apps Script → Deploy → New deployment → Web app
//   Execute as:    Me (your Google account)
//   Who has access: Anyone
// คัดลอก Web App URL → ใส่ในตาราง settings ของ Supabase: key='drive_upload_url'
// (หรือใส่ตรงในโค้ด frontend ก็ได้)
// ============================================================

// ✅ ใส่ Folder ID ของโฟลเดอร์ใน Drive ที่จะเก็บงานนักเรียน
const DRIVE_ROOT_FOLDER_ID = '1bPj-E9VZ1CD8l4CJ1f1smPCRkdr6h4Vh';

// ใช้ text/plain เพื่อหลบ CORS preflight (Apps Script web app รองรับ POST แบบนี้)
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents || '{}');
    if (!payload || !payload.action) {
      return _json({ success: false, message: 'missing action' });
    }
    if (payload.action === 'uploadStudentWork') {
      return _json(uploadStudentWork(payload));
    }
    return _json({ success: false, message: 'unknown action: ' + payload.action });
  } catch (err) {
    return _json({ success: false, message: 'Server error: ' + err.message });
  }
}

function doGet() {
  return ContentService
    .createTextOutput('LMS Quest Drive Upload Proxy is running.')
    .setMimeType(ContentService.MimeType.TEXT);
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// Upload student work files to Drive
// payload: {
//   assignTitle: string,
//   studentName: string,
//   studentId: string,
//   files: [ { name, base64 } ]   // base64 = "data:image/...;base64,xxxx"
// }
// returns: { success, files: [url], folderUrl }
// ============================================================
function uploadStudentWork(payload) {
  if (!payload.files || payload.files.length === 0) {
    return { success: true, files: [], folderUrl: '' };
  }

  const rootFolder = DriveApp.getFolderById(DRIVE_ROOT_FOLDER_ID);

  // โฟลเดอร์ของภารกิจ (สร้างถ้ายังไม่มี)
  const assignFolderName = payload.assignTitle || 'ภารกิจไม่ทราบชื่อ';
  let assignFolder;
  const aIter = rootFolder.getFoldersByName(assignFolderName);
  assignFolder = aIter.hasNext() ? aIter.next() : rootFolder.createFolder(assignFolderName);

  // โฟลเดอร์ของนักเรียน
  const studentFolderName = (payload.studentName || 'unknown') + ' (' + (payload.studentId || '-') + ')';
  let studentFolder;
  const sIter = assignFolder.getFoldersByName(studentFolderName);
  studentFolder = sIter.hasNext() ? sIter.next() : assignFolder.createFolder(studentFolderName);

  const savedUrls = [];
  for (let i = 0; i < payload.files.length; i++) {
    const f = payload.files[i];
    if (!f || !f.base64) continue;
    const idx = f.base64.indexOf('base64,');
    const contentType = idx >= 0 ? f.base64.substring(5, f.base64.indexOf(';')) : 'application/octet-stream';
    const dataPart = idx >= 0 ? f.base64.substr(idx + 7) : f.base64;
    const bytes = Utilities.base64Decode(dataPart);
    const blob = Utilities.newBlob(bytes, contentType, f.name || ('file_' + (i + 1)));
    const newFile = studentFolder.createFile(blob);
    savedUrls.push(newFile.getUrl());
  }

  return {
    success: true,
    files: savedUrls,
    folderUrl: studentFolder.getUrl()
  };
}
