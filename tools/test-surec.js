#!/usr/bin/env node
// Test A — komut yakalama mantığı doğru komutu buluyor mu?
//
// VS Code'a hiç dokunmadan çalışır: pty host'un altındaki bütün kabukları bulur,
// her biri için onPlanKomutu()'nun ne döndürdüğünü yazdırır. Karşılaştırma için
// ham çocuk listesi de gösterilir.

const { surecAgaci, onPlanKomutu, calismaDizinleri } = require('../src/surec');

(async () => {
  const agac = await surecAgaci();

  // pty host: VS Code'un ana sürecinin altındaki node yardımcı süreci; bütün
  // terminal kabukları onun çocuğudur.
  const adaylar = [];
  for (const [ppid, cocuklar] of agac) {
    const kabuklar = cocuklar.filter((c) => /\/(zsh|bash|fish|sh)$/.test(c.komut.split(' ')[0]));
    if (kabuklar.length) adaylar.push({ ppid, kabuklar });
  }

  if (!adaylar.length) { console.log('kabuk bulunamadı'); return; }

  for (const { ppid, kabuklar } of adaylar) {
    console.log(`\n═══ pty host / üst süreç: ${ppid} — ${kabuklar.length} kabuk`);
    const dizinler = await calismaDizinleri(kabuklar.map((k) => k.pid));
    for (const k of kabuklar) {
      const cocuklar = (agac.get(k.pid) || []).map((c) => `${c.pid}:${c.komut.slice(0, 45)}`);
      const bulunan = onPlanKomutu(agac, k.pid);
      console.log(`\n  kabuk pid ${k.pid}`);
      console.log(`    cwd          : ${dizinler.get(k.pid) || '?'}`);
      console.log(`    ham çocuklar : ${cocuklar.length ? cocuklar.join(', ') : '(yok — boşta)'}`);
      console.log(`    YAKALANAN    : ${bulunan ? `"${bulunan.slice(0, 60)}"` : '(komut yok — kaydedilmez)'}`);
    }
  }
})();
