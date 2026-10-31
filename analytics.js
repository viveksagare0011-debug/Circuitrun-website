// Google Analytics (optional). Paste your Measurement ID between the quotes, like "G-ABC123XYZ9".
// While it is empty, nothing is loaded and no visit data is collected.
(function () {
  var GA_ID = "";
  if (!/^G-[A-Z0-9]{6,14}$/.test(GA_ID)) return;
  if (navigator.doNotTrack === "1") return;   // respect the browser's Do Not Track setting
  window.dataLayer = window.dataLayer || [];
  function gtag(){ dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", GA_ID, { anonymize_ip: true });
  var s = document.createElement("script");
  s.async = true; s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
  document.head.appendChild(s);
})();
