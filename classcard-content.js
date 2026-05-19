/**
 * classcard-content.js v1.9
 * - Main 페이지 동적 로딩 대기 강화
 * - 링크 패턴 자동 감지
 */
'use strict';

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

const isMain = ()=> /\/(Main|main)\/?$/.test(window.location.pathname) || window.location.pathname === '/';
const isSet  = ()=> /\/ClassReports\/set\/\d+/.test(window.location.pathname);

// ── Main: 클래스 목록 수집 ──
async function getClassList(){
  // 동적 콘텐츠 충분히 대기 (최대 10초)
  let tries = 0;
  while (tries < 20) {
    await sleep(500);
    tries++;

    const list = [], seen = new Set();

    // 현재 페이지 모든 href 디버그
    if (tries === 1) {
      const allHrefs = [...document.querySelectorAll('a[href]')]
        .map(a => a.getAttribute('href'))
        .filter(h => h && (h.includes('Class') || h.includes('class')));
      console.log('[htdev] Class 관련 링크들:', allHrefs.slice(0, 20));
    }

    // ★ 패턴 1: /ClassMain/{숫자} (실제 ClassCard Main 페이지 링크 형식)
    document.querySelectorAll('a[href*="/ClassMain/"]').forEach(a => {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/ClassMain\/(\d+)(?:[/?#]|$)/);
      if (!m) return;
      const classId = m[1];
      if (seen.has(classId)) return;
      seen.add(classId);
      let name = (
        a.querySelector('[class*="class-name"],[class*="className"],[class*="title"],[class*="name"]')?.textContent.trim() ||
        a.getAttribute('title') ||
        a.closest('[class*="card"],[class*="item"],[class*="class"],[class*="list"]')
          ?.querySelector('[class*="name"],[class*="title"],[class*="text"]')?.textContent.trim() ||
        a.textContent.replace(/\s+/g,' ').trim()
      ).replace(/\s+/g,' ').trim().slice(0,60);
      if (!name || name.length < 1) name = '클래스 ' + classId;
      list.push({ name, classId });
    });

    // 패턴 2: /ClassReports/{숫자} (폴백)
    if (!list.length) {
      document.querySelectorAll('a[href*="/ClassReports/"]').forEach(a => {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/ClassReports\/(\d+)(?:[/?#]|$)/);
        if (!m) return;
        const classId = m[1];
        if (seen.has(classId)) return;
        seen.add(classId);
        const name = (a.getAttribute('title') || a.textContent.replace(/\s+/g,' ').trim()).slice(0,60);
        if (name) list.push({ name, classId });
      });
    }

    // 패턴 3: data-id 또는 data-class-id
    if (!list.length) {
      document.querySelectorAll('[data-class-id]').forEach(el => {
        const classId = el.dataset.classId;
        if (!classId || seen.has(classId)) return;
        seen.add(classId);
        const name = el.querySelector('[class*="name"],[class*="title"]')?.textContent.trim() || '클래스 '+classId;
        list.push({ name, classId });
      });
    }

    if (list.length > 0) {
      console.log('[htdev] 클래스 목록:', list.length, '개', list.slice(0,3).map(c=>c.name));
      return list;
    }
  }

  // 모두 실패 시 전체 링크 덤프
  console.log('[htdev] 클래스 못 찾음. 전체 href:', 
    [...document.querySelectorAll('a[href]')].map(a=>a.getAttribute('href')).slice(0,30));
  return [];
}

// ── Set: 데이터 추출 ──
async function extractSetData(){
  let tries=0;
  while(!document.querySelector('.class-report-panel')&&tries<20){await sleep(500);tries++;}
  const panels=document.querySelectorAll('.class-report-panel');
  console.log('[htdev] 패널 수:', panels.length);

  // ── 닫힌 패널 모두 열기 ──
  panels.forEach(panel=>{
    const caret=panel.querySelector('i.icon-caret-down');
    if(!caret)return;
    const body=panel.querySelector('.panel-body');
    const closed=!body||body.style.display==='none'||
      (body.classList.contains('collapse')&&!body.classList.contains('in'));
    if(closed||body.children.length===0){
      (caret.closest('a')||caret.closest('.showhide_battle')||caret.parentElement)?.click();
    }
  });

  // ── ★ 버그①수정: 전체 패널 로딩 완료 대기 (안정화 방식) ──
  // 기존 .some(): 패널 1개라도 로드되면 즉시 탈출 → 나머지 패널 데이터 누락
  //   → 서우/민아 등 학생의 챕터 6개 미수행 누락 원인
  // 수정: 전체 .report-set 누적 수가 1.5초 이상 변화 없으면 "전부 로드됨"으로 판단
  await sleep(1000);
  const start=Date.now();
  let lastTotal=-1, stableMs=0;
  while(Date.now()-start<25000){           // 최대 25초
    const total=[...panels].reduce((s,p)=>s+p.querySelectorAll('.report-set').length,0);
    if(total>0 && total===lastTotal){
      stableMs+=400;
      if(stableMs>=1500) break;            // 1.5초 안정 → 완료
    } else {
      stableMs=0; lastTotal=total;
    }
    await sleep(400);
  }
  console.log('[htdev] 로딩 완료: report-set', lastTotal, '건 / 패널', panels.length, '개');

  // ── 데이터 추출 ──
  const pct=el=>{if(!el)return'';const v=el.textContent.trim().replace('%','');return/^\d+$/.test(v)?v:'';};
  const data=[];

  // ─ 1차: 학생 이름 순서 확정 (데이터 있는 첫 패널 기준) ──────────────────
  // ★ 버그②수정을 위해 필요: 빈 패널에 삽입할 학생 목록
  let knownStudents=[];
  for(const panel of panels){
    const rows=panel.querySelectorAll('.report-set');
    if(!rows.length) continue;
    rows.forEach(row=>{
      let n=row.querySelector('.set-user-name')?.textContent.trim();
      if(!n||n==='김샘플') return;
      n=n.replace(/^\d+\.\s*/,'');
      if(!knownStudents.includes(n)) knownStudents.push(n);
    });
    if(knownStudents.length) break;        // 첫 패널에서 학생 목록 확정
  }
  console.log('[htdev] 학생 목록:', knownStudents);

  // ─ 2차: 모든 패널 데이터 수집 ───────────────────────────────────────────
  panels.forEach(panel=>{
    const titleEl=panel.querySelector('.font-20.font-medium');
    const setTitle=titleEl?titleEl.textContent.trim():'';
    const body=panel.querySelector('.panel-body');
    const setType=body?.classList.contains('sentence')?'문장':'단어';
    const reportRows=panel.querySelectorAll('.report-set');

    if(reportRows.length>0){
      // ── 데이터 있는 패널: 정상 추출 ──
      reportRows.forEach(row=>{
        let name=row.querySelector('.set-user-name')?.textContent.trim();
        if(!name||name==='김샘플') return;
        name=name.replace(/^\d+\.\s*/,'');
        const clearDiv=row.querySelector('.set-clear');
        // .set-clear 없는 행 = 학습 기록 없거나 미완료 → 반드시 미완료
        const done=(clearDiv&&!clearDiv.classList.contains('hidden'))?'완료':'미완료';
        data.push({setTitle,setType,name,
          mem:   pct(row.querySelector('.mem-percent')),
          recall:pct(row.querySelector('.recall-percent')),
          spell: pct(row.querySelector('.spell-percent')),
          speak: pct(row.querySelector('.preview-rate .progress-text')),
          game:  row.querySelector('.match_recent_score .progress-text')?.textContent.trim().replace(/\s+/g,' ')||'',
          test:  row.querySelector('.test-recent-score-txt')?.textContent.trim()||'',
          done});
      });
    } else if(setTitle && knownStudents.length){
      // ── ★ 버그②수정: 학습 기록 없는 패널 ("학습 기록이 없습니다" 표시) ──
      // .report-set 행이 없으면 Tampermonkey와 달리 아예 스킵 → 누락 원인
      // → knownStudents 전체를 빈 데이터(모두 미완료)로 삽입
      knownStudents.forEach(name=>{
        data.push({setTitle,setType,name,
          mem:'',recall:'',spell:'',speak:'',game:'',test:'',done:'미완료'});
      });
    }
  });

  const titleEl=document.querySelector('.class-title2');
  const ccName=titleEl?(titleEl.getAttribute('title')||titleEl.textContent.trim()):document.title;
  const classId=window.location.pathname.match(/\/ClassReports\/set\/(\d+)/)?.[1]||'';
  const doneCount=data.filter(d=>d.done==='완료').length;
  const emptyCount=data.filter(d=>!d.mem&&!d.recall&&!d.spell&&!d.speak&&!d.game&&!d.test).length;
  console.log(`[htdev] 추출완료:"${ccName}" 총${data.length}건 (완료:${doneCount} / 빈패널:${emptyCount})`);
  return{ccName,classId,data};
}

// ── 메시지 리스너 ──
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg.action==='GET_CLASS_LIST'){
    getClassList().then(classList=>sendResponse({classList}));
    return true;
  }
  if(msg.action==='EXTRACT_NOW'){
    extractSetData().then(r=>{
      chrome.runtime.sendMessage({action:'CC_DATA_EXTRACTED',ccName:r.ccName,classId:r.classId,data:r.data});
      sendResponse({ok:true});
    });
    return true;
  }
});

// ── CC_READY 전송 ──
function notifyReady(){
  let pageType=null;
  if(isMain()) pageType='main';
  else if(isSet()) pageType='set';
  else return;
  console.log('[htdev] CC_READY 전송:', pageType, window.location.href);
  chrome.runtime.sendMessage({action:'CC_READY', pageType}, res=>{
    if(chrome.runtime.lastError){
      console.warn('[htdev] CC_READY 오류:',chrome.runtime.lastError.message);
    } else {
      console.log('[htdev] CC_READY 응답:', res);
    }
  });
}

// Main 페이지는 SPA이므로 충분히 대기
if(document.readyState==='complete') setTimeout(notifyReady, 2500);
else window.addEventListener('load', ()=>setTimeout(notifyReady, 2500));

console.log('[htdev] v1.8 로드:', window.location.pathname);
