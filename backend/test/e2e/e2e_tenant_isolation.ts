import { waitForSamples, tankKey, redis, Reporter, createTenant, cleanupTenant, dispenseCycle, deviceCall, call, q, openMqtt, publish, topic, WsObserver, sleep, E2ETenant } from './lib';

/**
 * TEST-1001 (#193) AC: "Testler birbirinden izole çalışmalıdır" — iki taze tenant AYNI ANDA tam ikmal döngüsü koşar (ve orkestratör bu dosyayı
 * e2e_fuel_cycle.ts ile PARALEL çalıştırır → aynı backend/Postgres/Redis/EMQX üzerinde 4 tenant birden). Hiçbiri diğerinin verisini
 * görmez, değiştirmez, canlı olaylarını almaz; bir tenant'ın cihaz sırrı diğerinin cihazında geçmez.
 *
 * EL HESABI: A 60 L, B 45 L. A tankı 10000 → 9940, B tankı 8000 → 7955. A'nın 1 kaydı, B'nin 1 kaydı.
 */
async function main() {
  const r = new Reporter('🧱 [TEST-1001] TENANT İZOLASYONU — eşzamanlı iki tenant, ortak bağımlılıklar');
  let A: E2ETenant | undefined; let B: E2ETenant | undefined;
  let wsA: WsObserver | undefined; let wsB: WsObserver | undefined;
  const mq = await openMqtt();
  const rd = redis();
  try {
    [A, B] = await Promise.all([createTenant('isoa', { plate: '34 ISA 01', tankStart: 10000 }), createTenant('isob', { plate: '06 ISB 02', tankStart: 8000 })]);
    const a = A; const b = B;
    [wsA, wsB] = await Promise.all([WsObserver.open(a.ownerToken), WsObserver.open(b.ownerToken)]);

    // Eşzamanlı döngü + eşzamanlı telemetri (her tenant kendi topic'inde)
    const [ca, cb] = await Promise.all([
      dispenseCycle(a, 60, { duringPumping: async () => { await publish(mq, topic(a, a.siteA, 'pump', a.pump.id, 'data'), { litersDispensed: 60, flowRate: 24 }); } }),
      dispenseCycle(b, 45, { duringPumping: async () => { await publish(mq, topic(b, b.siteA, 'pump', b.pump.id, 'data'), { litersDispensed: 45, flowRate: 20 }); } })
    ]);
    r.check('1. Eşzamanlı iki tam döngü (yetki → akış → sonlandırma) ikisi de başarılı: A 60 L, B 45 L, ikisi de DOĞRULANDI', ca.fin.status === 200 && cb.fin.status === 200 && Number(ca.fin.body.data.amount_liters) === 60 && Number(cb.fin.body.data.amount_liters) === 45 && ca.fin.body.data.verification_status === 'DOĞRULANDI' && cb.fin.body.data.verification_status === 'DOĞRULANDI', `A=${ca.fin.status}/${ca.fin.body?.data?.amount_liters} B=${cb.fin.status}/${cb.fin.body?.data?.amount_liters}`);

    const tanks = await q(`SELECT tenant_id, current_level_liters FROM tanks WHERE tenant_id = ANY($1)`, [[a.tenantId, b.tenantId]]);
    const lvl = (id: string) => Number(tanks.find((x) => x.tenant_id === id)?.current_level_liters);
    r.check('2. Stok: A tankı 10000 → 9940, B tankı 8000 → 7955 (her biri yalnız KENDİ ikmali kadar düştü, birbirine karışmadı)', lvl(a.tenantId) === 9940 && lvl(b.tenantId) === 7955, `A=${lvl(a.tenantId)} B=${lvl(b.tenantId)}`);

    const txs = await q(`SELECT tenant_id, COUNT(*)::int AS c, SUM(amount_liters)::numeric AS l FROM transactions WHERE tenant_id = ANY($1) GROUP BY tenant_id`, [[a.tenantId, b.tenantId]]);
    const tc = (id: string) => txs.find((x) => x.tenant_id === id);
    r.check('3. Kayıtlar: her tenant\'ın TEK kaydı var, doğru tenant_id ve litre (A 60, B 45)', tc(a.tenantId)?.c === 1 && Number(tc(a.tenantId)?.l) === 60 && tc(b.tenantId)?.c === 1 && Number(tc(b.tenantId)?.l) === 45, `A=${JSON.stringify(tc(a.tenantId))} B=${JSON.stringify(tc(b.tenantId))}`);

    // API görünürlüğü
    const [tanksA, tanksB, txA, txB] = await Promise.all([call('GET', '/tanks', { token: a.ownerToken }), call('GET', '/tanks', { token: b.ownerToken }), call('GET', '/transactions?limit=50', { token: a.ownerToken }), call('GET', '/transactions?limit=50', { token: b.ownerToken })]);
    const names = (x: any) => (x.body.data as any[]).map((t) => t.name);
    r.check('4. API (RLS): A yalnız kendi tankını ve kendi ikmalini listeler; B de öyle — karşı tarafın tankı/ikmali hiçbir listede yok',
      names(tanksA).length === 1 && names(tanksA)[0] === a.tankName && names(tanksB).length === 1 && names(tanksB)[0] === b.tankName &&
        (txA.body.data as any[]).every((t) => t.tenant_id === a.tenantId) && (txB.body.data as any[]).every((t) => t.tenant_id === b.tenantId) && (txA.body.data as any[]).length === 1 && (txB.body.data as any[]).length === 1,
      `A tank=${JSON.stringify(names(tanksA))} B tank=${JSON.stringify(names(tanksB))} A tx=${txA.body.data?.length} B tx=${txB.body.data?.length}`);

    // Canlı olaylar
    await publish(mq, topic(a, a.siteB, 'tank', a.tankSensorB.id, 'data'), { levelLiters: 3000 });
    await waitForSamples(rd, tankKey(a, a.siteB, a.tankSensorB.id), 1);
    await publish(mq, topic(a, a.siteB, 'tank', a.tankSensorB.id, 'data'), { levelLiters: 2990 });
    await wsA.waitFor('theft:alert', (p) => p.tankDeviceId === a.tankSensorB.id);
    await sleep(1000);
    const foreign = (ws: WsObserver, own: string) => ws.events.filter((e) => {
      const p = e.payload ?? {};
      const ten = p.tenantId ?? p.transaction?.tenant_id ?? p.tanks?.[0]?.tenant_id;
      return ten !== undefined && ten !== own;
    });
    r.check('5. WebSocket: A paneli A\'nın hırsızlık alarmını aldı; B paneli A\'nın HİÇBİR olayını (alarm, ikmal, tank) almadı; A paneli de B\'nin olayını almadı',
      !!wsA.find('theft:alert', (p) => p.tenantId === a.tenantId) && !wsB.find('theft:alert') && foreign(wsA, a.tenantId).length === 0 && foreign(wsB, b.tenantId).length === 0 &&
        !!wsA.find('dispense:completed', (p) => p.transaction?.id === ca.fin.body.data.id) && !wsB.find('dispense:completed', (p) => p.transaction?.id === ca.fin.body.data.id),
      `A olay=${wsA.events.length} B olay=${wsB.events.length} yabancıA=${foreign(wsA, a.tenantId).length} yabancıB=${foreign(wsB, b.tenantId).length} Balarm=${!!wsB.find('theft:alert')}`);

    // Cihaz kimliği sınırı
    const cross = await deviceCall(b.pump.id, a.pump.secret, '/dispense/request-auth', { rfidCardId: b.card, tankName: b.tankName });
    const crossCard = await deviceCall(a.pump.id, a.pump.secret, '/dispense/request-auth', { rfidCardId: b.card, tankName: b.tankName });
    r.check('6. Cihaz sınırı: A\'nın cihaz sırrı B\'nin cihazında geçmez (401); A\'nın cihazı B\'nin kartını/tankını tanımaz (kart 403 CARD_UNKNOWN)', cross.status === 401 && crossCard.status === 403, `sırçapraz=${cross.status} kartçapraz=${crossCard.status}/${crossCard.body?.details?.error}`);

    // Sıfır sızıntı: aynı sorgu hem A hem B için doğru
    const rep = await call('GET', '/reports/rep-711', { token: a.ownerToken });
    r.check('7. Raporlar da izole: A\'nın rep-711 raporu yalnız A\'nın 1 ikmalini içerir', rep.status === 200 && rep.body.pagination.totalCount === 1 && rep.body.data[0].id === ca.fin.body.data.id, `satır=${rep.body?.pagination?.totalCount}`);
  } catch (err) {
    console.error('💥 Beklenmeyen hata:', err);
    r.check('Senaryo hatasız tamamlandı', false, String(err));
  } finally {
    wsA?.close(); wsB?.close(); mq.end(true); rd.disconnect();
    await Promise.all([cleanupTenant(A), cleanupTenant(B)]);
  }
  r.finish(7);
}
main().catch((e) => { console.error(e); process.exit(1); });
