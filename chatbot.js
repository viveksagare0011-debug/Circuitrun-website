/* CircuitRun Assistant — self-injecting chat widget.
 * Local knowledge-based engine (no API key, no cost). Reads the page's own
 * CATALOG / PROJECTS globals, so answers always match what the site shows.
 * Optional: set CONFIG.llmEndpoint to a Supabase Edge Function URL to let a
 * Claude model answer questions the local engine cannot. */
(function () {
  'use strict';
  if (window.__crBot) return;
  window.__crBot = true;

  var CONFIG = {
    llmEndpoint: '',               // e.g. https://<project>.supabase.co/functions/v1/chat
    storeKey: 'circuitrun_bot_v1',
    maxHistory: 40,
    logQuestions: true             // anonymous question log; needs bot_logs table (bot_logs.sql), silently skipped if missing
  };

  /* ---------- safe access to page globals ---------- */
  function G(fn, fallback) { try { var v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; } }
  function catalog() { return G(function () { return CATALOG; }, []) || []; }
  function projects() { return G(function () { return PROJECTS; }, []) || []; }
  function waNumber() { return G(function () { return OWNER_WHATSAPP; }, '917318760011'); }
  function advPct() { return Math.round((G(function () { return ADVANCE_PCT; }, 0.2)) * 100); }
  function rupee(n) { return '₹' + n; }
  function nextBatch() {
    try { var d = getAssignedBatch(); return d ? formatBatchDate(d) : null; } catch (e) { return null; }
  }
  function waLink(text) { return 'https://wa.me/' + waNumber() + (text ? '?text=' + encodeURIComponent(text) : ''); }

  /* ---------- text utils ---------- */
  var STOP = {};
  ('a an the is are was be to of in on at for and or me my i you your we it this that these those with from by as do does did can could would should will shall please pls plz' +
   ' hai hain ho hu hoon tha the kya ka ki ke ko se me mein mai main par pe aur bhi toh to ye yeh woh wo kuch koi mujhe muje mera meri mere hume hamein tum aap yaar bhai bro' +
   ' batao bata bataiye dikhao dikha do de dena chahiye chahie chaiye wala wali wale kar karo kare karna kaise kaisa kitna kitni kitne kab kahan kaun kyu kyun' +
   ' info information detail details spec specs specification price cost rate rates kimat daam dam paisa rupees rupee rs inr buy order add cart want need get show tell about give list' +
   ' available availability stock hai much many how what which where there here have has had just really also tell sell selling sale only some any all something anything thing things stuff top best good few popular').split(' ').forEach(function (w) { if (w) STOP[w] = 1; });

  function norm(s) {
    return String(s || '').toLowerCase().replace(/\bwi[\s-]?fi\b/g, 'wifi').replace(/₹/g, ' rs ').replace(/([a-z])-(\d)/g, '$1$2').replace(/[-_/]/g, ' ').replace(/\b(dht|esp|mq|lm|ne|hx|sg|mg|ds|tp|uln|nrf|ir|hc|sr) (\d{1,4})\b/g, '$1$2').replace(/[^a-z0-9\s.]/g, ' ').replace(/\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function stem(w) { return (w.length > 4 && /[^s]s$/.test(w) && !/ss$/.test(w)) ? w.slice(0, -1) : w; }
  function words(s) { return norm(s).split(' ').filter(Boolean).map(stem); }
  function contentWords(s) { return words(s).filter(function (w) { return !STOP[w]; }); }

  function dl(a, b) { // Damerau-Levenshtein (OSA)
    var al = a.length, bl = b.length, d = [], i, j;
    for (i = 0; i <= al; i++) { d[i] = [i]; }
    for (j = 1; j <= bl; j++) d[0][j] = j;
    for (i = 1; i <= al; i++) for (j = 1; j <= bl; j++) {
      var c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[al][bl];
  }
  // how well does query token q match doc word w (0..1)
  function tokMatch(q, w) {
    if (q === w) return 1;
    if (q.length >= 5 && w.indexOf(q) === 0) return 0.8;
    if (q.length >= 5 && Math.abs(q.length - w.length) <= 2) {
      var lim = q.length >= 8 ? 2 : 1;
      if (/\d/.test(q) !== /\d/.test(w)) return 0;
      if (dl(q, w) <= lim) return 0.6;
    }
    return 0;
  }
  function bestIn(q, ws) { var b = 0; for (var i = 0; i < ws.length; i++) { var m = tokMatch(q, ws[i]); if (m > b) b = m; if (b === 1) break; } return b; }

  var HI_WORDS = /\b(kya|hai|hain|kitna|kitne|kitni|kaise|kaisa|mujhe|muje|chahiye|chahie|batao|bata|bataiye|nahi|nahin|kab|kahan|kaun|aur|bhi|wala|wali|karo|kare|milega|milta|milti|dikhao|dena|dedo|mera|meri|mere|hume|hamein|aap|tum|yaar|bhai|kam|sasta|abhi|kal|aaj|paisa|rupaye|lagega|hoga|hogi|kuch|sab|kaam)\b/;
  function isHinglish(t) { return HI_WORDS.test(norm(t)); }

  // everyday words -> words that really appear in catalogue names/specs (used for search only)
  var SYN = { temperature: ['temp'], distance: ['ultrasonic'], range: ['ultrasonic'], motion: ['pir'], movement: ['pir'], light: ['ldr'], brightness: ['ldr'],
    weight: ['load', 'hx711'], screen: ['display', 'oled', 'lcd'], bluetooth: ['bt'], microcontroller: ['arduino', 'esp32', 'nodemcu', 'pico', 'atmega328p'],
    board: ['arduino', 'esp32', 'nodemcu', 'pico'], sound: ['buzzer'], alarm: ['buzzer'], speaker: ['buzzer'], charger: ['tp4056'], solder: ['soldering'],
    cable: ['jumper'] };

  /* ---------- product / project search ---------- */
  var idx = { catRef: null, items: [] };
  function buildIndex() {
    var c = catalog();
    if (idx.catRef === c && idx.len === c.length) return;
    idx.catRef = c; idx.len = c.length;
    idx.items = c.map(function (it) {
      return { it: it, name: words(it.name), spec: words(it.spec), cat: words(it.cat), det: words(String(it.details || '').split('\n').slice(0, 8).join(' ')) };
    });
  }
  function searchProducts(qWords, limit) {
    buildIndex();
    if (!qWords.length) return [];
    var res = [];
    idx.items.forEach(function (d) {
      var total = 0, matched = 0, nameHit = 0, specHit = 0;
      qWords.forEach(function (q) {
        var alts = SYN[q] ? [q].concat(SYN[q]) : [q], n = 0, s = 0, c = 0, t = 0;
        alts.forEach(function (a) {
          var w = a === q ? 1 : 0.9;
          n = Math.max(n, bestIn(a, d.name) * w); s = Math.max(s, bestIn(a, d.spec) * w); c = Math.max(c, bestIn(a, d.cat) * w); t = Math.max(t, bestIn(a, d.det) * w);
        });
        var sc = Math.max(n * 3, s * 1.5, c * 1, t * 0.4);
        if (sc > 0) matched++;
        if (n > 0) nameHit += n;
        if (s > 0) specHit += s;
        total += sc;
      });
      var coverage = matched / qWords.length;
      if ((nameHit > 0 && coverage >= 0.5) || (coverage >= 1 && specHit > 0)) res.push({ item: d.it, score: total + coverage * 2 + nameHit, coverage: coverage });
    });
    res.sort(function (a, b) { return b.score - a.score; });
    return res.slice(0, limit || 5);
  }
  function searchProjects(qWords) {
    var res = [];
    projects().forEach(function (p) {
      var nm = words(p.name), ds = words(p.desc + ' ' + p.info), total = 0, matched = 0;
      qWords.forEach(function (q) {
        var n = bestIn(q, nm), d = bestIn(q, ds), sc = Math.max(n * 3, d * 1);
        if (sc > 0) matched++; total += sc;
      });
      if (qWords.length && matched / qWords.length >= 0.5 && total >= 1) res.push({ proj: p, score: total });
    });
    res.sort(function (a, b) { return b.score - a.score; });
    return res;
  }
  function byId(id) { return catalog().filter(function (c) { return c.id === id; })[0]; }
  function inCatalog(id) { return !!byId(id); }
  function firstLines(it, n) { return String(it.details || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, n); }

  /* ---------- reply building blocks ---------- */
  function R() { return { parts: [], chips: [] }; }
  function T(r, v) { r.parts.push({ t: 'text', v: v }); return r; }
  function LST(r, rows) { r.parts.push({ t: 'list', rows: rows }); return r; }
  function BTN(r, label, href) { r.parts.push({ t: 'btn', label: label, href: href }); return r; }
  function pick(en, hi, hin) { return hin ? hi : en; }

  function productRow(it) {
    var row = { title: it.name, sub: rupee(it.price) + (it.spec ? ' · ' + it.spec : ''), href: 'product.html?id=' + encodeURIComponent(it.id) };
    if (inCatalog(it.id)) row.addId = it.id;
    return row;
  }
  function productCard(it, hin) {
    var r = R();
    T(r, '**' + it.name + '** — ' + rupee(it.price));
    if (it.spec) T(r, it.spec);
    var det = firstLines(it, 12);
    if (det.length) T(r, det.slice(0, 4).map(function (l) { return '• ' + l; }).join('\n'));
    if (det.length > 4) r.parts.push({ t: 'more', lines: det.slice(4), label: pick('Show all specs', 'Saari specs dikhao', hin) });
    setCtx('product', it.id);
    T(r, pick('Category: ', 'Category: ', hin) + it.cat);
    LST(r, [productRow(it)]);
    r.chips = [pick('Delivery kab hogi?', 'Delivery kab hogi?', hin), pick('Payment kaise hota hai?', 'Payment kaise hota hai?', hin)];
    return r;
  }

  var INTENTS = [
    ['ack', /^(ok|okay|k|kk|hmm+|acha|accha|achha|theek hai|thik hai|theek|thik|cool|nice|got it|fine|yes|no|haan|han|nahi|nope|sure)\W*$/],
    ['greet', /^(hi+|hii+|hello+|hey+|hola|namaste|namaskar|yo|sup|good (morning|afternoon|evening))\b/],
    ['thanks', /\b(thanks|thank you|thx|shukriya|dhanyavaad|dhanyavad|ok thanks|great|awesome)\b/],
    ['bye', /^(bye|goodbye|tata|see you|ok bye)\b/],
    ['whoami', /\b(who are you|what are you|are you (a )?(bot|ai|human|real)|tum kaun|aap kaun|kya tum (ai|bot)|ai ho|bot ho)\b/],
    ['help', /\b(help|what can you do|kya kar sakte|madad|options|menu)\b/],
    ['refund', /\b(refund|money back|paise wapas|paisa wapas|cancel(l)?(ation)?|order cancel)\b/],
    ['return', /\b(return|replace|replacement|exchange|defective|damaged|damage|kharab|toota|wapas|galat item|wrong item|warranty|guarantee)\b/],
    ['payment', /\b(pay|payment|upi|qr|advance|cod|cash on delivery|cash|gpay|phonepe|paytm|card|net banking|online payment|payment kaise)\b/],
    ['delivery', /\b(deliver|delivery|batch|when will|kab (aayega|milega|tak|aayegi)|shipping|ship|dispatch|arrive|how long|kitne din|kitna time|time lagega|tuesday|friday|run)\b/],
    ['areas', /\b(nerul|vashi|belapur|cbd|navi mumbai|area|areas|location|locations|which college|kaun se college|campus|hostel|where do you deliver|kahan deliver|deliver (to|in|at))\b/],
    ['contact', /\b(contact|whatsapp|call|phone number|number|owner|founder|support|talk to|baat karni|reach|email|mail)\b/],
    ['track', /\b(track|tracking|my orders?|order status|status|where is my order|mera order|order kahan|invoice|bill|receipt)\b/],
    ['login', /\b(login|log in|sign in|signin|sign up|signup|register|account|logout|log out|password|otp)\b/],
    ['discount', /\b(discount|coupon|promo|cheaper|bargain|negotiat)\b/],
    ['stock', /\b(in stock|out of stock|stock|availab|milega kya|hai kya|available hai)\b/],
    ['discount', /\b(discount|coupon|promo|offer|code|sale|bulk|cheaper|negotiat|bargain|student discount)\b/],
    ['request', /\b(request|not listed|not in (the )?(list|catalog)|nahi (mil raha|dikh)|missing|add (new )?component|custom|other component|aur component|suggest (a )?component)\b/],
    ['about', /\b(about (you|circuitrun|us)|what is circuitrun|circuitrun kya|who (made|built|started)|kisne banaya|your story|about us)\b/],
    ['privacy', /\b(privacy|data|personal (info|data)|safe|secure|security|trust|legit|scam|fraud)\b/],
    ['categories', /\b(categor|what (do you|all) (sell|have)|kya kya (milta|milti|hai)|sab kuch|everything|catalog|catalogue|full list|all components|all products)\b/],
    ['projlist', /\b(projects?|kits?|mini ?project|major project|final year|project ideas?|project idea|diy)\b/]
  ];
  function detectIntent(t) {
    for (var i = 0; i < INTENTS.length; i++) if (INTENTS[i][1].test(t)) return INTENTS[i][0];
    return null;
  }
  function detectIntents(t) {
    var out = [];
    for (var i = 0; i < INTENTS.length; i++) if (INTENTS[i][1].test(t)) out.push(INTENTS[i][0]);
    return out;
  }
  var NOT_INFO = /^(ack|greet|thanks|bye|whoami|help|projlist|categories|stock)$/;
  function mergeReplies(rs) {
    var a = rs[0];
    for (var i = 1; i < rs.length; i++) { a.parts = a.parts.concat(rs[i].parts); (rs[i].chips || []).forEach(function (c) { if (a.chips.length < 3 && a.chips.indexOf(c) < 0) a.chips.push(c); }); }
    return a;
  }
  // conversation context for follow-ups like "and its price?"
  var ctx = { product: null, project: null };
  function setCtx(kind, id) { ctx = { product: null, project: null }; ctx[kind] = id; }
  var DAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  function batchFor(text) { // "if I order tomorrow / on Monday" -> real batch date from the site's own rule
    var t = norm(text || ''), d = new Date(), en = 'today', hi = 'aaj', m;
    d.setHours(0, 0, 0, 0);
    if (/order\w*.*\b(tomorrow|kal)\b|\b(tomorrow|kal)\b.*order/.test(t)) { d.setDate(d.getDate() + 1); en = 'tomorrow'; hi = 'kal'; }
    else if ((m = t.match(/order\w*\s*(?:on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)|(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s*(?:ko\s+)?order/))) {
      var name = m[1] || m[2], diff = (DAYS[name] - d.getDay() + 7) % 7; d.setDate(d.getDate() + diff);
      en = 'on ' + name.charAt(0).toUpperCase() + name.slice(1); hi = name.charAt(0).toUpperCase() + name.slice(1) + ' ko';
    }
    var label = null; try { var b = getAssignedBatch(d); label = b ? formatBatchDate(b) : null; } catch (e) { }
    return { label: label, en: en, hi: hi };
  }

  /* ---------- handlers ---------- */
  var handlers = {
    greet: function (h) {
      var r = R(), nm = G(function () { return String(state.user.name).split(' ')[0].replace(/\*/g, '').slice(0, 20); }, '');
      T(r, pick('Hi' + (nm ? ' ' + nm : '') + '! 👋 I\'m Volty, the CircuitRun assistant. Ask me about components, project kits, delivery, payment or returns.',
        'Hi' + (nm ? ' ' + nm : '') + '! 👋 Main Volty hoon, CircuitRun ka assistant. Components, project kits, delivery, payment ya returns — kuch bhi pucho.', h));
      r.chips = starterChips(h); return r;
    },
    ack: function (h) { var r = R(); T(r, pick('👍 Anything else I can help with?', '👍 Aur kuch madad chahiye?', h)); r.chips = starterChips(h); return r; },
    thanks: function (h) { var r = R(); T(r, pick('Happy to help! Anything else?', 'Koi baat nahi! Aur kuch chahiye to pucho 🙂', h)); r.chips = starterChips(h); return r; },
    bye: function (h) { var r = R(); T(r, pick('Bye! Happy building ⚡', 'Bye! Happy building ⚡', h)); return r; },
    whoami: function (h) {
      var r = R();
      T(r, pick('I\'m an automated assistant on the CircuitRun site — not a human. I answer from this site\'s catalog, project kits and policies. If I\'m not sure about something, I\'ll say so and point you to the owner on WhatsApp.',
        'Main CircuitRun site ka automated assistant hoon — insaan nahi. Jawab site ke catalog, project kits aur policies se deta hoon. Kisi cheez ka pakka pata na ho to seedha bol dunga aur owner ka WhatsApp bata dunga.', h));
      return r;
    },
    help: function (h) {
      var r = R();
      T(r, pick('I can help with:\n• Component details & prices (e.g. "ESP32 price")\n• Compare two parts ("Uno vs Nano")\n• Budget search ("sensors under 100")\n• Project kits and their parts\n• Delivery, payment, returns, refunds, login',
        'Main inme help kar sakta hoon:\n• Component ki details aur price (jaise "ESP32 price")\n• Do parts compare ("Uno vs Nano")\n• Budget search ("100 se kam sensors")\n• Project kits aur unke parts\n• Delivery, payment, returns, refunds, login', h));
      r.chips = starterChips(h); return r;
    },
    delivery: function (h, text) {
      var r = R(), when = batchFor(text), nb = when.label;
      T(r, pick('We deliver in batch runs every **Tuesday and Friday**. An order must be placed at least 2 days before a run to make it; otherwise it rolls to the next run. Delivery goes to the campus location you enter at checkout.',
        'Hum batch runs mein deliver karte hain — har **Tuesday aur Friday**. Order run se kam se kam 2 din pehle hona chahiye, warna agle run mein jaata hai. Delivery checkout mein diye gaye campus location pe hoti hai.', h));
      if (nb) T(r, pick('If you order ' + when.en + ', your batch would be: **' + nb + '**.', 'Agar ' + when.hi + ' order karo to tumhara batch: **' + nb + '**.', h));
      T(r, pick('Sometimes a run can slip by a day — we tell you on WhatsApp if that happens.', 'Kabhi kabhi run ek din late ho sakta hai — aisa hua to WhatsApp pe bata dete hain.', h));
      r.chips = [pick('Which areas do you serve?', 'Kaun se areas mein delivery hai?', h), pick('Payment kaise hota hai?', 'Payment kaise hota hai?', h)];
      return r;
    },
    areas: function (h) {
      var r = R();
      T(r, pick('We serve campuses in **Nerul, Vashi and Belapur** (Navi Mumbai). Delivery is to the campus spot you enter at checkout (hostel, department or another on-campus point).',
        'Hum **Nerul, Vashi aur Belapur** (Navi Mumbai) ke campuses serve karte hain. Delivery checkout mein diye campus spot pe hoti hai (hostel, department ya koi on-campus point).', h));
      r.chips = [pick('When is my delivery?', 'Delivery kab hogi?', h)]; return r;
    },
    payment: function (h) {
      var r = R(), p = advPct();
      T(r, pick('Payment is in two parts: a **' + p + '% advance via UPI** (scan the QR at checkout) to confirm the order, and the **remaining ' + (100 - p) + '% in cash on delivery (COD)**.',
        'Payment do hisson mein hota hai: order confirm karne ke liye **' + p + '% advance UPI se** (checkout pe QR scan karo), aur **baaki ' + (100 - p) + '% cash on delivery (COD)**.', h));
      T(r, pick('Prices at checkout are final for that order. Advance is generally non-refundable once we\'ve sourced your items — see the refund policy.',
        'Checkout ka price us order ke liye final hota hai. Items source hone ke baad advance generally non-refundable hota hai — refund policy dekho.', h));
      r.chips = [pick('Refund policy', 'Refund policy kya hai?', h)]; return r;
    },
    'return': function (h) {
      var r = R();
      T(r, pick('You can request a **return or replacement within 7 days of delivery** if an item is defective, damaged or incorrect. Open **My Orders** on the site and tap Return or Replace on that order — we\'ll follow up on WhatsApp.',
        'Item defective, damaged ya galat ho to **delivery ke 7 din ke andar return ya replacement** maang sakte ho. Site pe **My Orders** kholo aur us order pe Return ya Replace dabao — hum WhatsApp pe follow up karenge.', h));
      T(r, pick('The item should be unused and as received (unless it arrived damaged/defective). After 7 days requests aren\'t accepted, except a genuine defect found later.',
        'Item unused aur jaisa mila waisa hona chahiye (damaged/defective ho to alag baat). 7 din ke baad request nahi li jaati, sirf genuine defect baad mein mile to exception.', h));
      var dl0 = G(function () { return state.orders.filter(function (x) { return x.deliveredAt; })[0]; }, null);
      if (dl0) {
        var ds = Math.floor((Date.now() - new Date(dl0.deliveredAt).getTime()) / 864e5);
        if (!isNaN(ds) && ds >= 0) T(r, pick('Your most recent delivered order **#' + dl0.id + '** was delivered ' + ds + ' day(s) ago — ' + (ds <= 7 ? 'you are still inside the 7-day window.' : 'the 7-day window has passed (a genuine defect found later can still be raised with the owner).'),
          'Tumhara sabse recent delivered order **#' + dl0.id + '** ' + ds + ' din pehle deliver hua — ' + (ds <= 7 ? 'tum abhi 7-din ki window ke andar ho.' : '7-din ki window nikal chuki hai (baad mein mila genuine defect owner ko bata sakte ho).'), h));
      }
      BTN(r, pick('Read full policy', 'Poori policy padho', h), 'policy.html');
      r.chips = [pick('Refund policy', 'Refund policy kya hai?', h)]; return r;
    },
    refund: function (h) {
      var r = R();
      T(r, pick('Refund rules:\n• Advance is **generally non-refundable** once we\'ve sourced your order (we\'ve already bought the part).\n• If **we** can\'t fulfil your order at all, the advance is refunded in full or adjusted on a future order — your choice.\n• Approved return for a defective/wrong item: replacement or full refund for that item.\n• Refunds are processed manually via UPI within a few days of approval.',
        'Refund rules:\n• Order source ho jaane ke baad advance **generally non-refundable** hota hai (part hum already kharid chuke hote hain).\n• Agar **hum** order fulfil hi nahi kar paaye to advance poora refund ya agle order mein adjust — tumhari choice.\n• Defective/galat item ka return approve ho to replacement ya us item ka poora refund.\n• Refund manually UPI se approval ke kuch din mein hota hai.', h));
      BTN(r, pick('Read full policy', 'Poori policy padho', h), 'policy.html'); return r;
    },
    contact: function (h) {
      var r = R();
      T(r, pick('Best way to reach us is WhatsApp (+' + waNumber().replace(/^91/, '91 ') + '). It\'s a small student-run team and the owner reads messages personally.',
        'Sabse best tarika WhatsApp hai (+' + waNumber().replace(/^91/, '91 ') + '). Chhoti student-run team hai aur owner khud messages padhta hai.', h));
      BTN(r, pick('Chat on WhatsApp', 'WhatsApp pe chat karo', h), waLink('Hi CircuitRun, I have a question.')); return r;
    },
    track: function (h) {
      var r = R(), o = G(function () { return state.orders[0]; }, null);
      if (o && o.id) {
        var tail = ' (advance ' + rupee(o.advance) + ', COD ' + rupee(o.cod) + ').' + (o.batchLabel ? ' Batch run: ' + o.batchLabel + '.' : '');
        T(r, pick('Your latest order **#' + o.id + '**: status **' + o.status + '**, total ' + rupee(o.subtotal) + tail, 'Tumhara latest order **#' + o.id + '**: status **' + o.status + '**, total ' + rupee(o.subtotal) + tail, h));
        T(r, pick('All your orders are under **📦 My Orders**.', 'Saare orders **📦 My Orders** mein hain.', h));
        return r;
      }
      T(r, pick('Open **📦 My Orders** at the top of the site (log in with your WhatsApp number) to see your orders and status — Confirmed → Packed → Out for Delivery → Delivered. Return/Replace buttons are there too.',
        'Site ke upar **📦 My Orders** kholo (WhatsApp number se login) — wahan orders aur status dikhega: Confirmed → Packed → Out for Delivery → Delivered. Return/Replace button bhi wahin hai.', h));
      return r;
    },
    login: function (h) {
      var r = R();
      T(r, pick('You can browse everything without logging in. To add to cart and order, you\'ll be asked for your name, WhatsApp number, year, college and department — there\'s no password or OTP.',
        'Bina login ke sab browse kar sakte ho. Cart mein add aur order karne ke liye naam, WhatsApp number, year, college aur department poochhte hain — password ya OTP nahi hai.', h));
      return r;
    },
    stock: function (h) {
      var r = R();
      T(r, pick('The site doesn\'t show live stock counts. Items are sourced per batch run, so for a specific item or a big quantity, message the owner on WhatsApp to confirm before ordering.',
        'Site pe live stock count nahi dikhta. Items batch run ke hisaab se source hote hain, isliye kisi specific item ya zyada quantity ke liye order se pehle owner ko WhatsApp karke confirm kar lo.', h));
      BTN(r, pick('Ask on WhatsApp', 'WhatsApp pe pucho', h), waLink('Hi CircuitRun, is this item available?')); return r;
    },
    discount: function (h) {
      var r = R();
      T(r, pick('If you have a **coupon code**, type it in the **"Have a coupon?"** box when you check out and tap Apply — the discount is applied to the order before the advance is calculated. Which items a code covers depends on the code, and some have a minimum cart value or an expiry date. If a code doesn\'t work, the message under the box tells you why. For a bulk or group order, you can ask the owner on WhatsApp.',
        'Agar tumhare paas **coupon code** hai to checkout pe **"Have a coupon?"** box mein daalo aur Apply dabao — discount order pe lagta hai, uske baad advance calculate hota hai. Code kin items pe chalega yeh code pe depend karta hai, kuch codes pe minimum cart value ya expiry date hoti hai. Code na chale to box ke neeche likha aata hai kyun. Bulk ya group order ke liye owner se WhatsApp pe pooch sakte ho.', h));
      BTN(r, pick('Ask on WhatsApp', 'WhatsApp pe pucho', h), waLink('Hi CircuitRun, I want to ask about a bulk order.')); return r;
    },
    request: function (h) {
      var r = R();
      T(r, pick('Can\'t find a component? Use the **"Request a component"** form on the site, or message the owner on WhatsApp with the part name.',
        'Component nahi mil raha? Site ka **"Request a component"** form use karo, ya part ka naam owner ko WhatsApp karo.', h));
      BTN(r, pick('Message on WhatsApp', 'WhatsApp pe bhejo', h), waLink('Hi CircuitRun, I need a component that is not listed: ')); return r;
    },
    about: function (h) {
      var r = R();
      T(r, pick('CircuitRun is a student-run electronics component delivery service for campuses in Nerul, Vashi and Belapur. We source parts in batch runs and deliver on campus.',
        'CircuitRun ek student-run electronics component delivery service hai jo Nerul, Vashi aur Belapur ke campuses ke liye hai. Hum parts batch runs mein source karke campus pe deliver karte hain.', h));
      BTN(r, pick('About us', 'About us', h), 'about.html'); return r;
    },
    privacy: function (h) {
      var r = R();
      T(r, pick('We collect only what an order needs: name, WhatsApp number, year, college, department, delivery location and order history. We don\'t sell or share it with advertisers. Being a small student-run team, we don\'t have a professionally audited security setup — so don\'t share anything sensitive beyond what the form asks.',
        'Hum sirf wahi lete hain jo order ke liye zaroori hai: naam, WhatsApp number, year, college, department, delivery location aur order history. Ye advertisers ko bechte ya share nahi karte. Chhoti student-run team hone ki wajah se professionally audited security setup nahi hai — isliye form ke alawa kuch sensitive share mat karo.', h));
      BTN(r, pick('Read policy', 'Policy padho', h), 'policy.html'); return r;
    },
    categories: function (h) {
      var r = R(), cats = {}, order = [];
      catalog().forEach(function (c) { if (!cats[c.cat]) { cats[c.cat] = 0; order.push(c.cat); } cats[c.cat]++; });
      if (!order.length) return fallbackReply(h);
      T(r, pick('We list **' + catalog().length + ' components** across these categories:', 'Hamare paas **' + catalog().length + ' components** in categories mein hain:', h));
      T(r, order.map(function (c) { var ic = G(function () { return CAT_ICON[c].icon; }, '•'); return ic + ' ' + c + ' (' + cats[c] + ')'; }).join('\n'));
      BTN(r, pick('Open catalog', 'Catalog kholo', h), 'catalog.html');
      r.chips = order.slice(0, 3).map(function (c) { return pick('Show ' + c, c + ' dikhao', h); });
      return r;
    },
    projlist: function (h, ctx) { return projectList(h); }
  };

  function starterChips(h) {
    return [pick('Project kits', 'Project kits dikhao', h), pick('Delivery kab hogi?', 'Delivery kab hogi?', h), pick('Payment kaise hota hai?', 'Payment kaise hota hai?', h), pick('Return policy', 'Return policy kya hai?', h), pick('Sensors under ₹100', '100 se kam sensors', h)];
  }

  function projectCost(p) {
    var total = 0, rows = [];
    for (var i = 0; i < p.parts.length; i++) {
      var it = byId(p.parts[i].id);
      if (!it) return null; // can't verify -> don't state a total
      total += it.price * p.parts[i].qty; rows.push({ it: it, qty: p.parts[i].qty });
    }
    return { total: total, rows: rows };
  }
  function projectList(h) {
    var ps = projects();
    if (!ps.length) return fallbackReply(h);
    var r = R();
    T(r, pick('Ready-made project kits (each has a parts list and a build manual):', 'Ready-made project kits (har ek mein parts list aur build manual hai):', h));
    LST(r, ps.map(function (p) {
      var c = projectCost(p);
      return { title: (p.emoji || '🚀') + ' ' + p.name, sub: (c ? 'Parts total ' + rupee(c.total) + ' · ' : '') + (p.desc || ''), href: 'project-detail.html?id=' + encodeURIComponent(p.id) };
    }));
    BTN(r, pick('All kits', 'Saare kits', h), 'projects.html');
    r.chips = ps.slice(0, 2).map(function (p) { return pick('Parts in ' + p.name, p.name + ' mein kya kya lagta hai?', h); });
    return r;
  }
  function projectCard(p, h) {
    var r = R(), c = projectCost(p);
    T(r, (p.emoji || '🚀') + ' **' + p.name + '**');
    if (p.desc) T(r, p.desc);
    if (p.info) T(r, p.info);
    if (c) {
      T(r, pick('Parts:', 'Parts:', h) + '\n' + c.rows.map(function (x) { return '• ' + x.it.name + ' × ' + x.qty + ' — ' + rupee(x.it.price * x.qty); }).join('\n'));
      T(r, pick('Parts total (at current catalog prices): **' + rupee(c.total) + '**', 'Parts ka total (abhi ke catalog prices pe): **' + rupee(c.total) + '**', h));
    } else {
      T(r, pick('Open the kit page for the full parts list and prices.', 'Poori parts list aur prices ke liye kit page kholo.', h));
    }
    BTN(r, pick('Open kit page', 'Kit page kholo', h), 'project-detail.html?id=' + encodeURIComponent(p.id));
    if (c) r.parts.push({ t: 'addall', label: pick('Add all parts to cart', 'Saare parts cart mein daalo', h), items: c.rows.map(function (x) { return { id: x.it.id, qty: x.qty }; }) });
    setCtx('project', p.id);
    return r;
  }

  /* ---------- search-driven handlers ---------- */
  var CMP = /\b(vs|versus|compare|comparison|difference between|difference|farak|better)\b/;
  function handleCompare(t, h) {
    var s = norm(t).replace(/\b(compare|comparison|difference between|difference|farak|between|which is better|better|kaun sa|kya)\b/g, ' ');
    var sides = s.split(/\b(?:vs|versus|and|aur|or|ya|with|ya phir)\b|,/).map(function (x) { return contentWords(x); }).filter(function (w) { return w.length; });
    if (sides.length < 2) return null;
    var found = [];
    for (var i = 0; i < sides.length && found.length < 3; i++) {
      var m = searchProducts(sides[i], 1)[0];
      if (m && found.every(function (f) { return f.id !== m.item.id; })) found.push(m.item);
    }
    if (found.length < 2) return null;
    var r = R();
    T(r, pick('Side by side (from our listed specs):', 'Side by side (hamare listed specs ke hisaab se):', h));
    found.forEach(function (it) { T(r, '**' + it.name + '** — ' + rupee(it.price) + '\n' + firstLines(it, 5).map(function (l) { return '• ' + l; }).join('\n')); });
    T(r, pick('Which one is "better" depends on your project — tell me what you\'re building and I\'ll point to the matching kit or parts.',
      'Kaunsa "better" hai ye tumhare project pe depend karta hai — batao kya bana rahe ho, main matching kit ya parts bata dunga.', h));
    LST(r, found.map(productRow));
    return r;
  }

  function handlePrice(t, h) { // budget / cheapest queries
    var n = norm(t), m = n.match(/(?:under|below|less than|within|upto|up to|max|budget|<)\s*(?:rs\s*)?(\d{2,5})/) || n.match(/(?:rs\s*)?(\d{2,5})\s*(?:rs\s*)?(?:se kam|ke andar|tak|ke niche|or less|and below|below|under)/);
    var cheap = /\b(cheapest|cheap|sasta|sabse sasta|lowest price|low price|affordable)\b/.test(n);
    if (!m && !cheap) return null;
    var cap = m ? parseInt(m[1], 10) : Infinity;
    var rest = contentWords(n.replace(/(?:under|below|less than|within|upto|up to|max|budget)\s*(?:rs\s*)?\d+/g, ' ').replace(/(?:rs\s*)?\d+\s*(?:rs\s*)?(?:se kam|ke andar|tak|ke niche|or less|and below|below|under)/g, ' ').replace(/\b(cheapest|cheap|sasta|sabse|lowest|low|affordable|components?|parts?|items?|things?)\b/g, ' '));
    buildIndex();
    var pool = idx.items;
    if (rest.length) {
      pool = pool.filter(function (d) {
        return rest.some(function (q) { return Math.max(bestIn(q, d.cat), bestIn(q, d.name), bestIn(q, d.spec)) >= 0.8; });
      });
    }
    var items = pool.map(function (d) { return d.it; }).filter(function (it) { return it.price <= cap; }).sort(function (a, b) { return a.price - b.price; });
    var r = R();
    if (!items.length) {
      T(r, pick('I couldn\'t find anything matching that budget in our listed items.', 'Is budget mein koi matching item hamari list mein nahi mila.', h));
      BTN(r, pick('Open catalog', 'Catalog kholo', h), 'catalog.html'); return r;
    }
    var total = items.length; items = items.slice(0, 6);
    T(r, pick(total + ' match' + (total > 1 ? 'es' : '') + (isFinite(cap) ? ' up to ' + rupee(cap) : '') + ' (cheapest first' + (total > 6 ? ', showing 6' : '') + '):',
      total + ' item' + (isFinite(cap) ? ' ' + rupee(cap) + ' tak' : '') + ' mile (sabse sasta pehle' + (total > 6 ? ', 6 dikha raha hoon' : '') + '):', h));
    LST(r, items.map(productRow));
    if (total > 6) BTN(r, pick('See more in catalog', 'Catalog mein aur dekho', h), 'catalog.html');
    return r;
  }

  function handleCategory(qw, h) {
    var cats = {}; catalog().forEach(function (c) { cats[c.cat] = 1; });
    var hit = null, best = 0;
    Object.keys(cats).forEach(function (c) {
      var cw = words(c).filter(function (w) { return w.length > 2 && w !== 'and'; });
      var all = qw.length && qw.every(function (q) { return cw.some(function (w) { return tokMatch(q, w) >= 0.8; }); });
      if (all && qw.length >= best) { hit = c; best = qw.length; }
    });
    if (!hit) return null;
    var items = catalog().filter(function (c) { return c.cat === hit; });
    var r = R();
    T(r, pick(items.length + ' items in **' + hit + '**' + (items.length > 8 ? ' (showing 8)' : '') + ':', '**' + hit + '** mein ' + items.length + ' items' + (items.length > 8 ? ' (8 dikha raha hoon)' : '') + ':', h));
    LST(r, items.slice(0, 8).map(productRow));
    BTN(r, pick('Open catalog', 'Catalog kholo', h), 'catalog.html');
    return r;
  }

  function handleProduct(qw, h, raw) {
    var res = searchProducts(qw, 4);
    if (!res.length) return null;
    var top = res[0], second = res[1];
    var clear = !second || top.score >= second.score * 1.6 || top.coverage > second.coverage;
    if (top.coverage < 1) {
      var r0 = R();
      T(r0, pick('I couldn\'t find an exact match for that. Closest items in our list:', 'Exact match nahi mila. Hamari list mein sabse close ye hain:', h));
      LST(r0, res.filter(function (x) { return x.score >= top.score * 0.5; }).slice(0, 3).map(function (x) { return productRow(x.item); }));
      BTN(r0, pick('Request a component', 'Component request karo', h), waLink('Hi CircuitRun, I need this component: ' + String(raw || '').slice(0, 80)));
      return r0;
    }
    if (res.length === 1 || clear) return productCard(top.item, h);
    var r = R(); ctx = { product: null, project: null };
    T(r, pick('Which one do you mean?', 'Inme se kaunsa chahiye?', h));
    LST(r, res.filter(function (x) { return x.coverage >= top.coverage && x.score >= top.score * 0.5; }).map(function (x) { return productRow(x.item); }));
    return r;
  }

  /* ---------- quantity totals: "2 arduino uno + 3 hc-sr04 total" ---------- */
  var TOTALW = /\b(total|kitna hoga|kitne ka hoga|kitne ke hoge|sum|bill|cost of|how much for|kul|all together|together)\b/;
  function clearHit(res) { var a = res[0], b = res[1]; return a && a.coverage >= 1 && (!b || a.score >= b.score * 1.6 || a.coverage > b.coverage) ? a : null; }
  function handleTotal(raw, t, h) {
    var segs = String(raw).toLowerCase().replace(/([a-z])-(\d)/g, '$1$2').replace(/\b(dht|esp|mq|lm|ne|hx|sg|mg|ds|tp|uln|nrf|ir|hc|sr) (\d{1,4})\b/g, '$1$2').split(/\s*(?:\+|,|\band\b|\baur\b)\s*/), items = [], lines = [], total = 0, bad = 0, hasQty = false, anyQty1 = false;
    segs.forEach(function (seg) {
      var qty = 1, name = seg, m;
      if ((m = seg.match(/(?:^|\s)(\d{1,2})\s*(?:x|×|pcs|pc|pieces|piece|nos)?\s+([a-z].*)$/))) { qty = parseInt(m[1], 10); name = m[2]; }
      else if ((m = seg.match(/^(.*[a-z])\s*(?:x|×)\s*(\d{1,2})\b/))) { qty = parseInt(m[2], 10); name = m[1]; }
      if (qty > 1) hasQty = true;
      var cw = contentWords(name.replace(TOTALW, ' '));
      if (!cw.length) return;
      var top = clearHit(searchProducts(cw, 3));
      if (!top) { bad++; return; }
      if (qty < 1) qty = 1;
      items.push({ id: top.item.id, qty: qty }); total += top.item.price * qty;
      lines.push('• ' + top.item.name + ' × ' + qty + ' = ' + rupee(top.item.price * qty));
    });
    if (bad || !items.length || !(TOTALW.test(t) || hasQty)) return null;
    if (items.length === 1 && items[0].qty === 1) return null;
    var adv = Math.max(1, Math.round(total * G(function () { return ADVANCE_PCT; }, 0.2))), r = R();
    T(r, pick('Here\'s the items total:', 'Items ka total ye raha:', h));
    T(r, lines.join('\n'));
    T(r, pick('Items total: **' + rupee(total) + '** — roughly ' + rupee(adv) + ' advance via UPI and ' + rupee(total - adv) + ' on delivery. The final amount is shown at checkout.',
      'Items total: **' + rupee(total) + '** — lagbhag ' + rupee(adv) + ' advance UPI se aur ' + rupee(total - adv) + ' delivery pe. Final amount checkout pe dikhega.', h));
    r.parts.push({ t: 'addall', label: pick('Add all to cart', 'Sab cart mein daalo', h), items: items });
    r.chips = [pick('Delivery kab hogi?', 'Delivery kab hogi?', h)];
    return r;
  }

  /* ---------- follow-ups: "its price", "add it", "specs?" ---------- */
  var PRON = /\b(its|it|iska|iski|iske|isko|isme|this|that|ye|yeh|woh|wo|same)\b/;
  function followUp(t, qw, h) {
    if (!ctx.product && !ctx.project) return null;
    var pron = PRON.test(t), bare = !qw.length;
    if (!pron && !bare) return null;
    if (!bare && searchProducts(qw, 1)[0]) return null;
    var price = /\b(price|cost|rate|kitn\w*|kimat|daam|dam|how much)\b/.test(t), spec = /\b(spec|specs|detail|details|info|feature|features|about)\b/.test(t),
      add = /\b(add|cart|order|buy|lena|le lo|lelo|kharid\w*)\b/.test(t), stock = /\b(stock|availab\w*)\b/.test(t), parts = /\b(parts|need|chahiye|components|kya kya)\b/.test(t);
    if (!(price || spec || add || stock || parts)) return null;
    var it = ctx.product ? byId(ctx.product) : null, pr = ctx.project ? projects().filter(function (x) { return x.id === ctx.project; })[0] : null, r = R();
    if (it) {
      if (stock) return handlers.stock(h);
      if (add) { T(r, pick('Here you go:', 'Ye lo:', h)); LST(r, [productRow(it)]); return r; }
      if (price && !spec) { T(r, '**' + it.name + '** — ' + rupee(it.price)); r.chips = [pick('Delivery kab hogi?', 'Delivery kab hogi?', h)]; return r; }
      return productCard(it, h);
    }
    if (pr) {
      var c = projectCost(pr);
      if (add && c) { T(r, pick('Adding the whole kit:', 'Poora kit add karte hain:', h)); r.parts.push({ t: 'addall', label: pick('Add all parts to cart', 'Saare parts cart mein daalo', h), items: c.rows.map(function (x) { return { id: x.it.id, qty: x.qty }; }) }); return r; }
      if (price && c && !spec && !parts) { T(r, pick('Parts total for **' + pr.name + '**: **' + rupee(c.total) + '** (at current catalog prices).', '**' + pr.name + '** ke parts ka total: **' + rupee(c.total) + '** (abhi ke catalog prices pe).', h)); return r; }
      return projectCard(pr, h);
    }
    return null;
  }

  var RECO = /\b(recommend|suggest|for my project|ke liye|best (parts|components)|which components|what (do|should) i (need|use|buy)|kya (lena|chahiye|use)|idea)\b/;
  function recoReply(h) {
    var r = R();
    T(r, pick('I don\'t have a ready-made kit that matches that, and I won\'t guess a parts list. Tell the owner your idea on WhatsApp, or look at the ready kits:',
      'Is ke liye mere paas ready-made kit nahi hai, aur main andaaza se parts list nahi banaunga. Apna idea owner ko WhatsApp karo, ya ready kits dekho:', h));
    BTN(r, pick('Share my idea on WhatsApp', 'Idea WhatsApp pe bhejo', h), waLink('Hi CircuitRun, I want to build: '));
    var ps = projects(); if (ps.length) LST(r, ps.map(function (p) { return { title: (p.emoji || '🚀') + ' ' + p.name, sub: p.desc || '', href: 'project-detail.html?id=' + encodeURIComponent(p.id) }; }));
    r.fallback = true; return r;
  }

  function fallbackReply(h) {
    var r = R();
    T(r, pick('I\'m not sure about that one, and I\'d rather not guess. You can ask the owner directly, or try asking about a component name, a project kit, delivery, payment or returns.',
      'Iska mujhe pakka jawab nahi pata, aur main andaaza nahi lagana chahta. Owner se seedha pooch sakte ho, ya component ka naam, project kit, delivery, payment ya returns ke baare mein pucho.', h));
    BTN(r, pick('Ask the owner on WhatsApp', 'Owner ko WhatsApp karo', h), waLink('Hi CircuitRun, I have a question: '));
    r.chips = starterChips(h); r.fallback = true; return r;
  }

  /* ---------- main router ---------- */
  function route(text) {
    var h = isHinglish(text), t = norm(text);
    if (!t) return fallbackReply(h);
    var intent = detectIntent(t);
    var qw = contentWords(text).filter(function (w) { return !/^\d{1,2}$/.test(w); }); // stray quantities like "top 3" / "2" are not part names

    // quick conversational intents first
    if (intent === 'ack' || intent === 'greet' || intent === 'thanks' || intent === 'bye' || intent === 'whoami' || intent === 'help') return handlers[intent](h);

    // compare
    if (CMP.test(t)) { var c = handleCompare(t, h); if (c) return c; }

    // budget / cheapest
    var pr = handlePrice(t, h); if (pr) return pr;
    var tot = handleTotal(text, t, h); if (tot) return tot;

    // specific project by name/description
    if (!/^(refund|return|payment|delivery|areas|contact|track|login|privacy)$/.test(intent || '')) {
      var pm = searchProjects(qw.filter(function (w) { return !/^(project|kit|mini|major|final|year|idea|diy)$/.test(w); }));
      var pp = searchProducts(qw, 1)[0];
      var productWins = pp && pp.coverage >= 1 && intent !== 'projlist' && pm.length && pp.score >= pm[0].score;
      if (pm.length && !productWins && (intent === 'projlist' || pm[0].score >= 3)) return projectCard(pm[0].proj, h);
    }
    if (intent === 'projlist' && !qw.filter(function (w) { return !/^(project|kit|mini|major|final|year|idea|diy|ready|made|available|sab|all)$/.test(w); }).length) return projectList(h);
    if (intent === 'categories') return handlers.categories(h);

    // policy / info intents
    if (intent && !NOT_INFO.test(intent)) {
      var infos = detectIntents(t).filter(function (x) { return !NOT_INFO.test(x); }).slice(0, 2);
      return mergeReplies(infos.map(function (x) { return handlers[x](h, text); }));
    }

    // follow-ups that lean on the previous answer
    var fu = followUp(t, qw, h); if (fu) return fu;

    // category browse
    var cat = handleCategory(qw, h); if (cat) return cat;

    // product lookup
    var prod = handleProduct(qw, h, text);
    if (prod && intent === 'stock') { T(prod, pick('Note: the site shows no live stock — confirm availability on WhatsApp before ordering.', 'Note: site pe live stock nahi dikhta — order se pehle WhatsApp pe availability confirm kar lo.', h)); }
    if (prod) return prod;

    if (intent) return handlers[intent](h, text);
    if (RECO.test(t)) return recoReply(h);
    return fallbackReply(h);
  }
  function answer(text) {
    var r = route(text), k = detectIntent(norm(text));
    r.kind = r.fallback ? 'fallback' : (k || 'search');
    r.fb = !/^(ack|greet|thanks|bye)$/.test(k || '');
    return r;
  }

  /* ---------- robot mascot (original design, inline SVG constant) ---------- */
  var ROBOT = '<svg viewBox="0 0 64 60" aria-hidden="true" focusable="false">' +
    '<g class="crb-ant"><line x1="32" y1="12" x2="32" y2="6" stroke="#C6FF3D" stroke-width="2.4" stroke-linecap="round"/><circle class="crb-bulb" cx="32" cy="4.6" r="3.4" fill="#C6FF3D"/></g>' +
    '<g class="crb-head"><rect x="11" y="12" width="42" height="37" rx="13" fill="#1C1C27" stroke="#C6FF3D" stroke-width="2.4"/>' +
    '<rect x="5.5" y="25" width="5" height="12" rx="2.5" fill="#FF5FA8"/><rect x="53.5" y="25" width="5" height="12" rx="2.5" fill="#FF5FA8"/>' +
    '<rect x="17" y="20" width="30" height="17" rx="8.5" fill="#12121A" stroke="#2C2C39"/>' +
    '<g class="crb-look"><g class="crb-eyes"><rect class="crb-eye" x="22.5" y="24.5" width="6" height="8" rx="3" fill="#4DE8FF"/><rect class="crb-eye" x="35.5" y="24.5" width="6" height="8" rx="3" fill="#4DE8FF"/></g></g>' +
    '<path class="m-smile" d="M26 42.5Q32 47.5 38 42.5" fill="none" stroke="#4DE8FF" stroke-width="2" stroke-linecap="round"/>' +
    '<path class="m-flat" d="M27.5 44H36.5" fill="none" stroke="#4DE8FF" stroke-width="2" stroke-linecap="round"/>' +
    '<path class="m-oops" d="M26 45.5Q32 41.5 38 45.5" fill="none" stroke="#FF5FA8" stroke-width="2" stroke-linecap="round"/></g></svg>';
  function robot(cls) { var s = document.createElement('span'); s.className = 'crb-av ' + (cls || ''); s.innerHTML = ROBOT; return s; }

  var reduceMotion = G(function () { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }, false);
  var moodT = 0;
  function setMood(m, ms) {
    clearTimeout(moodT);
    var live = document.querySelectorAll('.crb-live');
    for (var i = 0; i < live.length; i++) { live[i].classList.remove('crb-think', 'crb-happy', 'crb-oops'); if (m) live[i].classList.add('crb-' + m); }
    if (m && ms) moodT = setTimeout(function () { setMood(''); }, ms);
  }
  var raf = 0;
  function trackEyes() {
    if (reduceMotion || !G(function () { return window.matchMedia('(pointer: fine)').matches; }, false)) return;
    document.addEventListener('pointermove', function (e) {
      if (raf) return;
      var x = e.clientX, y = e.clientY;
      raf = requestAnimationFrame(function () {
        raf = 0;
        var live = document.querySelectorAll('.crb-live');
        for (var i = 0; i < live.length; i++) {
          var r = live[i].getBoundingClientRect(); if (!r.width) continue;
          var dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2), d = Math.sqrt(dx * dx + dy * dy) || 1, k = Math.min(1, d / 160);
          live[i].style.setProperty('--ex', (dx / d * 2.6 * k).toFixed(2) + 'px');
          live[i].style.setProperty('--ey', (dy / d * 2 * k).toFixed(2) + 'px');
        }
      });
    }, { passive: true });
  }

  /* ---------- UI ---------- */
  var css = '' +
    '@keyframes crb-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}' +
    '@keyframes crb-blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}' +
    '@keyframes crb-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(1.35)}}' +
    '@keyframes crb-glow{0%,100%{box-shadow:0 0 0 0 rgba(198,255,61,.5),0 8px 24px rgba(0,0,0,.5)}60%{box-shadow:0 0 0 12px rgba(198,255,61,0),0 8px 24px rgba(0,0,0,.5)}}' +
    '@keyframes crb-hop{0%,100%{transform:translateY(0)}35%{transform:translateY(-5px) rotate(-4deg)}65%{transform:translateY(0) rotate(3deg)}}' +
    '@keyframes crb-look{0%,100%{transform:translate(0,0)}25%{transform:translate(-2px,-1.5px)}75%{transform:translate(2px,-1.5px)}}' +
    '@keyframes crb-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}' +
    '@keyframes crb-pop{from{opacity:0;transform:scale(.88) translateY(10px)}to{opacity:1;transform:none}}' +
    '@keyframes crb-dot{0%,80%,100%{transform:translateY(0);opacity:.4}40%{transform:translateY(-4px);opacity:1}}' +
    '@keyframes crb-wave{0%,100%{transform:rotate(0)}25%{transform:rotate(-10deg)}75%{transform:rotate(8deg)}}' +
    '.crb-av{display:inline-block;flex:0 0 auto}.crb-av svg{width:100%;height:100%;display:block;overflow:visible}' +
    '.crb-eyes{transform:translate(var(--ex,0px),var(--ey,0px));transition:transform .12s ease-out}' +
    '.crb-eye{transform-box:fill-box;transform-origin:center;animation:crb-blink 5.5s infinite}' +
    '.crb-bulb{transform-box:fill-box;transform-origin:center;animation:crb-pulse 1.8s ease-in-out infinite;filter:drop-shadow(0 0 3px #C6FF3D)}' +
    '.m-flat,.m-oops{display:none}' +
    '.crb-think .crb-look{animation:crb-look 1.1s ease-in-out infinite}.crb-think .m-smile{display:none}.crb-think .m-flat{display:inline}.crb-think .crb-bulb{fill:#4DE8FF;animation-duration:.45s}' +
    '.crb-happy .crb-eye{animation:none;transform:scaleY(.55)}.crb-happy svg{animation:crb-hop .7s ease-out}' +
    '.crb-oops .m-smile{display:none}.crb-oops .m-oops{display:inline}.crb-oops .crb-eye{animation:none;transform:scaleY(.8)}' +
    '.crb-static .crb-eye,.crb-static .crb-bulb{animation:none}' +
    '#crbot-fab{position:fixed;right:16px;bottom:16px;width:62px;height:62px;border-radius:50%;border:2px solid #C6FF3D;background:#1C1C27;padding:0;cursor:pointer;z-index:35;display:flex;align-items:center;justify-content:center;animation:crb-glow 2.6s infinite;transition:transform .15s}' +
    '#crbot-fab .crb-av{width:44px;height:41px;animation:crb-float 3.2s ease-in-out infinite}' +
    '#crbot-fab:hover{transform:scale(1.07)}#crbot-fab:hover .crb-av{animation:crb-wave .7s ease-in-out}' +
    '#crbot-tip{position:fixed;right:16px;bottom:88px;max-width:220px;background:#1C1C27;border:1px solid #C6FF3D;color:#F4F3F7;border-radius:14px 14px 4px 14px;padding:9px 28px 9px 12px;font:13px/1.35 Inter,system-ui,sans-serif;z-index:35;display:none;cursor:pointer;animation:crb-pop .25s ease-out;box-shadow:0 8px 24px rgba(0,0,0,.45)}' +
    '#crbot-tip.show{display:block}#crbot-tip button{position:absolute;top:2px;right:4px;background:none;border:0;color:#9A98A8;font-size:15px;cursor:pointer;padding:4px}' +
    '#crbot-panel{position:fixed;right:16px;bottom:90px;width:370px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 116px);background:#17171F;border:1px solid #2C2C39;border-radius:18px;z-index:36;display:none;flex-direction:column;box-shadow:0 18px 50px rgba(0,0,0,.55);overflow:hidden;font-family:Inter,system-ui,sans-serif;color:#F4F3F7;transform-origin:bottom right}' +
    '#crbot-panel.open{display:flex;animation:crb-pop .2s ease-out}' +
    '#crbot-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #2C2C39;background:#1C1C27}' +
    '#crbot-head .crb-av{width:40px;height:37px}' +
    '#crbot-head .t{flex:1;min-width:0}#crbot-head b{font-size:14px;display:block}#crbot-head small{color:#9A98A8;font-size:11px;display:block}' +
    '.crb-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#C6FF3D;margin-right:5px;animation:crb-pulse 2s infinite}' +
    '#crbot-head button{background:none;border:0;color:#9A98A8;font-size:18px;cursor:pointer;padding:4px 6px}' +
    '#crbot-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain}' +
    '.crb-line{display:flex;gap:8px;align-items:flex-end;align-self:flex-start;max-width:96%;animation:crb-in .22s ease-out}' +
    '.crb-line .crb-av{width:26px;height:24px;margin-bottom:2px}.crb-line .crb-m{max-width:none;min-width:0}' +
    '.crb-m{max-width:88%;padding:9px 12px;border-radius:14px;font-size:13.5px;line-height:1.45;word-wrap:break-word;overflow-wrap:anywhere}' +
    '.crb-m p{margin:0 0 6px;white-space:pre-wrap}.crb-m p:last-child{margin-bottom:0}' +
    '.crb-u{align-self:flex-end;background:#C6FF3D;color:#12121A;border-bottom-right-radius:4px;animation:crb-in .22s ease-out}' +
    '.crb-b{align-self:flex-start;background:#1C1C27;border:1px solid #2C2C39;border-bottom-left-radius:4px}' +
    '.crb-row{display:flex;align-items:center;gap:8px;padding:8px;margin-top:6px;border:1px solid #2C2C39;border-radius:10px;background:#12121A}' +
    '.crb-row .i{flex:1;min-width:0}.crb-row a{color:#4DE8FF;text-decoration:none;font-weight:600;font-size:13px;display:block}' +
    '.crb-row small{color:#9A98A8;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}' +
    '.crb-row button,.crb-addall{background:#C6FF3D;color:#12121A;border:0;border-radius:8px;font-weight:700;font-size:12px;padding:6px 10px;cursor:pointer;white-space:nowrap}' +
    '.crb-addall{display:block;width:100%;margin-top:8px;padding:8px;border-radius:10px;font-size:12.5px}.crb-addall[disabled]{opacity:.7;cursor:default}' +
    '.crb-more{margin-top:6px;background:#12121A;border:1px solid #2C2C39;color:#F4F3F7;border-radius:999px;padding:4px 11px;font-size:12px;cursor:pointer}' +
    '.crb-link{display:inline-block;margin-top:6px;background:#12121A;border:1px solid #4DE8FF;color:#4DE8FF;border-radius:999px;padding:6px 12px;font-size:12.5px;text-decoration:none;font-weight:600}' +
    '.crb-fb{display:flex;gap:6px;align-items:center;margin-top:8px;color:#9A98A8;font-size:11.5px}.crb-fb button{background:none;border:1px solid #2C2C39;border-radius:999px;color:#F4F3F7;padding:2px 9px;cursor:pointer;font-size:13px}.crb-fb a{color:#4DE8FF}' +
    '#crbot-chips{display:flex;gap:6px;padding:8px 12px 0;overflow-x:auto;flex-shrink:0;scrollbar-width:none}#crbot-chips::-webkit-scrollbar{display:none}' +
    '#crbot-chips button{flex:0 0 auto;background:#1C1C27;border:1px solid #2C2C39;color:#F4F3F7;border-radius:999px;padding:6px 11px;font-size:12px;cursor:pointer;white-space:nowrap}' +
    '#crbot-chips button:hover{border-color:#C6FF3D}' +
    '#crbot-in{display:flex;gap:8px;padding:10px 12px 12px}' +
    '#crbot-in input{flex:1;min-width:0;background:#12121A;border:1px solid #2C2C39;color:#F4F3F7;border-radius:999px;padding:10px 14px;font-size:16px;outline:none}' +
    '#crbot-in input:focus{border-color:#C6FF3D}' +
    '#crbot-in button{background:#C6FF3D;color:#12121A;border:0;border-radius:999px;width:42px;font-weight:800;font-size:16px;cursor:pointer}' +
    '.crb-ai{display:inline-block;font-size:10px;font-weight:700;color:#12121A;background:#4DE8FF;border-radius:6px;padding:1px 6px;margin-bottom:5px}' +
    '.crb-dots{display:flex;gap:4px;padding:12px 14px}.crb-dots i{width:6px;height:6px;border-radius:50%;background:#9A98A8;animation:crb-dot 1s infinite}.crb-dots i:nth-child(2){animation-delay:.15s}.crb-dots i:nth-child(3){animation-delay:.3s}' +
    'body:has(.drawer.show) #crbot-fab,body:has(.drawer.show) #crbot-panel,body:has(.drawer.show) #crbot-tip,body:has(.modal-overlay.show) #crbot-fab,body:has(.modal-overlay.show) #crbot-panel,body:has(.modal-overlay.show) #crbot-tip,body:has(.overlay.show) #crbot-fab,body:has(.overlay.show) #crbot-panel,body:has(.overlay.show) #crbot-tip{display:none!important}' +
    '@media(max-width:480px){#crbot-panel{right:8px;left:8px;width:auto;max-width:none;bottom:86px;height:calc(100vh - 106px)}#crbot-fab{right:12px;bottom:12px}#crbot-tip{right:12px;bottom:84px}}' +
    '@media(prefers-reduced-motion:reduce){#crbot-fab,#crbot-fab .crb-av,.crb-eye,.crb-bulb,.crb-look,.crb-av svg,.crb-line,.crb-u,#crbot-panel.open,#crbot-tip,.crb-dot,.crb-dots i{animation:none!important}.crb-eyes{transition:none}#crbot-fab{transition:none}}';

  var el = {}, history = [], busy = false;

  function loadHistory() { try { var v = JSON.parse(sessionStorage.getItem(CONFIG.storeKey) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function saveHistory() { try { sessionStorage.setItem(CONFIG.storeKey, JSON.stringify(history.slice(-CONFIG.maxHistory))); sessionStorage.setItem(CONFIG.storeKey + '_ctx', JSON.stringify(ctx)); } catch (e) { } }
  function loadCtx() { try { var c = JSON.parse(sessionStorage.getItem(CONFIG.storeKey + '_ctx') || 'null'); if (c && typeof c === 'object') ctx = { product: c.product || null, project: c.project || null }; } catch (e) { } }

  function mk(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function richText(p, s) { // **bold** only, via DOM (no innerHTML for user/DB text)
    String(s).split(/(\*\*[^*]+\*\*)/).forEach(function (seg) {
      if (/^\*\*[^*]+\*\*$/.test(seg)) p.appendChild(mk('strong', '', seg.slice(2, -2)));
      else if (seg) p.appendChild(document.createTextNode(seg));
    });
  }
  function safeHref(u) { return /^(https:\/\/wa\.me\/|[a-z0-9\-]+\.html(\?[a-zA-Z0-9=%&_.\-]*)?$)/.test(u) ? u : '#'; }

  function addToCart(id, qty) {
    try {
      if (!inCatalog(id)) return 'missing';
      if (!state.user) { pendingAddId = id; var lo = document.getElementById('loginOverlay'); if (lo) { lo.classList.add('show'); return 'login'; } return 'nologin'; }
      for (var i = 0; i < (qty || 1); i++) changeQty(id, 1);
      return 'ok';
    } catch (e) { return 'err'; }
  }
  function addAll(items) {
    try {
      for (var i = 0; i < items.length; i++) if (!inCatalog(items[i].id)) return 'missing';
      if (!state.user) { pendingAddId = items[0].id; var lo = document.getElementById('loginOverlay'); if (lo) { lo.classList.add('show'); return 'login'; } return 'nologin'; }
      items.forEach(function (x) { for (var k = 0; k < x.qty; k++) changeQty(x.id, 1); });
      return 'ok';
    } catch (e) { return 'err'; }
  }

  function renderBot(reply, ai, q) {
    var m = mk('div', 'crb-m crb-b');
    if (ai) m.appendChild(mk('span', 'crb-ai', 'AI'));
    (reply.parts || []).forEach(function (p) {
      if (p.t === 'text') { var t = mk('p'); richText(t, p.v); m.appendChild(t); }
      else if (p.t === 'list') p.rows.forEach(function (row) {
        var d = mk('div', 'crb-row'), i = mk('div', 'i'), a = mk('a', '', row.title);
        a.href = safeHref(row.href);
        i.appendChild(a); if (row.sub) i.appendChild(mk('small', '', row.sub));
        d.appendChild(i);
        if (row.addId) {
          var b = mk('button', '', '+ Add'); b.type = 'button';
          b.addEventListener('click', function () {
            var res = addToCart(row.addId, 1);
            b.textContent = res === 'ok' ? '✓ Added' : (res === 'login' ? 'Log in first' : 'Open page');
            if (res === 'ok') setMood('happy', 1200);
            if (res === 'nologin' || res === 'missing' || res === 'err') window.location.href = safeHref(row.href);
          });
          d.appendChild(b);
        }
        m.appendChild(d);
      });
      else if (p.t === 'btn') { var l = mk('a', 'crb-link', p.label); l.href = safeHref(p.href); if (/^https:/.test(l.href)) { l.target = '_blank'; l.rel = 'noopener noreferrer'; } m.appendChild(l); }
      else if (p.t === 'more') {
        var mb = mk('button', 'crb-more', p.label || 'Show all specs'); mb.type = 'button';
        mb.addEventListener('click', function () { var t2 = mk('p'); t2.textContent = p.lines.map(function (x) { return '• ' + x; }).join('\n'); mb.replaceWith(t2); scroll(); });
        m.appendChild(mb);
      }
      else if (p.t === 'addall') {
        var ab = mk('button', 'crb-addall', p.label || 'Add all to cart'); ab.type = 'button';
        ab.addEventListener('click', function () {
          var res = addAll(p.items);
          if (res === 'ok') { ab.textContent = '✓ Added to cart'; ab.disabled = true; setMood('happy', 1400); }
          else if (res === 'login') ab.textContent = 'Log in first, then tap again';
          else ab.textContent = 'Some items unavailable — open the page';
        });
        m.appendChild(ab);
      }
    });
    if (reply.fb && q) {
      var fb = mk('div', 'crb-fb'); fb.appendChild(document.createTextNode('Helpful?'));
      [['👍', true], ['👎', false]].forEach(function (x) {
        var b = mk('button', '', x[0]); b.type = 'button'; b.setAttribute('aria-label', x[1] ? 'Helpful' : 'Not helpful');
        b.addEventListener('click', function () {
          logEvent(q, 'feedback', !reply.fallback, x[1]);
          fb.textContent = '';
          if (x[1]) fb.appendChild(document.createTextNode('Thanks! 🙌'));
          else { fb.appendChild(document.createTextNode('Sorry about that. ')); var wa = mk('a', '', 'Ask the owner'); wa.href = waLink('Hi CircuitRun, your assistant could not answer: ' + String(q).slice(0, 120)); wa.target = '_blank'; wa.rel = 'noopener noreferrer'; fb.appendChild(wa); }
        });
        fb.appendChild(b);
      });
      m.appendChild(fb);
    }
    return m;
  }
  function botLine(reply, ai, q) {
    var line = mk('div', 'crb-line');
    line.appendChild(robot('crb-static')); line.appendChild(renderBot(reply, ai, q));
    return line;
  }
  function renderChips(chips) {
    el.chips.textContent = '';
    (chips || []).forEach(function (c) {
      var b = mk('button', '', c); b.type = 'button';
      b.addEventListener('click', function () { send(c); });
      el.chips.appendChild(b);
    });
  }
  function scroll() { el.msgs.scrollTop = el.msgs.scrollHeight; }
  function pushUser(text) { el.msgs.appendChild(mk('div', 'crb-m crb-u', text)); scroll(); }
  function pushBot(reply, ai, q) { el.msgs.appendChild(botLine(reply, ai, q)); renderChips(reply.chips); scroll(); }
  function typingLine() {
    var line = mk('div', 'crb-line'), b = mk('div', 'crb-m crb-b crb-dots');
    line.appendChild(robot('crb-live crb-think')); b.appendChild(mk('i')); b.appendChild(mk('i')); b.appendChild(mk('i')); line.appendChild(b);
    line.setAttribute('role', 'status'); line.setAttribute('aria-label', 'Assistant is typing');
    return line;
  }

  /* optional anonymous logging (needs bot_logs table; silently skipped otherwise) */
  function redact(s) { return String(s).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').replace(/\d[\d\s-]{5,}\d/g, '[number]').slice(0, 200); }
  function logEvent(q, kind, answered, helpful) {
    if (!CONFIG.logQuestions) return;
    try {
      var d = G(function () { return db; }, null);
      if (!d || !d.from) return;
      var row = { question: redact(q), kind: String(kind || '').slice(0, 30), answered: !!answered, page: (location.pathname.split('/').pop() || 'index.html').slice(0, 60) };
      if (typeof helpful === 'boolean') row.helpful = helpful;
      var p = d.from('bot_logs').insert(row); if (p && p.then) p.then(function () { }, function () { });
    } catch (e) { }
  }

  function llmAsk(text) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, 20000);
    var msgs = [];
    history.slice(-8).forEach(function (hm) { if (hm.u) msgs.push({ role: 'user', content: hm.u }); else if (hm.plain) msgs.push({ role: 'assistant', content: hm.plain }); });
    var cat = catalog().map(function (c) { return c.name + ' | ' + rupee(c.price) + ' | ' + c.cat + ' | ' + (c.spec || ''); });
    var prj = projects().map(function (p) { return p.name + ': ' + (p.desc || ''); });
    return fetch(CONFIG.llmEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl ? ctrl.signal : undefined,
      body: JSON.stringify({ messages: msgs, catalog: cat, projects: prj })
    }).then(function (r) { clearTimeout(to); if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) { if (!j || typeof j.reply !== 'string' || !j.reply.trim()) throw new Error('empty'); return j.reply.trim().slice(0, 1800); });
  }
  function plainOf(reply) { return (reply.parts || []).map(function (p) { return p.t === 'text' ? p.v : p.t === 'list' ? p.rows.map(function (r) { return r.title + ' ' + r.sub; }).join('; ') : ''; }).join('\n').slice(0, 800); }

  function send(text) {
    text = String(text || '').trim().slice(0, 300);
    if (!text || busy) return;
    pushUser(text);
    // history for the LLM must not include this message twice: llmAsk reads history, so push after building msgs
    var h = isHinglish(text), reply;
    try { reply = answer(text); } catch (e) { reply = fallbackReply(h); reply.kind = 'fallback'; }
    history.push({ u: text });
    el.input.value = '';
    busy = true; setMood('think');
    var tp = typingLine(); el.msgs.appendChild(tp); scroll();
    var delay = reduceMotion ? 150 : Math.min(900, 350 + plainOf(reply).length * 0.5);
    setTimeout(function () {
      function done(r, ai) {
        tp.remove(); pushBot(r, ai, text);
        history.push({ r: r, ai: !!ai, plain: plainOf(r), q: text });
        saveHistory(); busy = false;
        setMood(r.fallback && !ai ? 'oops' : 'happy', 1500);
        logEvent(text, ai ? 'llm' : r.kind, !(r.fallback && !ai));
      }
      if (reply.fallback && CONFIG.llmEndpoint) {
        llmAsk(text).then(function (txt) { var r = R(); T(r, txt); r.chips = starterChips(h); r.fb = true; done(r, true); })
          .catch(function () { done(reply, false); });
      } else done(reply, false);
    }, delay);
  }

  function open(on) {
    el.panel.classList.toggle('open', on);
    el.fab.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) { hideTip(); setMood('happy', 1100); scroll(); setTimeout(function () { try { el.input.focus({ preventScroll: true }); } catch (e) { } }, 60); }
  }
  var tipT = 0;
  function hideTip() { clearTimeout(tipT); if (el.tip) el.tip.classList.remove('show'); try { sessionStorage.setItem(CONFIG.storeKey + '_tip', '1'); } catch (e) { } }
  function maybeTip() {
    var seen = false; try { seen = sessionStorage.getItem(CONFIG.storeKey + '_tip') === '1'; } catch (e) { }
    if (seen) return;
    tipT = setTimeout(function () {
      if (el.panel.classList.contains('open')) return;
      el.tip.classList.add('show'); setMood('happy', 1200);
      tipT = setTimeout(hideTip, 8000);
    }, 4500);
  }

  function init() {
    var st = mk('style'); st.textContent = css; document.head.appendChild(st);

    el.fab = mk('button'); el.fab.id = 'crbot-fab'; el.fab.type = 'button'; el.fab.setAttribute('aria-label', 'Open CircuitRun assistant'); el.fab.appendChild(robot('crb-live'));
    el.tip = mk('div'); el.tip.id = 'crbot-tip'; el.tip.appendChild(document.createTextNode('Need a part or have a question? Ask me ⚡'));
    var tx = mk('button', '', '✕'); tx.type = 'button'; tx.setAttribute('aria-label', 'Dismiss'); el.tip.appendChild(tx);
    el.panel = mk('div'); el.panel.id = 'crbot-panel'; el.panel.setAttribute('role', 'dialog'); el.panel.setAttribute('aria-label', 'CircuitRun assistant');
    var head = mk('div'); head.id = 'crbot-head';
    head.appendChild(robot('crb-live'));
    var tt = mk('div', 't'); tt.appendChild(mk('b', '', 'Volty · CircuitRun assistant'));
    var sm = mk('small'); sm.appendChild(mk('span', 'crb-dot')); sm.appendChild(document.createTextNode('Parts · Kits · Delivery')); tt.appendChild(sm);
    head.appendChild(tt);
    var clr = mk('button', '', '🗑'); clr.type = 'button'; clr.title = 'Clear chat'; clr.setAttribute('aria-label', 'Clear chat');
    var cls = mk('button', '', '✕'); cls.type = 'button'; cls.setAttribute('aria-label', 'Close chat');
    head.appendChild(clr); head.appendChild(cls);
    el.msgs = mk('div'); el.msgs.id = 'crbot-msgs'; el.msgs.setAttribute('aria-live', 'polite');
    el.chips = mk('div'); el.chips.id = 'crbot-chips';
    var inw = mk('div'); inw.id = 'crbot-in';
    el.input = mk('input'); el.input.type = 'text'; el.input.maxLength = 300; el.input.placeholder = 'Ask about a component, kit, delivery…'; el.input.setAttribute('aria-label', 'Message');
    var sb = mk('button', '', '➤'); sb.type = 'button'; sb.setAttribute('aria-label', 'Send');
    inw.appendChild(el.input); inw.appendChild(sb);
    el.panel.appendChild(head); el.panel.appendChild(el.msgs); el.panel.appendChild(el.chips); el.panel.appendChild(inw);
    document.body.appendChild(el.panel); document.body.appendChild(el.tip); document.body.appendChild(el.fab);

    el.fab.addEventListener('click', function () { open(!el.panel.classList.contains('open')); });
    el.tip.addEventListener('click', function (e) { if (e.target === tx) { hideTip(); return; } hideTip(); open(true); });
    cls.addEventListener('click', function () { open(false); });
    clr.addEventListener('click', function () { history = []; ctx = { product: null, project: null }; saveHistory(); el.msgs.textContent = ''; welcome(); });
    sb.addEventListener('click', function () { send(el.input.value); });
    el.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(el.input.value); } });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && el.panel.classList.contains('open')) open(false); });

    loadCtx();
    history = loadHistory();
    if (history.length) {
      history.forEach(function (hm) { if (hm.u) el.msgs.appendChild(mk('div', 'crb-m crb-u', hm.u)); else if (hm.r) el.msgs.appendChild(botLine(hm.r, hm.ai, hm.q)); });
      var last = history[history.length - 1]; renderChips(last && last.r ? last.r.chips : starterChips(false));
    } else welcome();
    trackEyes(); maybeTip();
  }
  function welcome() { var r = handlers.greet(false); pushBot(r); }

  window.CircuitRunBot = { answer: answer, config: CONFIG };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
