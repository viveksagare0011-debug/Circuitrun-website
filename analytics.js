// Google Analytics. The Measurement ID is set below. To switch analytics off, make the ID empty ("").
// While the ID is empty, nothing is loaded and no visit data is collected.
(function () {
  var GA_ID = "G-RXDF1D49HP";
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
