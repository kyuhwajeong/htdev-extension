/**
 * classcard-alert.js — document_start에서 실행
 * ClassCard의 "삭제된 클래스" alert 자동 차단
 */
(function() {
  const _origAlert = window.alert.bind(window);
  window.alert = function(msg) {
    if (msg && (msg.includes('삭제') || msg.includes('없') || msg.includes('오류') || msg.includes('error'))) {
      console.log('[htdev] alert 차단:', msg);
      // alert 닫힌 후 ClassReports 목록으로 이동
      setTimeout(() => {
        if (window.location.pathname !== '/ClassReports/' &&
            !window.location.pathname.startsWith('/ClassReports/set/')) {
          window.location.href = '/ClassReports/';
        }
      }, 100);
      return;
    }
    return _origAlert(msg);
  };
  console.log('[htdev] alert 차단 준비 완료');
})();
