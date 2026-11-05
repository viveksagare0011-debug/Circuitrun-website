// CircuitRun: "website is under upgrade" notice. A small pop-up, shown once a day per browser.
// To switch it off for good, delete the <script src="site-notice.js"> line from the pages (or empty this file).
(function () {
  'use strict';
  try { if (navigator.webdriver && !/[?&]notice=1/.test(location.search)) return; } catch (e) {}   // not for test robots
  var KEY = 'cr_notice_seen', DAY = 24 * 60 * 60 * 1000;
  function seenRecently() {
    try { var t = Number(localStorage.getItem(KEY)) || 0; return t > 0 && Date.now() - t < DAY; } catch (e) {}
    try { return sessionStorage.getItem(KEY) === '1'; } catch (e2) {}
    return false;
  }
  function markSeen() {
    try { localStorage.setItem(KEY, String(Date.now())); return; } catch (e) {}
    try { sessionStorage.setItem(KEY, '1'); } catch (e2) {}
  }
  if (seenRecently()) return;

  var css = '' +
    '#crNotice{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(8,8,14,.72);font-family:Inter,system-ui,sans-serif}' +
    '#crNotice .crn-card{width:100%;max-width:420px;background:#1C1C27;color:#F4F3F7;border:1px solid #2C2C39;border-top:3px solid #FFB020;border-radius:16px;padding:22px 22px 18px;box-shadow:0 18px 50px rgba(0,0,0,.55)}' +
    '#crNotice h2{margin:0 0 8px;font:800 19px/1.25 "Space Grotesk",Inter,sans-serif;display:flex;gap:10px;align-items:center}' +
    '#crNotice p{margin:0 0 10px;font-size:14px;line-height:1.6;color:#D7D5E0}' +
    '#crNotice .crn-btns{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}' +
    '#crNotice .crn-ok{background:#C6FF3D;color:#12121A;border:0;border-radius:999px;padding:11px 20px;font:700 14px Inter,sans-serif;cursor:pointer}' +
    '#crNotice .crn-report{color:#F4F3F7;border:1px solid #3a3a4a;border-radius:999px;padding:10px 18px;font:600 14px Inter,sans-serif;text-decoration:none}' +
    '#crNotice .crn-ok:focus-visible,#crNotice .crn-report:focus-visible{outline:2px solid #4DE8FF;outline-offset:2px}' +
    '#crNotice .crn-mail{font-size:12px;color:#9A98A8;margin:14px 0 0}' +
    '#crNotice .crn-mail a{color:#F4F3F7;overflow-wrap:anywhere}';

  function show() {
    if (document.getElementById('crNotice')) return;
    var st = document.createElement('style'); st.id = 'crNoticeCss'; st.textContent = css; document.head.appendChild(st);
    var box = document.createElement('div'); box.id = 'crNotice';
    box.innerHTML =
      '<div class="crn-card" role="dialog" aria-modal="true" aria-labelledby="crnTitle" aria-describedby="crnText">' +
      '<h2 id="crnTitle"><span aria-hidden="true">&#9888;&#65039;</span> Website under upgrade</h2>' +
      '<p id="crnText">CircuitRun is still being upgraded. We are sorry for any inconvenience or bugs you may notice.</p>' +
      '<p>If an issue stays unsolved, please connect with us and we will fix it.</p>' +
      '<div class="crn-btns"><button type="button" class="crn-ok" id="crnOk">OK, got it</button>' +
      '<a class="crn-report" href="report-bug.html">Report a problem</a></div>' +
      '<p class="crn-mail">Or email <a href="mailto:circuitrun0411@gmail.com">circuitrun0411@gmail.com</a></p></div>';
    var prev = document.activeElement;
    function close() {
      markSeen();
      document.removeEventListener('keydown', onKey, true);
      if (box.parentNode) box.parentNode.removeChild(box);
      if (prev && prev.focus) { try { prev.focus(); } catch (e) {} }
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'Tab') {   // keep the focus inside the pop-up
        var f = box.querySelectorAll('button, a[href]'); if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.body.appendChild(box);
    document.addEventListener('keydown', onKey, true);
    box.querySelector('#crnOk').addEventListener('click', close);
    box.querySelector('.crn-report').addEventListener('click', markSeen);
    box.addEventListener('click', function (e) { if (e.target === box) close(); });
    box.querySelector('#crnOk').focus();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
})();
