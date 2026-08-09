#!/usr/bin/env node
// Test C — Claude sekmelerine oturum kimliği eşleme doğru mu?
//
// Asıl mesele bu: aynı klasördeki birden fazla Claude sekmesi FARKLI oturumlara
// bağlanmalı. Aynı kimlik iki sekmeye verilirse bir konuşma kaybolur.

const { claudeOturumlariniEsle, claudeOturumKimlikleri } = require('../src/surec');

let gecti = 0, kaldi = 0;
function dogrula(baslik, kosul, ayrinti = '') {
  if (kosul) { gecti++; console.log(`  ✓ ${baslik}`); }
  else { kaldi++; console.log(`  ✗ ${baslik}  ${ayrinti}`); }
}

const KLASOR = process.argv[2] || '/Users/nurullah/Documents/TUUFI/maspar';
const taze = claudeOturumKimlikleri(KLASOR);
console.log(`\nKlasör: ${KLASOR}`);
console.log(`Son 3 saatte yazılmış oturum: ${taze.length}\n`);

if (taze.length < 3) {
  console.log('  (bu klasörde 3 taze oturum yok — test atlanıyor)');
  process.exit(0);
}

// 1) Aynı klasörde üç sekme → üç FARKLI kimlik
{
  const kayitlar = [
    { ad: 'a', cwd: KLASOR, komut: 'claude' },
    { ad: 'b', cwd: KLASOR, komut: 'claude' },
    { ad: 'c', cwd: KLASOR, komut: 'claude' }
  ];
  claudeOturumlariniEsle(kayitlar);
  const kimlikler = kayitlar.map((k) => k.claudeOturum);
  console.log('1) Üç sekme, aynı klasör');
  kayitlar.forEach((k) => console.log(`     ${k.ad} → ${k.claudeOturum}`));
  dogrula('hepsine kimlik atandı', kimlikler.every(Boolean), JSON.stringify(kimlikler));
  dogrula('kimlikler BİRBİRİNDEN FARKLI', new Set(kimlikler).size === 3, JSON.stringify(kimlikler));
}

// 2) Komutunda zaten kimlik olan sekme onu korumalı ve başkasına verilmemeli
{
  const sabit = taze[1];
  const kayitlar = [
    { ad: 'a', cwd: KLASOR, komut: `claude --resume ${sabit}` },
    { ad: 'b', cwd: KLASOR, komut: 'claude' },
    { ad: 'c', cwd: KLASOR, komut: 'claude' }
  ];
  claudeOturumlariniEsle(kayitlar);
  console.log('\n2) Biri zaten --resume ile çalışıyor');
  kayitlar.forEach((k) => console.log(`     ${k.ad} → ${k.claudeOturum}`));
  dogrula('mevcut kimlik korundu', kayitlar[0].claudeOturum === sabit);
  dogrula('o kimlik başkasına verilmedi',
    kayitlar[1].claudeOturum !== sabit && kayitlar[2].claudeOturum !== sabit);
  dogrula('üçü de farklı', new Set(kayitlar.map((k) => k.claudeOturum)).size === 3);
}

// 3) Claude olmayan komutlara kimlik iliştirilmemeli
{
  const kayitlar = [
    { ad: 'a', cwd: KLASOR, komut: 'npm run dev' },
    { ad: 'b', cwd: KLASOR, komut: 'claude' }
  ];
  claudeOturumlariniEsle(kayitlar);
  console.log('\n3) Karışık komutlar');
  dogrula('npm sekmesine kimlik verilmedi', !kayitlar[0].claudeOturum);
  dogrula('claude sekmesine kimlik verildi', !!kayitlar[1].claudeOturum);
}

console.log(`\n═══ ${gecti} geçti, ${kaldi} kaldı ═══`);
process.exit(kaldi ? 1 : 0);
