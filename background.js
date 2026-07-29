/**
 * background.js v2.0
 * ★ Service Worker 휴면 문제 해결: S 상태를 chrome.storage.session에 저장
 * ★ v2.0: 즉시 업데이트 기능 추가 (반+교재 선택 → ClassCard 자동 매칭 → 즉시 반영)
 */
'use strict';

// ── S 상태 저장/복원 ──
async function saveS(s) {
  await chrome.storage.session.set({ htdev_S: s });
}
async function loadS() {
  const r = await chrome.storage.session.get('htdev_S');
  return r.htdev_S || { phase:'IDLE', selected:[], idx:0, results:[], ccTabId:null, siteTabId:null, bulkTargets:[], bulkIdx:0, bulkResults:[] };
}

// ── ★ 즉시 업데이트: 자동 매칭 유틸 ──
function _normStr(s){ return String(s||'').replace(/[\s\u3000_\-]+/g,'').toLowerCase(); }
function _parseCCName(ccName){
  const noNum=ccName.replace(/^\d+[\.\-_\s]*/,'').trim();
  const bm=noNum.match(/\[([^\]]+)\]/);
  const bracket=bm?bm[1].trim():'';
  const bookName=noNum.replace(/\[[^\]]*\]\s*/,'').trim();
  return{bracket,bookName};
}
// ClassCard 클래스 목록 중 현재 반+교재와 자동 매칭
function _autoMatchCC(classList, siteData, targetClsId, targetBkId){
  const tBk =siteData.books.find(b=>b.id===targetBkId);
  const tCls=siteData.classes.find(c=>c.id===targetClsId);
  if(!tBk) return null;
  const bkN=_normStr(tBk.name), clN=tCls?_normStr(tCls.name):'';
  for(const cc of classList){
    const{bracket,bookName}=_parseCCName(cc.name);
    const brN=_normStr(bracket), bnN=_normStr(bookName);
    if(!bkN.includes(bnN)&&!bnN.includes(bkN)) continue;
    if(tCls&&clN&&brN&&!clN.includes(brN)&&!brN.includes(clN)) continue;
    return cc.classId;
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  (async () => {
    const S = await loadS();

    switch (msg.action) {

      // ── 진도사이트: ClassCard 버튼 클릭 ──
      case 'OPEN_CLASSCARD': {
        S.siteTabId = sender.tab.id;
        S.phase     = 'GETTING_CLASSES';
        S.results   = []; S.selected = []; S.idx = 0; S.ccTabId = null;
        await saveS(S);
        chrome.tabs.create({ url:'https://www.classcard.net/Main/', active:true },
          async tab => {
            S.ccTabId = tab.id;
            await saveS(S);
          });
        sendResponse({ ok:true });
        break;
      }

      // ── ClassCard: 준비 완료 ──
      case 'CC_READY': {
        const tabId   = sender.tab?.id;
        const { pageType } = msg;
        console.log('[htdev bg] CC_READY:', pageType, 'tabId:', tabId, 'S:', S.phase, S.ccTabId);

        // ccTabId 미설정이면 현재 탭으로 설정
        if (!S.ccTabId && (S.phase==='GETTING_CLASSES'||S.phase==='EXTRACTING'||S.phase==='INSTANT_FIND'||S.phase==='INSTANT')) {
          S.ccTabId = tabId;
          await saveS(S);
        }
        if (tabId !== S.ccTabId) { sendResponse({ok:false}); break; }

        if (pageType==='main' && S.phase==='GETTING_CLASSES') {
          chrome.tabs.sendMessage(S.ccTabId, { action:'GET_CLASS_LIST' }, async res => {
            if (chrome.runtime.lastError || !res?.classList?.length) {
              console.warn('[htdev bg] 클래스 목록 없음, 3초 후 재시도');
              setTimeout(async () => {
                const S2 = await loadS();
                if (!S2.ccTabId || S2.phase!=='GETTING_CLASSES') return;
                chrome.tabs.sendMessage(S2.ccTabId, { action:'GET_CLASS_LIST' }, async res2 => {
                  if (res2?.classList?.length && S2.siteTabId) {
                    chrome.tabs.sendMessage(S2.siteTabId, { action:'SHOW_CLASS_SELECT', classList:res2.classList });
                    chrome.tabs.update(S2.siteTabId, { active:true });
                  }
                });
              }, 3000);
              return;
            }
            if (S.siteTabId) {
              chrome.tabs.sendMessage(S.siteTabId, { action:'SHOW_CLASS_SELECT', classList:res.classList });
              chrome.tabs.update(S.siteTabId, { active:true });
            }
          });
        }

        // ★ INSTANT_FIND: 클래스 목록 받아 자동 매칭 후 ClassReports로 이동
        if (pageType==='main' && S.phase==='INSTANT_FIND') {
          chrome.tabs.sendMessage(S.ccTabId, { action:'GET_CLASS_LIST' }, async res => {
            if (chrome.runtime.lastError || !res?.classList?.length) {
              console.warn('[htdev bg] INSTANT_FIND: 클래스 목록 없음, 재시도');
              setTimeout(async()=>{
                const S2=await loadS();
                if(S2.phase!=='INSTANT_FIND'||!S2.ccTabId) return;
                chrome.tabs.sendMessage(S2.ccTabId,{action:'GET_CLASS_LIST'},async res2=>{
                  if(!res2?.classList?.length){
                    // 실패 → 사이트에 알림
                    if(S2.siteTabId) chrome.tabs.sendMessage(S2.siteTabId,{action:'INSTANT_DONE',ok:false,error:'ClassCard 클래스 목록을 가져올 수 없습니다'}).catch(()=>{});
                    S2.phase='IDLE'; await saveS(S2); return;
                  }
                  await _doInstantFind(S2, res2.classList);
                });
              },3000);
              return;
            }
            await _doInstantFind(S, res.classList);
          });
        }

        // ★ INSTANT_BULK_FIND: 일괄 업데이트 중, 현재 대상의 자동 매칭
        if (pageType==='main' && S.phase==='INSTANT_BULK_FIND') {
          chrome.tabs.sendMessage(S.ccTabId, { action:'GET_CLASS_LIST' }, async res => {
            if (chrome.runtime.lastError || !res?.classList?.length) {
              console.warn('[htdev bg] INSTANT_BULK_FIND: 클래스 목록 없음, 재시도');
              setTimeout(async()=>{
                const S2=await loadS();
                if(S2.phase!=='INSTANT_BULK_FIND'||!S2.ccTabId) return;
                chrome.tabs.sendMessage(S2.ccTabId,{action:'GET_CLASS_LIST'},async res2=>{
                  if(!res2?.classList?.length){ await _skipBulkTarget(S2, 'ClassCard 클래스 목록을 가져올 수 없습니다'); return; }
                  await _doBulkFind(S2, res2.classList);
                });
              },3000);
              return;
            }
            await _doBulkFind(S, res.classList);
          });
        }

        if (pageType==='set' && (S.phase==='EXTRACTING'||S.phase==='INSTANT')) {
          setTimeout(() => {
            chrome.tabs.sendMessage(S.ccTabId, { action:'EXTRACT_NOW' }, res => {
              if (chrome.runtime.lastError) {
                setTimeout(()=>{
                  chrome.tabs.sendMessage(S.ccTabId, { action:'EXTRACT_NOW' }).catch(()=>{});
                }, 1500);
              }
            });
          }, 500);
        }

        // ★ INSTANT_BULK_EXTRACT: 일괄 업데이트 중, 현재 대상의 데이터 추출
        if (pageType==='set' && S.phase==='INSTANT_BULK_EXTRACT') {
          setTimeout(() => {
            chrome.tabs.sendMessage(S.ccTabId, { action:'EXTRACT_NOW' }, res => {
              if (chrome.runtime.lastError) {
                setTimeout(()=>{
                  chrome.tabs.sendMessage(S.ccTabId, { action:'EXTRACT_NOW' }).catch(()=>{});
                }, 1500);
              }
            });
          }, 500);
        }
        sendResponse({ ok:true });
        break;
      }

      // ── 추출 시작 ──
      case 'START_EXTRACTION': {
        S.selected = msg.selected; S.idx=0; S.results=[]; S.phase='EXTRACTING';
        await saveS(S);
        chrome.tabs.update(S.ccTabId, {
          url:`https://www.classcard.net/ClassReports/set/${S.selected[0].classId}`,
          active:true
        });
        sendResponse({ ok:true });
        break;
      }

      // ── 추출 완료 ──
      case 'CC_DATA_EXTRACTED': {
        // ★ 일괄 업데이트 중이면 별도 경로로 처리 (기존 EXTRACTING/INSTANT 흐름은 그대로 둠)
        if (S.phase === 'INSTANT_BULK_EXTRACT') {
          await _finishBulkTargetExtraction(S, msg);
          sendResponse({ ok:true });
          break;
        }
        // ★ EXTRACTING(일반) 또는 INSTANT(즉시 업데이트) 두 페이즈 모두 처리
        if (S.phase !== 'EXTRACTING' && S.phase !== 'INSTANT') { sendResponse({ok:false}); break; }
        S.results.push({ ccName:msg.ccName, classId:msg.classId, data:msg.data });
        S.idx++;
        await saveS(S);

        if (S.siteTabId) {
          chrome.tabs.sendMessage(S.siteTabId, {
            action:'EXTRACT_PROGRESS', current:S.idx, total:S.selected.length, name:msg.ccName
          }).catch(()=>{});
        }

        if (S.idx < S.selected.length) {
          chrome.tabs.update(S.ccTabId, {
            url:`https://www.classcard.net/ClassReports/set/${S.selected[S.idx].classId}`,
            active:true
          });
        } else {
          S.phase = 'DONE';
          await saveS(S);
          if (S.ccTabId) { chrome.tabs.remove(S.ccTabId); }

          // ★ INSTANT 모드: 프리뷰 없이 자동 반영
          if (S.instant && S.siteTabId) {
            const payload = [{
              ccName:   S.results[0].ccName,
              clsId:    S.instantClsId || null,
              bkId:     S.instantBkId,
              stuNames: [],
              data:     S.results[0].data
            }];
            // 매핑 캐시 저장 (다음번 즉시 업데이트용)
            const mapKey=`cc_map_${S.instantClsId||'_'}_${S.instantBkId}`;
            await chrome.storage.local.set({
              [mapKey]:{ ccClassId:S.results[0].classId, ccName:S.results[0].ccName }
            });
            // 자동 반영
            chrome.scripting.executeScript({
              target:{tabId:S.siteTabId}, world:'MAIN',
              func:async(payload)=>{
                const results=[];
                for(const item of payload){
                  if(typeof BooklibApp==='undefined'||!BooklibApp._applyClassCardData)
                    return{ok:false,error:'BooklibApp 없음'};
                  const res=await BooklibApp._applyClassCardData(item.clsId,item.bkId,item.data);
                  results.push({ccName:item.ccName,...res});
                }
                if(typeof BooklibApp!=='undefined'&&BooklibApp._onBkChange){
                  const bkSel=document.getElementById('bl-bsel');
                  const cur=bkSel?.value||payload[0]?.bkId;
                  if(cur) BooklibApp._onBkChange(cur);
                }
                const cnt=results.reduce((s,r)=>(r.done||0)+(r.undone||0)+s,0);
                return{ok:true,count:cnt,undone:results[0]?.undone||0,done:results[0]?.done||0};
              },
              args:[payload]
            }).then(r=>{
              const res=r?.[0]?.result||{ok:false,error:'반영 실패'};
              if(S.siteTabId){
                chrome.tabs.sendMessage(S.siteTabId,{action:'INSTANT_DONE',...res}).catch(()=>{});
                chrome.tabs.update(S.siteTabId,{active:true});
              }
            }).catch(e=>{
              if(S.siteTabId)
                chrome.tabs.sendMessage(S.siteTabId,{action:'INSTANT_DONE',ok:false,error:e.message}).catch(()=>{});
            });
            S.phase='IDLE'; S.ccTabId=null; S.results=[]; S.instant=false;
            await saveS(S);
          } else {
            // 기존 프리뷰 흐름
            if (S.siteTabId) {
              chrome.tabs.sendMessage(S.siteTabId, { action:'SHOW_PREVIEW', results:S.results });
              chrome.tabs.update(S.siteTabId, { active:true });
            }
            S.phase='IDLE'; S.ccTabId=null; S.results=[];
            await saveS(S);
          }
        }
        sendResponse({ ok:true });
        break;
      }

      // ── 진도사이트 데이터 가져오기 ──
      case 'GET_SITE_DATA': {
        chrome.scripting.executeScript({
          target:{ tabId:sender.tab.id }, world:'MAIN',
          func:()=>{
            try{
              const books    = typeof BookLibDB!=='undefined'?(typeof BookLibDB.getAllBooks==='function'?BookLibDB.getAllBooks():BookLibDB.getBooks()):[];
              const classes  = typeof DB!=='undefined'&&DB.getActiveClasses?DB.getActiveClasses():[];
              const students = typeof StudentDB!=='undefined'&&StudentDB.getAll?StudentDB.getAll():[];
              return {ok:true,
                books:   JSON.parse(JSON.stringify(books)),
                classes: JSON.parse(JSON.stringify(classes)),
                students:JSON.parse(JSON.stringify(students))};
            }catch(e){return{ok:false,error:e.message};}
          }
        }).then(r=>sendResponse(r?.[0]?.result||{ok:false}))
          .catch(e=>sendResponse({ok:false,error:e.message}));
        return; // 비동기 응답은 이미 처리됨
      }

      // ── 데이터 반영 ──
      case 'APPLY_SITE_DATA': {
        // ★ booklib-app.js의 실제 xlsx 파이프라인 직접 호출
        // (_processCsv + _syncChaptersFromXlsx 완전 동일)
        chrome.scripting.executeScript({
          target:{ tabId:sender.tab.id }, world:'MAIN',
          func: async(payload)=>{
            const results=[];
            for(const item of payload){
              if(typeof BooklibApp==='undefined'||!BooklibApp._applyClassCardData){
                return{ok:false,error:'BooklibApp._applyClassCardData 없음'};
              }
              const res = await BooklibApp._applyClassCardData(
                item.clsId || null,
                item.bkId,
                item.data
              );
              results.push({
                ccName: item.ccName,
                ...res
              });
            }
            // UI 갱신
            if(typeof BooklibApp!=='undefined'&&BooklibApp._onBkChange){
              const bkId=results[0]?.ok?payload[0]?.bkId:null;
              const bsel=document.getElementById('bl-bsel');
              const curBkId=bsel?.value||bkId;
              if(curBkId) BooklibApp._onBkChange(curBkId);
            }
            const totalCount=results.reduce((s,r)=>(r.done||0)+(r.undone||0)+s,0);
            return{ok:true,count:totalCount,log:results.map(r=>JSON.stringify(r))};
          },
          args:[msg.payload]
        }).then(r=>{
          const res=r?.[0]?.result||{ok:false};
          if(res.log){console.log('[htdev] 반영 로그:');res.log.forEach(l=>console.log(' ',l));}
          sendResponse(res);
        }).catch(e=>sendResponse({ok:false,error:e.message}));
        return;
      }

      case 'CANCEL': {
        S.phase='IDLE'; S.ccTabId=null;
        await saveS(S);
        sendResponse({ok:true});
        break;
      }

      // ── ★ 즉시 업데이트: 현재 반+교재 → ClassCard 자동 매칭 → 추출 → 반영 ──
      case 'INSTANT_UPDATE': {
        if(S.phase!=='IDLE'){ sendResponse({ok:false,error:'다른 작업이 진행 중입니다'}); break; }
        S.siteTabId=sender.tab.id;
        S.phase='INSTANT'; S.instant=true;
        S.results=[]; S.selected=[]; S.idx=0; S.ccTabId=null;
        S.instantClsId=msg.clsId||null;
        S.instantBkId=msg.bkId;
        await saveS(S);

        // 캐시 확인
        const mapKey=`cc_map_${msg.clsId||'_'}_${msg.bkId}`;
        const stored=await chrome.storage.local.get(mapKey);
        const cached=stored[mapKey];

        if(cached?.ccClassId){
          // ✅ 캐시 있음 → ClassReports 직접 이동
          console.log('[htdev] INSTANT 캐시 히트:', cached.ccClassId, cached.ccName);
          S.selected=[{classId:cached.ccClassId,name:cached.ccName||''}];
          await saveS(S);
          chrome.tabs.create({
            url:`https://www.classcard.net/ClassReports/set/${cached.ccClassId}`,
            active:true
          },async tab=>{ S.ccTabId=tab.id; await saveS(S); });
        } else {
          // 🔍 캐시 없음 → ClassCard Main에서 자동 매칭
          S.phase='INSTANT_FIND';
          await saveS(S);
          chrome.tabs.create({url:'https://www.classcard.net/Main/',active:true},
            async tab=>{ S.ccTabId=tab.id; await saveS(S); });
        }
        sendResponse({ok:true});
        break;
      }

      // ── ★ 일괄 즉시 업데이트: 여러 {반,교재}를 순차적으로 자동 매칭→추출→반영 ──
      case 'INSTANT_UPDATE_BULK': {
        if (S.phase !== 'IDLE') { sendResponse({ ok:false, error:'다른 작업이 진행 중입니다' }); break; }
        const targets = Array.isArray(msg.targets) ? msg.targets : [];
        if (!targets.length) { sendResponse({ ok:false, error:'업데이트할 대상이 없습니다' }); break; }
        S.siteTabId   = sender.tab.id;
        S.bulkTargets = targets;
        S.bulkIdx     = 0;
        S.bulkResults = [];
        S.ccTabId     = null;
        await saveS(S);
        await _startBulkTarget(S);
        sendResponse({ ok:true, total: targets.length });
        break;
      }

      // ── xlsx 생성 (페이지의 window.XLSX 활용) ──
      case 'GENERATE_XLSX': {
        chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          func: (rows) => {
            try {
              if (typeof XLSX === 'undefined') return { ok: false, error: 'XLSX 미로드' };
              const wb = XLSX.utils.book_new();
              const ws = XLSX.utils.aoa_to_sheet(rows);
              // 열 너비 (샘플 파일 기준)
              ws['!cols'] = [
                {wch:36},{wch:6},{wch:14},
                {wch:6},{wch:6},{wch:6},{wch:8},{wch:18},{wch:8},{wch:8}
              ];
              XLSX.utils.book_append_sheet(wb, ws, '평가표');
              const base64 = XLSX.write(wb, { type:'base64', bookType:'xlsx' });
              return { ok: true, base64 };
            } catch(e) {
              return { ok: false, error: e.message };
            }
          },
          args: [msg.rows]
        }).then(results => {
          sendResponse(results?.[0]?.result || { ok: false, error: 'executeScript 실패' });
        }).catch(e => sendResponse({ ok: false, error: e.message }));
        return; // 비동기 응답
      }
    }

    sendResponse({ok:true});
  })();

  return true; // 비동기 응답 유지
});

// 탭 종료 감지
chrome.tabs.onRemoved.addListener(async tabId => {
  const S = await loadS();
  if(tabId===S.ccTabId && (S.phase==='EXTRACTING'||S.phase==='GETTING_CLASSES'||S.phase==='INSTANT'||S.phase==='INSTANT_FIND')){
    const wasInstant=S.instant;
    S.phase='IDLE'; S.ccTabId=null; S.instant=false;
    await saveS(S);
    if(S.siteTabId){
      chrome.tabs.sendMessage(S.siteTabId,{
        action: wasInstant ? 'INSTANT_DONE' : 'EXTRACT_CANCELLED',
        ok:false, error:'ClassCard 탭이 닫혔습니다'
      }).catch(()=>{});
    }
  }
  // ★ 일괄 업데이트 중 탭이 닫히면 진행 중이던 대상은 실패로 기록하고 전체를 마무리
  if(tabId===S.ccTabId && (S.phase==='INSTANT_BULK_FIND'||S.phase==='INSTANT_BULK_EXTRACT')){
    const target = S.bulkTargets?.[S.bulkIdx];
    if (target) S.bulkResults.push({ clsName:target.clsName, bookName:target.bookName, ok:false, error:'ClassCard 탭이 닫혔습니다' });
    S.ccTabId = null;
    await saveS(S);
    await _finishBulk(S);
  }
});

// ── ★ 일괄 업데이트: 다음 대상 처리 시작 ──
async function _startBulkTarget(S){
  const target = S.bulkTargets[S.bulkIdx];
  if (!target) { await _finishBulk(S); return; }

  if (S.siteTabId) {
    chrome.tabs.sendMessage(S.siteTabId, {
      action:'INSTANT_BULK_PROGRESS',
      current: S.bulkIdx + 1, total: S.bulkTargets.length,
      clsName: target.clsName, bookName: target.bookName
    }).catch(()=>{});
  }

  const mapKey = `cc_map_${target.clsId||'_'}_${target.bookId}`;
  const stored = await chrome.storage.local.get(mapKey);
  const cached = stored[mapKey];

  if (cached?.ccClassId) {
    // ✅ 캐시 있음 → ClassReports 바로 이동 (Main 페이지 매칭 단계 건너뜀)
    S.phase = 'INSTANT_BULK_EXTRACT';
    await saveS(S);
    if (S.ccTabId) {
      chrome.tabs.update(S.ccTabId, { url:`https://www.classcard.net/ClassReports/set/${cached.ccClassId}`, active:true });
    } else {
      chrome.tabs.create({ url:`https://www.classcard.net/ClassReports/set/${cached.ccClassId}`, active:true },
        async tab => { S.ccTabId = tab.id; await saveS(S); });
    }
  } else {
    // 🔍 캐시 없음 → ClassCard Main에서 자동 매칭
    S.phase = 'INSTANT_BULK_FIND';
    await saveS(S);
    if (S.ccTabId) {
      chrome.tabs.update(S.ccTabId, { url:'https://www.classcard.net/Main/', active:true });
    } else {
      chrome.tabs.create({ url:'https://www.classcard.net/Main/', active:true },
        async tab => { S.ccTabId = tab.id; await saveS(S); });
    }
  }
}

// ── ★ 일괄 업데이트: 현재 대상 자동 매칭(Main 페이지에서) ──
async function _doBulkFind(S, classList){
  const target = S.bulkTargets[S.bulkIdx];
  let siteData=null;
  try{
    const r=await chrome.scripting.executeScript({
      target:{tabId:S.siteTabId}, world:'MAIN',
      func:()=>{
        try{
          const books=typeof BookLibDB!=='undefined'?(BookLibDB.getAllBooks?.()??BookLibDB.getBooks?.()??[]):[];
          const classes=typeof DB!=='undefined'&&DB.getActiveClasses?DB.getActiveClasses():[];
          return{ok:true,books:JSON.parse(JSON.stringify(books)),classes:JSON.parse(JSON.stringify(classes))};
        }catch(e){return{ok:false,error:e.message};}
      }
    });
    siteData=r?.[0]?.result;
  }catch(e){ siteData=null; }

  if(!siteData?.ok){ await _skipBulkTarget(S, '사이트 데이터 로드 실패'); return; }

  const ccClassId=_autoMatchCC(classList, siteData, target.clsId, target.bookId);
  if(!ccClassId){ await _skipBulkTarget(S, `[${target.clsName}] ${target.bookName}: ClassCard에서 일치하는 클래스를 찾지 못했습니다`); return; }

  const matched=classList.find(c=>c.classId===ccClassId);
  console.log('[htdev] BULK 매칭:', target.clsName, target.bookName, '→', matched?.name, ccClassId);
  S.phase='INSTANT_BULK_EXTRACT';
  await saveS(S);
  chrome.tabs.update(S.ccTabId,{
    url:`https://www.classcard.net/ClassReports/set/${ccClassId}`,
    active:true
  });
}

// ── ★ 일괄 업데이트: 현재 대상 추출 완료 → 반영 → 다음 대상으로 ──
async function _finishBulkTargetExtraction(S, msg){
  const target = S.bulkTargets[S.bulkIdx];
  if (!target) { await _finishBulk(S); return; }

  // 매핑 캐시 저장 (다음번 이 반+교재 업데이트 시 Main 페이지 매칭 단계 건너뜀)
  const mapKey = `cc_map_${target.clsId||'_'}_${target.bookId}`;
  await chrome.storage.local.set({ [mapKey]: { ccClassId: msg.classId, ccName: msg.ccName } });

  // 사이트에 반영
  let applyRes = { ok:false, error:'반영 실패' };
  try {
    const r = await chrome.scripting.executeScript({
      target:{ tabId:S.siteTabId }, world:'MAIN',
      func: async (clsId, bkId, data) => {
        if (typeof BooklibApp === 'undefined' || !BooklibApp._applyClassCardData) return { ok:false, error:'BooklibApp 없음' };
        return await BooklibApp._applyClassCardData(clsId, bkId, data);
      },
      args: [target.clsId || null, target.bookId, msg.data]
    });
    applyRes = r?.[0]?.result || applyRes;
  } catch(e) { applyRes = { ok:false, error:e.message }; }

  S.bulkResults.push({ clsName: target.clsName, bookName: target.bookName, ccName: msg.ccName, ...applyRes });
  S.bulkIdx++;
  await saveS(S);
  await _startBulkTarget(S); // 다음 대상으로 진행 (없으면 내부에서 _finishBulk 호출)
}

// ── ★ 일괄 업데이트: 전체 완료 처리 ──
async function _finishBulk(S){
  if (S.ccTabId) { chrome.tabs.remove(S.ccTabId).catch(()=>{}); }
  const results = S.bulkResults || [];
  if (S.siteTabId) {
    // ★ 반영 후 화면 갱신 — 마지막으로 반영된 반/교재 기준으로 한 번만 트리거
    const lastOk = [...results].reverse().find(r => r.ok);
    if (lastOk) {
      chrome.scripting.executeScript({
        target:{ tabId:S.siteTabId }, world:'MAIN',
        func: () => {
          if (typeof BooklibApp !== 'undefined' && BooklibApp._onBkChange) {
            const bsel = document.getElementById('bl-bsel');
            if (bsel?.value) BooklibApp._onBkChange(bsel.value);
          }
        }
      }).catch(()=>{});
    }
    chrome.tabs.sendMessage(S.siteTabId, { action:'INSTANT_BULK_DONE', results }).catch(()=>{});
    chrome.tabs.update(S.siteTabId, { active:true });
  }
  S.phase='IDLE'; S.ccTabId=null; S.bulkTargets=[]; S.bulkIdx=0; S.bulkResults=[];
  await saveS(S);
}

// ── ★ INSTANT_FIND 자동 매칭 실행 ──
async function _doInstantFind(S, classList){
  // 사이트 데이터 가져오기 (books, classes)
  let siteData=null;
  try{
    const r=await chrome.scripting.executeScript({
      target:{tabId:S.siteTabId}, world:'MAIN',
      func:()=>{
        try{
          const books=typeof BookLibDB!=='undefined'?(BookLibDB.getAllBooks?.()??BookLibDB.getBooks?.()??[]):[];
          const classes=typeof DB!=='undefined'&&DB.getActiveClasses?DB.getActiveClasses():[];
          return{ok:true,books:JSON.parse(JSON.stringify(books)),classes:JSON.parse(JSON.stringify(classes))};
        }catch(e){return{ok:false,error:e.message};}
      }
    });
    siteData=r?.[0]?.result;
  }catch(e){ siteData=null; }

  if(!siteData?.ok){
    if(S.siteTabId) chrome.tabs.sendMessage(S.siteTabId,{action:'INSTANT_DONE',ok:false,error:'사이트 데이터 로드 실패'}).catch(()=>{});
    S.phase='IDLE'; S.instant=false; await saveS(S); return;
  }

  const ccClassId=_autoMatchCC(classList, siteData, S.instantClsId, S.instantBkId);
  if(!ccClassId){
    // 자동 매칭 실패 → 수동 선택 UI 표시 (일반 흐름으로 fallback)
    console.warn('[htdev] INSTANT_FIND: 자동 매칭 실패, 수동 선택 UI 표시');
    S.phase='GETTING_CLASSES'; S.instant=false;
    await saveS(S);
    if(S.siteTabId){
      chrome.tabs.sendMessage(S.siteTabId,{action:'SHOW_CLASS_SELECT',classList}).catch(()=>{});
      chrome.tabs.update(S.siteTabId,{active:true});
    }
    return;
  }

  // 매칭 성공 → ClassReports로 이동
  const matched=classList.find(c=>c.classId===ccClassId);
  console.log('[htdev] INSTANT_FIND 매칭:', matched?.name, ccClassId);
  S.phase='INSTANT'; S.instant=true;
  S.selected=[{classId:ccClassId, name:matched?.name||''}];
  await saveS(S);
  chrome.tabs.update(S.ccTabId,{
    url:`https://www.classcard.net/ClassReports/set/${ccClassId}`,
    active:true
  });
}
