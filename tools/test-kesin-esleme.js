#!/usr/bin/env node
// Test D — 0.5.0: sekme ↔ Claude oturumu KESİN eşleme, başlık ayrımı, yerinde geri yükleme.
const Module = require('module');
const asil = Module._load;
Module._load = function (r, ...a) {
  if (r === 'vscode') return { workspace: { getConfiguration: () => ({ get: (_k, v) => v }) }, window: { createOutputChannel: () => ({ appendLine() {} }) } };
  return asil.call(this, r, ...a);
};
const fs = require('fs'), path = require('path'), os = require('os');
const S = require('../src/surec');
const { _ic: E } = require('../src/extension');

let gecti = 0, kaldi = 0;
const dogrula = (b, k, ay = '') => { if (k) { gecti++; console.log(`  ✓ ${b}`); } else { kaldi++; console.log(`  ✗ ${b}  ${ay}`); } };

(async () => {
  console.log('1) Çalışan her Claude süreci, kabuğundan doğru oturuma bağlanıyor');
  const agac = await S.surecAgaci();
  const ebeveyn = new Map();
  for (const [pp, cs] of agac) for (const c of cs) ebeveyn.set(c.pid, pp);
  const kok = path.join(os.homedir(), '.claude', 'sessions');
  const dosyalar = fs.readdirSync(kok).filter((d) => /^\d+\.json$/.test(d));
  let sinanan = 0;
  for (const d of dosyalar) {
    const veri = JSON.parse(fs.readFileSync(path.join(kok, d), 'utf8'));
    const kabuk = ebeveyn.get(veri.pid);
    if (!kabuk) continue;                       // süreç yaşamıyor
    const o = S.claudeSurecOturumu(agac, kabuk);
    sinanan++;
    dogrula(`pid ${veri.pid} → ${veri.sessionId.slice(0, 8)} (${veri.name})`, o && o.kimlik === veri.sessionId, JSON.stringify(o));
    if (veri.nameSource === 'user') dogrula(`  /rename adı taşındı: ${veri.name}`, o && o.ad === veri.name);
    else dogrula('  kendiliğinden ad elle ad sayılmadı', o && o.ad === null);
  }
  dogrula('en az bir canlı süreç sınandı', sinanan > 0, `sinanan=${sinanan}`);

  console.log('2) Başlık: elle ad ↔ kendiliğinden başlık');
  for (const a of ['✳ Koordinatör', '◐ KONATEKS yeni logo', '⠋ çalışıyor', '2.1.316', 'zsh', 'Claude Code', ''])
    dogrula(`kendiliğinden: «${a}»`, S.otomatikBaslikMi(a));
  for (const a of ['sivas', 'blog üretimi', 'Koordinatör', 'ferhat'])
    dogrula(`elle ad: «${a}»`, !S.otomatikBaslikMi(a));
  dogrula('simge atılınca aynı başlık', S.baslikNormal('◐ KONATEKS') === S.baslikNormal('◑ KONATEKS'));
  dogrula('zincirli komut Claude sayılır', S.claudeMi('cd ~/Developer/cms && claude --resume x'));

  console.log('3) Yerinde geri yükleme: canlanan boş sekmeler eşleniyor, dolu sekmeye dokunulmuyor');
  const C = '/Users/nurullah/Developer/cms';
  const t = (name, bos = true, cwd = C) => ({ name, bos, cwd });
  const sekmeler = [t('sivas'), t('◑ KONATEKS yeni logo'), t('zsh'), t('npm', false), t('Koordinatör')];
  const kayitlar = [
    { ad: '◐ KONATEKS yeni logo', adOtomatik: true, cwd: C, komut: 'claude', claudeOturum: 'b' },
    { ad: 'sivas', adOtomatik: false, cwd: C, komut: 'claude', claudeOturum: 'a' },
    { ad: '✳ Claude Code', adOtomatik: true, cwd: C, komut: 'claude', claudeOturum: 'c' },
    { ad: 'Koordinatör', adOtomatik: false, cwd: '/baska', komut: 'claude', claudeOturum: 'd' },
    { ad: 'npm', adOtomatik: false, cwd: C, komut: 'npm run dev' }
  ];
  const es = E.eslestir(kayitlar, sekmeler, (x) => x.bos, (x) => x.cwd);
  dogrula('«sivas» kendi sekmesine', es.get(kayitlar[1]) === sekmeler[0]);
  dogrula('simgesi değişmiş başlık kendi sekmesine', es.get(kayitlar[0]) === sekmeler[1]);
  dogrula('kendiliğinden başlıklı Claude aynı dizindeki boş sekmeye', es.get(kayitlar[2]) === sekmeler[2]);
  dogrula('dizini tutmayan sekmeye yazılmıyor', !es.has(kayitlar[3]));
  dogrula('içinde iş çalışan sekmeye yazılmıyor', !es.has(kayitlar[4]));
  dogrula('bir sekmeye iki kayıt düşmüyor', new Set(es.values()).size === es.size);

  console.log('4) Aynı oturum iki kez açılmıyor, kesin kimlik komuttakini geçiyor');
  const tek = E.tekillestir([{ claudeOturum: 'x' }, { claudeOturum: 'x' }, { komut: 'npm' }, { claudeOturum: 'y' }]);
  dogrula('yinelenen atıldı', tek.length === 3);
  dogrula('kesin kimlikle --resume', E.komutuDonustur('claude --resume eski-1111', { claudeOturum: 'yeni-2222' }) === 'claude --resume yeni-2222');
  const k = [{ komut: 'claude --resume 11111111-1111-1111-1111-111111111111', cwd: C, claudeOturum: '22222222-2222-2222-2222-222222222222' }];
  S.claudeOturumlariniEsle(k);
  dogrula('tahmin kesin kimliği ezmiyor', k[0].claudeOturum.startsWith('2222'));
  dogrula('ayrı oturumlu iki claude farklı iş', !E.ayniIs({ komut: 'claude', claudeOturum: 'a' }, { komut: 'claude', claudeOturum: 'b' }));

  console.log(`\n${gecti} geçti · ${kaldi} kaldı`);
  process.exit(kaldi ? 1 : 0);
})();
