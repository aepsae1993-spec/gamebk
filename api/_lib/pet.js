// ============================================================
// Pet/Player level math (mirror code.gs เดิม)
// ============================================================

// Player level: exp 100 → 140 → 196 → ... (×1.4)
function calculateLevelAndExp(totalExp) {
  let exp = totalExp < 0 ? 0 : totalExp;
  let level = 1;
  let reqExp = 100;
  while (true) {
    const cur = Math.floor(reqExp);
    if (exp >= cur) { exp -= cur; level++; reqExp *= 1.4; }
    else return { level, currentExp: Math.floor(exp), maxExp: cur };
  }
}

function calculateMaxHp(level) { return level * 50; }

// Pet level: 3-stage formula
//   Lv.1-30:  reqExp = 1000 + (level-1)*500
//   Lv.31-60: reqExp = 1000 + 29*500 + (level-30)*350
//   Lv.61-100: reqExp = 1000 + 29*500 + 30*350 + (level-60)*200
function getPetExpRequired(level) {
  if (level <= 30) return 1000 + (level - 1) * 500;
  if (level <= 60) return 1000 + 29 * 500 + (level - 30) * 350;
  return 1000 + 29 * 500 + 30 * 350 + (level - 60) * 200;
}

function calculatePetLevelFromExp(petExp) {
  let exp = Math.max(0, petExp || 0);
  let level = 1;
  while (level < 100) {
    const req = getPetExpRequired(level);
    if (exp >= req) { exp -= req; level++; }
    else return { petLevel: level, currentPetExp: Math.floor(exp), maxPetExp: req };
  }
  return { petLevel: 100, currentPetExp: Math.floor(exp), maxPetExp: getPetExpRequired(100) };
}

// คำนวณ base exp/coins ของ user จาก submissions
//   ส่งงาน 1 ครั้ง: +20 exp, +50 coins
//   ได้คะแนน 1 หน่วย: +5 exp, +10 coins
function calcUserBaseFromSubmissions(submissions) {
  let exp = 0, coins = 0;
  for (const s of submissions) {
    exp += 20;
    coins += 50;
    if (s.score !== null && s.score !== undefined && s.score !== '') {
      const sc = Number(s.score);
      if (!isNaN(sc)) {
        exp += sc * 5;
        coins += sc * 10;
      }
    }
  }
  return { exp, coins };
}

// คำนวณ HP enhance bonus (% เพิ่มจาก enhance level)
//   +1-10:  5%/lv,  +11-14: 7%/lv, +15-17: 10%/lv, +18-20: 15%/lv
function calcEnhanceHpBonus(enhanceLevel) {
  let bonus = 0;
  for (let e = 1; e <= enhanceLevel; e++) {
    if (e <= 10) bonus += 0.05;
    else if (e <= 14) bonus += 0.07;
    else if (e <= 17) bonus += 0.10;
    else bonus += 0.15;
  }
  return bonus;
}

module.exports = {
  calculateLevelAndExp,
  calculateMaxHp,
  getPetExpRequired,
  calculatePetLevelFromExp,
  calcUserBaseFromSubmissions,
  calcEnhanceHpBonus
};
