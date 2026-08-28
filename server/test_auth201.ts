import http from 'http';

function postJson(path: string, headers: any, body: any): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const dataString = JSON.stringify(body || {});
    const req = http.request({
      hostname: 'localhost',
      port: 5000,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dataString),
        'X-Tenant-ID': 'comp-camsa',
        ...headers
      }
    }, res => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => resolve({ status: res.statusCode || 500, data: JSON.parse(responseData) }));
    });
    req.on('error', reject);
    req.write(dataString);
    req.end();
  });
}

function getJson(path: string, headers?: any): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 5000,
      path,
      method: 'GET',
      headers: {
        'X-Tenant-ID': 'comp-camsa',
        ...(headers || {})
      }
    }, res => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => resolve({ status: res.statusCode || 500, data: JSON.parse(responseData) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function verifyAuth201() {
  console.log('📋 [AUTH-201] KAPSAMLI ENTEGRASYON VE GÜVENLİK TESTİ BAŞLIYOR...\n');

  let allPassed = true;

  // 1. Yanlış Şifre Testi (Argon2id Hatalı Doğrulama)
  const failLogin = await postJson('/api/v1/auth/login', {}, { username: 'camsa', password: 'wrongpassword' });
  if (failLogin.status === 401 && failLogin.data.error === 'INVALID_CREDENTIALS') {
    console.log('✅ 1. Argon2id Yanlış Şifre Engelleme: BAŞARILI (Status 401, Message: "' + failLogin.data.message + '")');
  } else {
    console.error('❌ 1. Argon2id Yanlış Şifre: BAŞARISIZ', failLogin);
    allPassed = false;
  }

  // 2. Doğru Şifre ile Giriş (Argon2id Doğru & JWT Üretimi)
  const successLogin = await postJson('/api/v1/auth/login', {}, { username: 'camsa', password: '123456' });
  const accessToken = successLogin.data.accessToken;
  const refreshToken = successLogin.data.refreshToken;
  const user = successLogin.data.user;

  if (successLogin.status === 200 && accessToken && refreshToken && user.role === 'COMPANY_OWNER') {
    console.log('✅ 2. Argon2id & JWT Üretimi (COMPANY_OWNER): BAŞARILI (Access & Refresh Token Alındı)');
  } else {
    console.error('❌ 2. Doğru Şifre ile Giriş: BAŞARISIZ', successLogin);
    allPassed = false;
  }

  // 3. Korumalı Rota Testi (/auth/me) - Token'sız Erişim
  const noTokenRes = await getJson('/api/v1/auth/me');
  if (noTokenRes.status === 401 && noTokenRes.data.error === 'UNAUTHORIZED') {
    console.log('✅ 3. Token\'sız Erişim Engelleme (/auth/me): BAŞARILI (Status 401 Unauthorized)');
  } else {
    console.error('❌ 3. Token\'sız Erişim: BAŞARISIZ', noTokenRes);
    allPassed = false;
  }

  // 4. Korumalı Rota Testi (/auth/me) - Geçerli Bearer Token ile Erişim
  const validTokenRes = await getJson('/api/v1/auth/me', { 'Authorization': 'Bearer ' + accessToken });
  if (validTokenRes.status === 200 && validTokenRes.data.user.username === 'camsa') {
    console.log('✅ 4. Geçerli JWT Bearer Token ile Profil Erişimi: BAŞARILI (Kullanıcı: ' + validTokenRes.data.user.username + ')');
  } else {
    console.error('❌ 4. Geçerli Token Erişimi: BAŞARISIZ', validTokenRes);
    allPassed = false;
  }

  // 5. Single-Use JWT Refresh Token Rotasyonu Testi
  const refreshRes = await postJson('/api/v1/auth/refresh', {}, { refreshToken });
  const newAccessToken = refreshRes.data.accessToken;
  const newRefreshToken = refreshRes.data.refreshToken;

  if (refreshRes.status === 200 && newAccessToken && newRefreshToken && newRefreshToken !== refreshToken) {
    console.log('✅ 5. JWT Refresh Token Rotasyonu: BAŞARILI (Yeni Token Çifti Üretildi)');
  } else {
    console.error('❌ 5. Token Rotasyonu: BAŞARISIZ', refreshRes);
    allPassed = false;
  }

  // 6. Token Reuse Detection (Çalınma Tespiti - Kullanılmış Refresh Token ile Tekrar İstek Atma)
  const reuseRes = await postJson('/api/v1/auth/refresh', {}, { refreshToken });
  if (reuseRes.status === 401 && reuseRes.data.error === 'TOKEN_REUSE_DETECTED') {
    console.log('✅ 6. Token Reuse Detection (Çalınma Engelleme): BAŞARILI (Tekrar Kullanım Engellendi, Tüm Oturumlar İptal Edildi)');
  } else {
    console.error('❌ 6. Token Reuse Detection: BAŞARISIZ', reuseRes);
    allPassed = false;
  }

  // 7. RBAC (Rol Bazlı Erişim Denetimi) Testi - Pompa Operatörü Araç Eklemeye Çalışıyor (Yetkisiz)
  const opLogin = await postJson('/api/v1/auth/login', {}, { username: 'pompa-op-01', password: '123456' });
  const opAccessToken = opLogin.data.accessToken;

  const forbiddenAddVeh = await postJson('/api/v1/vehicles', { 'Authorization': 'Bearer ' + opAccessToken }, {
    plate: '34 CTP 82',
    brandModel: 'Volvo FMX',
    rfidTag: 'TAG-101',
    fuelCapacityLiters: 500
  });

  if (forbiddenAddVeh.status === 403 && forbiddenAddVeh.data.error === 'FORBIDDEN') {
    console.log('✅ 7. RBAC Rol Koruması (PUMP_OPERATOR → Araç Ekleme): BAŞARILI (Status 403 Forbidden)');
  } else {
    console.error('❌ 7. RBAC Rol Koruması: BAŞARISIZ', forbiddenAddVeh);
    allPassed = false;
  }

  // 8. RBAC Rol İzin Verilen İstek (COMPANY_OWNER → Araç Ekleme)
  const allowedAddVeh = await postJson('/api/v1/vehicles', { 'Authorization': 'Bearer ' + newAccessToken }, {
    plate: '34 CTP 82',
    brandModel: 'Volvo FMX',
    rfidTag: 'TAG-101',
    fuelCapacityLiters: 500
  });

  if (allowedAddVeh.status === 200 && allowedAddVeh.data.success) {
    console.log('✅ 8. RBAC Rol İzin Verilen İstek (COMPANY_OWNER → Araç Ekleme): BAŞARILI (Status 200 OK)');
  } else {
    console.error('❌ 8. RBAC İzinli İstek: BAŞARISIZ', allowedAddVeh);
    allPassed = false;
  }

  console.log('\n---------------------------------------------------------');
  if (allPassed) {
    console.log('🎉 SONUÇ: [AUTH-201] TÜM KABUL KRİTERLERİ VE GÜVENLİK TESTLERİ %100 BAŞARIYLA GEÇTİ!');
  } else {
    console.error('⚠️ UYARI: Bazı testler başarısız oldu.');
    process.exit(1);
  }
}

verifyAuth201();
