import { waitForSamples, tankKey, pumpKey, Reporter, createTenant, cleanupTenant, dispenseCycle, deviceCall, call, q, redis, openMqtt, publish, topic, WsObserver, sleep, E2ETenant } from './lib';

/**
 * TEST-1001 (#193) — UÇTAN UCA İKMAL DÖNGÜSÜ: kart okutma → yetki → akış (MQTT telemetri) → sonlandırma → stok düşümü →
 * olay tüketicileri (WebSocket, hırsızlık motoru) → e-İrsaliye kuyruğu → rapor. GERÇEK bağımlılıklar: PostgreSQL, Redis, EMQX (MQTT), backend süreci.
 *
 * Sentetik cihaz istemcisi = firmware'in yaptığı gibi HMAC imzalı HTTP (request-auth/heartbeat/finalize) + MQTT telemetri (mqtt.js).
 * Tenant-taze: bu dosya yalnız KENDİ tenant'ına dokunur (bkz. lib.ts) → başka E2E dosyalarıyla paralel çalışır.
 *
 * EL HESABI: tank 10000.00 L; sayaç 5000 → 5060 = 60 L; ikmal sonrası tank 9940.00 L; hırsızlık motoru: pompa 60 L ↔ tank düşüşü 60 L → sapma %0
 * (eşik %1.5) → alarm YOK; B şantiyesinde pompa kapalıyken tank 5000 → 4990 = 10 L düşüş (> 5 L) → STATIC_THEFT_DETECTED.
 */
async function main() {
  const r = new Reporter('🔄 [TEST-1001] UÇTAN UCA İKMAL DÖNGÜSÜ (Postgres + Redis + EMQX + backend)');
  let t: E2ETenant | undefined;
  const rd = redis();
  let ws: WsObserver | undefined;
  const mq = await openMqtt();
  try {
    t = await createTenant('cyc', { plate: '34 KHS 07', tankStart: 10000 });
    ws = await WsObserver.open(t.ownerToken);
    const tk = t;

    // ── 1) Cihaz varlığı: MQTT status → Redis presence + WebSocket olayı ────────────
    await publish(mq, topic(tk, tk.siteA, 'pump', tk.pump.id, 'status'), 'ONLINE');
    const presenceEvt = await ws.waitFor('device:status', (p) => p.deviceId === tk.pump.id && p.status === 'ONLINE');
    const presenceKey = await rd.get(`device:${tk.pump.id}:state`);
    r.check('1. Cihaz MQTT ile ONLINE olur: EMQX → backend paylaşımlı aboneliği → Redis presence (device:<id>:state=ONLINE) ve tenant WebSocket\'ine device:status olayı',
      presenceKey === 'ONLINE' && !!presenceEvt && presenceEvt.payload.tenantId === tk.tenantId, `redis=${presenceKey} ws=${presenceEvt ? JSON.stringify(presenceEvt.payload).slice(0, 120) : 'yok'}`);

    // ── 2) Yetkisiz kart / yanlış imza → pompa açılmaz ──────────────────────────────
    const badCard = await deviceCall(tk.pump.id, tk.pump.secret, '/dispense/request-auth', { rfidCardId: 'CARD-BILINMEYEN', tankName: tk.tankName });
    const badSig = await deviceCall(tk.pump.id, 'yanlis-secret', '/dispense/request-auth', { rfidCardId: tk.card, tankName: tk.tankName });
    r.check('2. Tanınmayan kart 403 CARD_UNKNOWN, yanlış HMAC sırrı 401 — ikisinde de oturum açılmaz', badCard.status === 403 && badCard.body?.details?.error === 'CARD_UNKNOWN' && badSig.status === 401, `kart=${badCard.status}/${badCard.body?.details?.error} imza=${badSig.status}`);

    // ── 3) Tam döngü: yetki → akış (MQTT telemetri eşliğinde) → sonlandırma ──────────────
    await publish(mq, topic(tk, tk.siteA, 'tank', tk.tankSensorA.id, 'data'), { levelLiters: 10000 }); // taban örnek
    const baseSeen = await waitForSamples(rd, tankKey(tk, tk.siteA, tk.tankSensorA.id), 1); // tüketici işledi (sıra şansa bırakılmaz)
    const cyc = await dispenseCycle(tk, 60, {
      duringPumping: async () => {
        await publish(mq, topic(tk, tk.siteA, 'pump', tk.pump.id, 'data'), { litersDispensed: 60, flowRate: 24 });
        await waitForSamples(rd, pumpKey(tk, tk.siteA), 1);
        await publish(mq, topic(tk, tk.siteA, 'tank', tk.tankSensorA.id, 'data'), { levelLiters: 9940 });
      }
    });
    const tx = cyc.fin.body?.data;
    r.check('3. Zincir: request-auth AUTHORIZED (plaka/sürücü/izinli litre) → ilk heartbeat PUMPING (CONTINUE) → finalize 200; sayaç farkı 60.00 L, DOĞRULANDI, hash imzalı',
      cyc.auth.status === 200 && cyc.auth.body.data.state === 'AUTHORIZED' && cyc.auth.body.data.vehiclePlate === tk.plate && cyc.auth.body.data.driverName === tk.driverName && cyc.auth.body.data.maxAllowedLiters >= 60 &&
        cyc.hbStart.body.command === 'CONTINUE' && cyc.hbStart.body.state === 'PUMPING' && cyc.hbEnd.body.command === 'CONTINUE' &&
        cyc.fin.status === 200 && Number(tx.amount_liters) === 60 && tx.verification_status === 'DOĞRULANDI' && !!tx.hash_signature && tx.tenant_id === tk.tenantId,
      `auth=${cyc.auth.status}/${cyc.auth.body?.data?.state} maxL=${cyc.auth.body?.data?.maxAllowedLiters} hb=${cyc.hbStart.body?.state}/${cyc.hbEnd.body?.command} fin=${cyc.fin.status} L=${tx?.amount_liters} ${tx?.verification_status}`);

    // ── 4) Stok düşümü ────────────────────────────────────────────────────────────────
    const tank = (await q(`SELECT current_level_liters FROM tanks WHERE id = $1`, [tk.tankId]))[0];
    const txRows = await q(`SELECT id, amount_liters, tank_name, device_id, vehicle_plate FROM transactions WHERE tenant_id = $1`, [tk.tenantId]);
    r.check('4. Stok düşümü: tank 10000.00 → 9940.00 L (tam 60 L); tenant\'ta TEK ikmal kaydı (plaka, tank adı) yazıldı',
      Number(tank.current_level_liters) === 9940 && txRows.length === 1 && Number(txRows[0].amount_liters) === 60 && txRows[0].tank_name === tk.tankName && txRows[0].vehicle_plate === tk.plate,
      `tank=${tank.current_level_liters} kayıt=${JSON.stringify(txRows)}`);

    // ── 5) Olay tüketicileri: WebSocket canlı yayın ─────────────────────────────────────
    const done = await ws.waitFor('dispense:completed', (p) => p.transaction?.id === tx.id);
    const states = ws.all('dispense:session').map((e) => e.payload.state);
    const liveTank = done?.payload.tanks?.find((x: any) => x.name === tk.tankName);
    r.check('5. WebSocket: tenant paneli oturumu AUTHORIZED → PUMPING sırasıyla ve dispense:completed olayını (aynı işlem kimliği, tanklar taze: 9940 L) canlı alır',
      states.includes('AUTHORIZED') && states.includes('PUMPING') && states.indexOf('AUTHORIZED') < states.indexOf('PUMPING') && !!done && Number(liveTank?.current_level_liters) === 9940,
      `oturum durumları=${states.join('>')} tamamlandı=${!!done} canlıTank=${liveTank?.current_level_liters}`);

    // ── 6) Hırsızlık motoru: tutarlı ikmalde ALARM YOK ───────────────────────────────────
    await sleep(1500);
    const falseAlarm = ws.find('theft:alert', (p) => p.tankDeviceId === tk.tankSensorA.id);
    const tankSamples = await rd.zcard(tankKey(tk, tk.siteA, tk.tankSensorA.id));
    r.check('6. Olay tüketicisi (MQTT → hırsızlık motoru): tüketici taban + son tank örneğini ve pompa örneğini işledi; pompa 60 L ↔ tank düşüşü 60 L tutarlı (sapma %0 < %1,5) → theft:alert YOK', baseSeen && tankSamples === 2 && !falseAlarm, `tankÖrnek=${tankSamples} alarm=${falseAlarm ? JSON.stringify(falseAlarm.payload) : 'yok'}`);

    // ── 7) Hırsızlık motoru: pompa kapalıyken düşüş → alarm (B şantiyesi) ─────────────────
    await publish(mq, topic(tk, tk.siteB, 'tank', tk.tankSensorB.id, 'data'), { levelLiters: 5000 });
    await waitForSamples(rd, tankKey(tk, tk.siteB, tk.tankSensorB.id), 1);
    await publish(mq, topic(tk, tk.siteB, 'tank', tk.tankSensorB.id, 'data'), { levelLiters: 4990 });
    const theft = await ws.waitFor('theft:alert', (p) => p.tankDeviceId === tk.tankSensorB.id);
    r.check('7. Olay tüketicisi: B şantiyesinde pompa kapalıyken tank 5000 → 4990 L (10 L > 5 L) → STATIC_THEFT_DETECTED, düşüş 10 L, yalnız bu tenant\'ın WebSocket\'ine',
      !!theft && theft.payload.type === 'STATIC_THEFT_DETECTED' && theft.payload.levelDropLiters === 10 && theft.payload.tenantId === tk.tenantId && theft.payload.siteId === tk.siteB, `alarm=${theft ? JSON.stringify(theft.payload).slice(0, 160) : 'yok'}`);

    // ── 8) Idempotency ────────────────────────────────────────────────────────────────
    const again = await deviceCall(tk.pump.id, tk.pump.secret, '/dispense/finalize', { sessionId: cyc.auth.body.data.sessionId, endTotalizerLiters: 5060, reportedLiters: 60, idempotencyKey: cyc.key });
    const cnt = (await q(`SELECT COUNT(*)::int AS c FROM transactions WHERE tenant_id = $1`, [tk.tenantId]))[0].c;
    const tank2 = (await q(`SELECT current_level_liters FROM tanks WHERE id = $1`, [tk.tankId]))[0];
    r.check('8. Ağ kesintisi sonrası aynı idempotencyKey ile tekrar finalize: AYNI kayıt döner, ikinci kayıt YOK, tank İKİNCİ kez düşmez (9940 L)', again.status === 200 && again.body?.data?.id === tx.id && cnt === 1 && Number(tank2.current_level_liters) === 9940, `status=${again.status} aynıId=${again.body?.data?.id === tx.id} kayıt=${cnt} tank=${tank2.current_level_liters}`);

    // ── 9) e-İrsaliye kuyruğu ──────────────────────────────────────────────────────────
    const enq = await call('POST', `/transactions/${tx.id}/e-irsaliye/transmit`, { token: tk.ownerToken, body: {} });
    const sweep = await call('POST', '/despatch-advice-transmissions/sweep', { token: tk.ownerToken });
    const dt = (await q(`SELECT status, provider_reference, xml_snapshot FROM despatch_advice_transmissions WHERE tenant_id = $1 AND transaction_id = $2`, [tk.tenantId, tx.id]))[0];
    r.check('9. e-İrsaliye: ikmal kuyruğa alınır (QUEUED) → süpürme entegratöre gönderir → SENT (sağlayıcı referansı var); imzalı XML anlık görüntüsü plaka ve 60 L içerir',
      enq.status === 200 && enq.body.data.status === 'QUEUED' && sweep.status === 200 && dt?.status === 'SENT' && !!dt.provider_reference && dt.xml_snapshot.includes(`>${tk.plate}<`) && /60(\.0+)?</.test(dt.xml_snapshot),
      `kuyruk=${enq.status}/${enq.body?.data?.status} süpürme=${sweep.status} durum=${dt?.status} ref=${dt?.provider_reference} xmlPlaka=${dt?.xml_snapshot?.includes(`>${tk.plate}<`)}`);

    // ── 10) Rapor ─────────────────────────────────────────────────────────────────────
    const rep = await call('GET', `/reports/rep-711?vehiclePlate=${encodeURIComponent(tk.plate)}`, { token: tk.ownerToken });
    r.check('10. İkmal Hareket Raporu (rep-711) bu tenant\'ın tek ikmalini (60 L) döndürür', rep.status === 200 && rep.body.pagination?.totalCount === 1 && rep.body.data[0].id === tx.id, `rapor=${rep.status} satır=${rep.body?.pagination?.totalCount}`);
  } catch (err) {
    console.error('💥 Beklenmeyen hata:', err);
    r.check('Senaryo hatasız tamamlandı', false, String(err));
  } finally {
    ws?.close();
    mq.end(true);
    rd.disconnect();
    await cleanupTenant(t);
  }
  r.finish(10);
}
main().catch((e) => { console.error(e); process.exit(1); });
