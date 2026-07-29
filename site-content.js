/**
 * site-content.js v1.2 — window.postMessage 브릿지 제거
 * background.js의 chrome.scripting.executeScript 로 데이터 요청/반영
 */
'use strict';

function normStr(s) {
  return String(s||'').replace(/[\s\u3000_\-]+/g,'').toLowerCase();
}
function parseCCName(ccName) {
  const noNum    = ccName.replace(/^\d+[\.\-_\s]*/, '').trim();
  const bracketM = noNum.match(/\[([^\]]+)\]/);
  const bracket  = bracketM ? bracketM[1].trim() : '';
  const bookName = noNum.replace(/\[[^\]]*\]\s*/, '').trim();
  return { bracket, bookName };
}
function isKorean(s) { return /[가-힣]/.test(s); }

// ── 진도사이트 데이터 요청 (background → executeScript) ──
function getSiteData() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'GET_SITE_DATA' }, res => {
      if (chrome.runtime.lastError || !res?.ok) {
        console.warn('[htdev] getSiteData 실패:', chrome.runtime.lastError?.message, res?.error);
        resolve(null);
      } else {
        resolve(res);
      }
    });
  });
}

// ── 데이터 반영 요청 ──
function applyToSite(payload) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'APPLY_SITE_DATA', payload }, res => {
      if (chrome.runtime.lastError) {
        console.warn('[htdev] apply 실패:', chrome.runtime.lastError.message);
        resolve({ ok: false });
      } else {
        resolve(res || { ok: false });
      }
    });
  });
}

// ── 매칭 로직 ──
function matchCCToSite(ccName, siteData) {
  const { bracket, bookName } = parseCCName(ccName);
  const { books, classes, students } = siteData;
  const bkNorm = normStr(bookName), bracketN = normStr(bracket);
  const koreanInBracket = isKorean(bracket);

  let matchedCls = null;
  if (!koreanInBracket && bracket) {
    matchedCls = classes.find(c => normStr(c.name) === bracketN)
      || classes.find(c => bracketN.includes(normStr(c.name)) && normStr(c.name).length >= 1);
  }

  let matchedBk = null;
  // ★ 교재 검색 풀 결정
  // - 반 매칭: 해당 반 배정 교재에서만 검색
  // - 한글 브라켓(학생 이름): 반 미배정(학생만 배정) 교재에서만 검색
  // - 그 외: 전체 교재에서 검색
  let pool;
  if (matchedCls) {
    pool = books.filter(b => (b.classIds||[]).includes(matchedCls.id));
  } else if (koreanInBracket) {
    // [나현] 같이 학생 이름인 경우 → 반 미배정 교재에서만 검색
    pool = books.filter(b => !(b.classIds && b.classIds.length > 0));
  } else {
    pool = books;
  }
  for (const bk of pool) {
    const sn = normStr(bk.name);
    if (sn.length < 2) continue;
    if (bkNorm.includes(sn) || sn.includes(bkNorm)) {
      if (!matchedBk || bk.name.length > matchedBk.name.length) matchedBk = bk;
    }
  }

  let stuNames = [];
  if (koreanInBracket && !matchedCls) {
    // [나현] 같은 학생 이름 브라켓: 반이 없으면 학생배정 교재에서 검색
    stuNames = bracket.split(/[,，·、]+/).map(s=>s.trim()).filter(Boolean);

    if (!matchedBk) {
      // 학생배정 교재 (classIds 없는 교재)에서 교재명 + 학생명 매칭
      const noClsBks = books.filter(b => !(b.classIds&&b.classIds.length));
      for (const bk of noClsBks) {
        const sn = normStr(bk.name);
        if (!bkNorm.includes(sn) && !sn.includes(bkNorm)) continue;
        // 해당 교재에 배정된 학생 중 브라켓 이름과 일치하는지 확인
        const bkStus = (bk.studentIds||[]).map(id=>students.find(s=>s.id===id)).filter(Boolean);
        const hit = stuNames.some(sn2 => bkStus.some(s => {
          // 이름(성 제외) 또는 풀네임 매칭
          const stuGiven = s.name.length >= 3 ? s.name.slice(1) : s.name;
          return stuGiven === sn2 || s.name === sn2 || s.name.includes(sn2);
        }));
        if (hit) { matchedBk = bk; break; }
      }
    }
  }

  return {
    ccName, bracket, bookName,
    matchedCls, matchedBk, stuNames,
    matched: !!(matchedBk),
  };
}

// ══ UI 컴포넌트 ══
const PANEL_BASE = `position:fixed;z-index:999999;background:#fff;border-radius:16px;
  box-shadow:0 8px 40px rgba(0,0,0,.22);font-family:-apple-system,sans-serif;
  min-width:320px;max-width:92vw;`;

function removePanel() { document.getElementById('htdev-cc-panel')?.remove(); }

function showToast(msg, type='success') {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;bottom:30px;left:50%;transform:translateX(-50%);
    padding:12px 24px;border-radius:10px;font-size:14px;font-weight:700;color:#fff;
    z-index:999999;pointer-events:none;
    background:${type==='success'?'#059669':'#dc2626'};
    box-shadow:0 4px 20px rgba(0,0,0,.2);`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function makeDraggable(panel, hdrId) {
  const hdr = document.getElementById(hdrId);
  if (!hdr) return;
  let ox=0,oy=0,drag=false;
  hdr.addEventListener('mousedown', e => {
    if (e.target.tagName==='BUTTON') return;
    drag=true; ox=e.clientX-panel.offsetLeft; oy=e.clientY-panel.offsetTop;
    panel.style.right='auto'; e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    panel.style.left=Math.max(0,e.clientX-ox)+'px';
    panel.style.top=Math.max(0,e.clientY-oy)+'px';
  });
  document.addEventListener('mouseup', ()=>{ drag=false; });
}

// ── 클래스 선택 UI ──
function showClassSelect(classList) {
  removePanel();
  const panel = document.createElement('div');
  panel.id='htdev-cc-panel';
  panel.style.cssText = PANEL_BASE + 'top:80px;right:20px;max-height:80vh;display:flex;flex-direction:column;';
  panel.innerHTML = `
    <div id="htdev-cc-hdr" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);
         border-radius:16px 16px 0 0;padding:14px 16px;cursor:grab;flex-shrink:0">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-size:15px;font-weight:800;color:#fff">🃏 ClassCard 클래스 선택</div>
          <div style="font-size:11px;color:rgba(255,255,255,.8);margin-top:2px">Shift+클릭으로 범위 선택</div>
        </div>
        <button id="htdev-cc-close"
          style="background:rgba(255,255,255,.2);border:none;color:#fff;border-radius:8px;
                 padding:4px 10px;cursor:pointer;font-size:16px;font-weight:800">✕</button>
      </div>
    </div>
    <div style="display:flex;gap:6px;padding:10px 14px;border-bottom:1px solid #e5e7eb;flex-shrink:0">
      <button id="htdev-sel-all" style="flex:1;padding:6px;border-radius:7px;background:#e0e7ff;
        border:none;color:#4338ca;font-size:12px;font-weight:700;cursor:pointer">전체 선택</button>
      <button id="htdev-sel-none" style="flex:1;padding:6px;border-radius:7px;background:#f3f4f6;
        border:none;color:#6b7280;font-size:12px;font-weight:700;cursor:pointer">전체 해제</button>
    </div>
    <div id="htdev-cc-list" style="overflow-y:auto;flex:1;padding:8px 10px;display:flex;flex-direction:column;gap:4px;">
      ${classList.map((c,i) => `
        <label style="display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:9px;
                      background:#f9fafb;border:1px solid #e5e7eb;cursor:pointer">
          <input type="checkbox" data-idx="${i}" data-classid="${c.classId}"
            style="width:16px;height:16px;accent-color:#6366f1;cursor:pointer;flex-shrink:0">
          <span style="font-size:12px;font-weight:700;color:#111;overflow:hidden;
                       text-overflow:ellipsis;white-space:nowrap" title="${c.name}">${c.name}</span>
        </label>`).join('')}
    </div>
    <div style="padding:12px 14px;border-top:1px solid #e5e7eb;display:flex;gap:8px;flex-shrink:0">
      <button id="htdev-cc-cancel" style="flex:1;padding:11px;border-radius:9px;background:#f3f4f6;
        border:1px solid #e5e7eb;color:#6b7280;font-size:13px;font-weight:700;cursor:pointer">취소</button>
      <button id="htdev-cc-start" style="flex:2;padding:11px;border-radius:9px;
        background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;
        font-size:13px;font-weight:800;cursor:pointer;box-shadow:0 3px 10px rgba(99,102,241,.4)">
        ▶ 추출 시작</button>
    </div>`;
  document.body.appendChild(panel);

  let lastIdx = null;
  panel.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('click', e => {
      const idx = +cb.dataset.idx;
      if (e.shiftKey && lastIdx !== null) {
        const from=Math.min(idx,lastIdx), to=Math.max(idx,lastIdx);
        panel.querySelectorAll('input[type=checkbox]').forEach((b,i)=>{
          if(i>=from&&i<=to) b.checked=cb.checked;
        });
      }
      lastIdx = idx;
    });
  });

  document.getElementById('htdev-sel-all').onclick  = () => panel.querySelectorAll('input').forEach(b=>b.checked=true);
  document.getElementById('htdev-sel-none').onclick = () => panel.querySelectorAll('input').forEach(b=>b.checked=false);
  document.getElementById('htdev-cc-close').onclick  = removePanel;
  document.getElementById('htdev-cc-cancel').onclick = () => {
    chrome.runtime.sendMessage({ action: 'CANCEL' });
    removePanel();
  };
  document.getElementById('htdev-cc-start').onclick = () => {
    const selected = [];
    panel.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
      selected.push({ name: classList[+cb.dataset.idx].name, classId: cb.dataset.classid });
    });
    if (!selected.length) { alert('클래스를 하나 이상 선택해주세요.'); return; }
    showProgress(selected.length);
    chrome.runtime.sendMessage({ action: 'START_EXTRACTION', selected });
  };
  makeDraggable(panel, 'htdev-cc-hdr');
}

// ── 전역 추출 데이터 저장 ──
let _extractedResults = [];

// ── xlsx 저장 함수 ──
// ★ 페이지에 로드된 window.XLSX(SheetJS)를 background executeScript로 호출
//   → 공식 xlsx 형식 생성, 샘플 파일과 동일한 구조(시트명: 평가표)
function saveAsXlsx(result) {
  const COLS = ['세트 제목','타입','학생명','암기','리콜','스펠','스피킹','게임','테스트','완료여부'];

  // ★ 세트 제목: 교재명이 포함되지 않은 경우 "교재명 - 챕터" 형식으로 완성
  const bkName = result.matchedBk?.name || '';
  function buildUnitTitle(setTitle) {
    if (!setTitle) return bkName;
    if (!bkName)   return setTitle;
    // ★ normStr(): 공백·하이픈·언더스코어 모두 제거 후 비교
    // 기존 \s+만 제거 시: "Read it 50-1" vs "Read It 50 1" → 불일치 → 이중 접두어 버그
    const nb = normStr(bkName), ns = normStr(setTitle);
    if (ns.includes(nb) || nb.includes(ns)) return setTitle;
    return `${bkName} - ${setTitle}`;
  }

  const rows = [COLS, ...(result.data || result.rawData || []).map(r => [
    buildUnitTitle(r.setTitle||''), r.setType||'', r.name||'',
    r.mem||'', r.recall||'', r.spell||'',
    r.speak||'', r.game||'', r.test||'', r.done||''
  ])];

  // ★ 파일명: [반명]_교재명_날짜.xlsx
  const ts    = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const safe  = s => String(s||'').replace(/[\s/\\:*?"<>|]+/g,'_');
  const clsPart = result.matchedCls ? `[${safe(result.matchedCls.name)}]_` : '';
  const bkPart  = result.matchedBk  ? safe(result.matchedBk.name) : safe(result.ccName||'classcard');
  const filename = `${clsPart}${bkPart}_${ts}.xlsx`;

  // background → executeScript(world:MAIN) → window.XLSX.write → base64 반환
  chrome.runtime.sendMessage({ action: 'GENERATE_XLSX', rows }, res => {
    if (chrome.runtime.lastError || !res?.ok) {
      const err = res?.error || chrome.runtime.lastError?.message || '알 수 없는 오류';
      console.warn('[htdev] xlsx 생성 실패:', err);
      showToast('⚠️ xlsx 생성 실패: ' + err, 'error');
      return;
    }
    // base64 → Uint8Array → Blob → 다운로드
    const byteArr = Uint8Array.from(atob(res.base64), c => c.charCodeAt(0));
    const blob = new Blob([byteArr], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast(`📥 ${result.ccName||''} xlsx 저장`, 'success');
  });
}

// ── 진행 상황 UI ──
function showProgress(total) {
  removePanel();
  const panel = document.createElement('div');
  panel.id='htdev-cc-panel';
  panel.style.cssText = PANEL_BASE + 'top:80px;right:20px;';
  panel.innerHTML = `
    <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:16px 16px 0 0;padding:14px 16px">
      <div style="font-size:15px;font-weight:800;color:#fff">⏳ 데이터 추출 중...</div>
      <div style="font-size:11px;color:rgba(255,255,255,.8);margin-top:2px">ClassCard 탭에서 자동으로 추출합니다</div>
    </div>
    <div style="padding:16px">
      <div style="height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden;margin-bottom:8px">
        <div id="htdev-prog-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#6366f1,#8b5cf6);
          border-radius:4px;transition:width .4s"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:12px;color:#6b7280;margin-bottom:12px">
        <span id="htdev-prog-name">준비 중...</span>
        <span id="htdev-prog-frac">0 / ${total}</span>
      </div>
      <div id="htdev-prog-log" style="max-height:120px;overflow-y:auto;display:flex;flex-direction:column;gap:4px"></div>
    </div>`;
  document.body.appendChild(panel);
}

function updateProgress(current, total, name) {
  const pct = Math.round(current/total*100);
  const bar=document.getElementById('htdev-prog-bar'); if(bar) bar.style.width=pct+'%';
  const nm=document.getElementById('htdev-prog-name'); if(nm) nm.textContent=name;
  const frac=document.getElementById('htdev-prog-frac'); if(frac) frac.textContent=`${current} / ${total}`;
  const log=document.getElementById('htdev-prog-log');
  if(log){
    const item=document.createElement('div');
    item.style.cssText='font-size:11px;color:#059669;padding:3px 6px;background:#f0fdf4;border-radius:5px';
    item.textContent=`✅ ${name}`;
    log.appendChild(item); log.scrollTop=log.scrollHeight;
  }
}

// ── 매칭 프리뷰 UI ──
async function showPreview(results) {
  // ★ background를 통해 executeScript로 사이트 데이터 가져오기
  const siteData = await getSiteData();
  if (!siteData || !siteData.ok) {
    removePanel();
    showToast('⚠️ 진도사이트 데이터 로드 실패. 페이지 새로고침 후 재시도.', 'error');
    return;
  }

  const matchedList = results.map(r => ({
    ...matchCCToSite(r.ccName, siteData), rawData: r.data
  }));

  removePanel();
  const panel = document.createElement('div');
  panel.id='htdev-cc-panel';
  panel.style.cssText = PANEL_BASE + 'top:60px;right:20px;max-height:85vh;display:flex;flex-direction:column;';

  const okCount   = matchedList.filter(m=>m.matched).length;
  const failCount = matchedList.length - okCount;

  panel.innerHTML = `
    <div id="htdev-cc-hdr" style="background:linear-gradient(135deg,#0891b2,#0ea5e9);
         border-radius:16px 16px 0 0;padding:14px 16px;cursor:grab;flex-shrink:0">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-size:15px;font-weight:800;color:#fff">📋 매칭 결과 확인</div>
          <div style="font-size:11px;color:rgba(255,255,255,.8);margin-top:2px">
            매칭 ${okCount}건 · 미매칭 ${failCount}건 · xlsx 체크한 교재만 파일 저장
          </div>
        </div>
        <button id="htdev-cc-close" style="background:rgba(255,255,255,.2);border:none;color:#fff;
          border-radius:8px;padding:4px 10px;cursor:pointer;font-size:16px;font-weight:800">✕</button>
      </div>
    </div>
    <div style="overflow-y:auto;flex:1;padding:10px 12px;display:flex;flex-direction:column;gap:6px">
      ${matchedList.map((m,i) => `
        <div style="padding:10px 12px;border-radius:10px;
             background:${m.matched?'#f0fdf4':'#fff7ed'};
             border:1px solid ${m.matched?'#bbf7d0':'#fed7aa'}">
          <div style="display:flex;align-items:flex-start;gap:8px">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:6px">
                <span style="font-size:13px">${m.matched?'✅':'⚠️'}</span>
                <div style="font-size:11px;font-weight:700;color:#111;overflow:hidden;
                            text-overflow:ellipsis;white-space:nowrap;flex:1" title="${m.ccName}">${m.ccName}</div>
                <label style="display:flex;align-items:center;gap:3px;cursor:pointer;flex-shrink:0">
                  <input type="checkbox" data-xlsx-idx="${i}"
                    style="width:14px;height:14px;accent-color:#0891b2;cursor:pointer">
                  <span style="font-size:10px;font-weight:700;color:#0891b2">xlsx</span>
                </label>
              </div>
              <div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:4px">
                ${m.matchedCls
                  ? `<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;background:#dbeafe;color:#1d4ed8">${m.matchedCls.name}반</span>`
                  : m.stuNames?.length
                    ? `<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;background:#ede9fe;color:#6d28d9">🐱 ${m.stuNames.join('·')}</span>`
                    : `<span style="font-size:10px;color:#dc2626">반 미매칭</span>`}
                ${m.matchedBk
                  ? `<span style="font-size:10px;padding:2px 8px;border-radius:20px;background:#f3f4f6;color:#374151">${m.matchedBk.name}</span>`
                  : `<span style="font-size:10px;color:#dc2626">교재 미매칭</span>`}
              </div>
              ${!m.matched ? `
                <div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap">
                  <select data-idx="${i}" data-type="cls"
                    style="font-size:11px;padding:3px 6px;border-radius:6px;border:1px solid #d1d5db;
                           background:#fff;color:#374151;max-width:120px">
                    <option value="">반 선택</option>
                    ${siteData.classes.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}
                  </select>
                  <select data-idx="${i}" data-type="bk"
                    style="font-size:11px;padding:3px 6px;border-radius:6px;border:1px solid #d1d5db;
                           background:#fff;color:#374151;max-width:150px">
                    <option value="">교재 선택</option>
                    ${siteData.books.map(b=>`<option value="${b.id}">${b.name}</option>`).join('')}
                  </select>
                </div>` : ''}
            </div>
            <div style="font-size:10px;color:#9ca3af;flex-shrink:0">${m.rawData.length}건</div>
          </div>
        </div>`).join('')}
    </div>
    <div style="padding:12px 14px;border-top:1px solid #e5e7eb;display:flex;gap:8px;flex-shrink:0">
      <button id="htdev-cc-cancel" style="flex:1;padding:11px;border-radius:9px;background:#f3f4f6;
        border:1px solid #e5e7eb;color:#6b7280;font-size:13px;font-weight:700;cursor:pointer">취소</button>
      <button id="htdev-cc-apply" style="flex:2;padding:11px;border-radius:9px;
        background:linear-gradient(135deg,#059669,#10b981);color:#fff;border:none;
        font-size:13px;font-weight:800;cursor:pointer;box-shadow:0 3px 10px rgba(5,150,105,.35)">
        ✅ ${okCount}건 반영</button>
    </div>`;

  document.body.appendChild(panel);
  document.getElementById('htdev-cc-close').onclick  = removePanel;
  document.getElementById('htdev-cc-cancel').onclick = removePanel;

  document.getElementById('htdev-cc-apply').onclick = async () => {
    // 수동 지정 매칭 반영
    panel.querySelectorAll('select[data-idx]').forEach(sel => {
      const idx=+sel.dataset.idx, type=sel.dataset.type, val=sel.value;
      if (!val) return;
      if (type==='cls') matchedList[idx].matchedCls = siteData.classes.find(c=>c.id===val)||null;
      if (type==='bk')  { matchedList[idx].matchedBk = siteData.books.find(b=>b.id===val)||null; matchedList[idx].matched=true; }
    });

    // ★ 진도사이트 반영: 매칭된 전체 교재 (기본)
    const payload = matchedList
      .filter(m => m.matchedBk)
      .map(m => ({
        ccName:   m.ccName,
        clsId:    m.matchedCls?.id || null,
        bkId:     m.matchedBk.id,
        stuNames: m.stuNames,
        data:     m.rawData
      }));

    if (!payload.length) { alert('반영할 데이터가 없습니다.'); return; }

    // ★ xlsx 저장: 체크된 교재만 먼저 저장
    panel.querySelectorAll('input[type=checkbox][data-xlsx-idx]:checked').forEach(cb => {
      const idx = +cb.dataset.xlsxIdx;
      saveAsXlsx(matchedList[idx]);
    });

    const btn = document.getElementById('htdev-cc-apply');
    btn.textContent='⏳ 반영 중...'; btn.disabled=true;

    const res = await applyToSite(payload);
    removePanel();
    if (res?.log?.length) {
      console.log('[htdev] 반영 로그:');
      res.log.forEach(l => console.log(' ', l));
    }
    if (res?.ok) {
      if (res.count > 0) showToast(`✅ ${res.count}건 반영 완료!`, 'success');
      else showToast('⚠️ 0건 반영 - 콘솔(F12) 로그 확인 필요', 'error');
    } else showToast('⚠️ 반영 오류: ' + (res?.error||''), 'error');
  };

  makeDraggable(panel, 'htdev-cc-hdr');
}

// ── 버튼 주입 ──
function injectButton() {
  if (document.getElementById('htdev-cc-btn')) return;

  // 🃏 ClassCard 버튼 (기존)
  const btn = document.createElement('button');
  btn.id='htdev-cc-btn';
  btn.innerHTML='🃏 ClassCard';
  btn.style.cssText=`position:fixed;bottom:70px;right:12px;z-index:99998;
    padding:8px 14px;border-radius:10px;border:none;
    background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;
    font-size:12px;font-weight:800;cursor:pointer;
    box-shadow:0 3px 12px rgba(99,102,241,.45);
    font-family:-apple-system,sans-serif;
    display:none;`;
  btn.onclick=()=>{
    chrome.runtime.sendMessage({ action: 'OPEN_CLASSCARD' });
    showToast('🃏 ClassCard 탭을 열고 있습니다...', 'success');
  };

  // ⚡ 즉시 업데이트 버튼 (신규)
  const btnInst = document.createElement('button');
  btnInst.id='htdev-instant-btn';
  btnInst.innerHTML='⚡ 즉시 업데이트';
  btnInst.title='현재 선택된 반+교재를 ClassCard에서 자동으로 찾아 바로 반영합니다';
  btnInst.style.cssText=`position:fixed;bottom:28px;right:12px;z-index:99998;
    padding:8px 14px;border-radius:10px;border:none;
    background:linear-gradient(135deg,#059669,#10b981);color:#fff;
    font-size:12px;font-weight:800;cursor:pointer;
    box-shadow:0 3px 12px rgba(5,150,105,.45);
    font-family:-apple-system,sans-serif;
    display:none;transition:opacity .2s;`;
  btnInst.onclick=async ()=>{
    // 현재 선택된 반+교재 읽기
    const clsId = document.getElementById('bl-csel')?.value || null;
    const bkId  = document.getElementById('bl-bsel')?.value || null;

    // ★ 미선택 가드
    if(!clsId && !bkId){ showToast('⚠️ 반과 교재를 먼저 선택해주세요','error'); return; }
    if(!clsId){ showToast('⚠️ 반을 먼저 선택해주세요','error'); return; }
    if(!bkId) { showToast('⚠️ 교재를 먼저 선택해주세요','error'); return; }

    const clsName = document.querySelector('#bl-csel option:checked')?.textContent?.trim()||'';
    const bkName  = document.querySelector('#bl-bsel option:checked')?.textContent?.trim()||'';

    showToast(`⚡ [${clsName}] ${bkName} 업데이트 중...`,'success');
    showProgress(1);

    // ★ 60초 타임아웃: 응답 없으면 자동 취소
    const timer = setTimeout(()=>{
      removePanel();
      showToast('⚠️ 업데이트 시간 초과. ClassCard 로그인 상태를 확인하세요','error');
    }, 60000);
    window._htdevInstantTimer = timer;

    chrome.runtime.sendMessage({
      action:'INSTANT_UPDATE', clsId, bkId, clsName, bkName
    }, res=>{
      if(chrome.runtime.lastError||!res?.ok){
        clearTimeout(window._htdevInstantTimer);
        removePanel();
        showToast('⚠️ '+(res?.error||chrome.runtime.lastError?.message||'오류'),'error');
      }
    });
  };

  document.body.appendChild(btn);
  document.body.appendChild(btnInst);

  // ★ 300ms 폴링: 교재 탭 + 반/교재 선택 여부에 따라 버튼 상태 제어
  setInterval(() => {
    const isBooklib = [...document.querySelectorAll('.bni')].some(el =>
      el.classList.contains('on') && el.textContent.includes('교재')
    );
    btn.style.display = isBooklib ? 'block' : 'none';
    btnInst.style.display = isBooklib ? 'block' : 'none';

    if(isBooklib){
      const clsId = document.getElementById('bl-csel')?.value;
      const bkId  = document.getElementById('bl-bsel')?.value;
      const ready = !!(clsId && bkId);
      // 선택됐을 때만 완전히 활성화, 미선택 시 반투명
      btnInst.style.opacity  = ready ? '1' : '0.35';
      btnInst.style.cursor   = ready ? 'pointer' : 'not-allowed';
      btnInst.title = ready
        ? `⚡ [${document.querySelector('#bl-csel option:checked')?.textContent?.trim()||''}] ${document.querySelector('#bl-bsel option:checked')?.textContent?.trim()||''} 즉시 업데이트`
        : '반과 교재를 먼저 선택해주세요';
    }
  }, 300);
}

// ── 메시지 수신 ──
chrome.runtime.onMessage.addListener(msg => {
  switch(msg.action) {
    case 'SHOW_CLASS_SELECT':  showClassSelect(msg.classList); break;
    case 'EXTRACT_PROGRESS':   updateProgress(msg.current, msg.total, msg.name); break;
    case 'SHOW_PREVIEW':
      _extractedResults = msg.results;
      showPreview(msg.results);
      break;
    case 'EXTRACT_CANCELLED':  removePanel(); showToast('⚠️ 추출이 취소됐습니다.','error'); break;

    // ★ 즉시 업데이트 결과
    case 'INSTANT_DONE':
      clearTimeout(window._htdevInstantTimer);  // 타임아웃 취소
      removePanel();
      if(msg.ok){
        const undone=msg.undone||0, done=msg.done||0;
        const total=done+undone;
        if(total>0)
          showToast(`⚡ 즉시 업데이트 완료! 완료 ${done}건 / 미수행 ${undone}건`,'success');
        else
          showToast('⚡ 업데이트 완료 (변경 없음)','success');
      } else {
        showToast('⚠️ 업데이트 오류: '+(msg.error||'알 수 없는 오류'),'error');
      }
      break;

    // ★ 일괄 업데이트 진행 상황 — 기존 추출 진행바를 그대로 재사용
    case 'INSTANT_BULK_PROGRESS':
      if (!document.getElementById('htdev-cc-panel')) showProgress(msg.total);
      updateProgress(msg.current, msg.total, `${msg.clsName}반 · ${msg.bookName}`);
      break;

    // ★ 일괄 업데이트 완료 — 성공/실패 건수 요약
    case 'INSTANT_BULK_DONE': {
      removePanel();
      const results = msg.results || [];
      const okList  = results.filter(r => r.ok);
      const failList = results.filter(r => !r.ok);
      if (failList.length === 0) {
        showToast(`🔄 일괄 업데이트 완료! ${okList.length}개 반 전부 성공`, 'success');
      } else if (okList.length === 0) {
        showToast(`⚠️ 일괄 업데이트 실패 — ${failList.length}건 모두 반영 안 됨`, 'error');
      } else {
        showToast(`🔄 일괄 업데이트 완료 — 성공 ${okList.length}건 / 실패 ${failList.length}건`, 'error');
      }
      if (failList.length) {
        console.warn('[htdev] 일괄 업데이트 실패 목록:');
        failList.forEach(r => console.warn(`  · [${r.clsName}] ${r.bookName} — ${r.error || '알 수 없는 오류'}`));
      }
      break;
    }
  }
});

// ★ 사이트(대시보드)가 보내는 일괄 업데이트 요청 신호 수신
// (DashboardApp._requestBulkUpdate()가 window.dispatchEvent로 내보내는 것을 여기서 받아
//  확장 프로그램의 백그라운드로 전달한다 — 페이지의 MAIN world와 콘텐츠 스크립트의
//  ISOLATED world는 JS 스코프는 분리돼 있어도 DOM 이벤트는 공유되므로 이 방식이 동작한다)
window.addEventListener('htdev:bulkSyncRequest', (e) => {
  const targets = e.detail?.targets || [];
  if (!targets.length) { showToast('⚠️ 업데이트할 교재가 없습니다', 'error'); return; }
  console.log('[htdev] 일괄 업데이트 요청 수신:', targets.length, '건');
  showProgress(targets.length);
  updateProgress(0, targets.length, '준비 중...');
  chrome.runtime.sendMessage({ action:'INSTANT_UPDATE_BULK', targets }, res => {
    if (chrome.runtime.lastError || !res?.ok) {
      removePanel();
      showToast('⚠️ ' + (res?.error || chrome.runtime.lastError?.message || '일괄 업데이트 시작 실패'), 'error');
    }
  });
});

// ── 초기화 ──
function init() {
  setTimeout(injectButton, 1500);
}
if (document.readyState==='complete') init();
else window.addEventListener('load', init);

console.log('[htdev] site-content.js v1.7 주입 완료:', window.location.href);
