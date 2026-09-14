import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FE-804 — "Parolamı Unuttum" ve "Yeni Parola Belirle" ekranları
 * (AUTH-206 backend'i zaten hazır, burada yalnızca frontend).
 *
 * `apiFetch` doğrudan mock'lanıyor (LoginPages.test.tsx'in `useApp`'ı
 * mock'lama deseniyle AYNI mantık — bu sayfalar AppContext'ten değil,
 * doğrudan apiFetch'ten geçiyor).
 *
 * Kritik davranışlar test ediliyor:
 *  1) Enumeration koruması: forgot-password her zaman AYNI başarı mesajını
 *     gösterir — backend'in "kullanıcı var mı" bilgisini gizleme ilkesini
 *     frontend'in bozmadığını doğrular.
 *  2) Geçersiz/eksik token ile ResetPasswordPage formu HİÇ render edilmez.
 *  3) Parola eşleşmeme/uzunluk hatalarında apiFetch HİÇ ÇAĞRILMAZ (backend'e
 *     gitmeden istemci tarafı doğrulama).
 *  4) Başarılı sıfırlama /login?reset=success'e yönlendirir.
 */
const apiFetchMock = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

import { ForgotPasswordPage } from './ForgotPasswordPage';
import { ResetPasswordPage } from './ResetPasswordPage';

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('ForgotPasswordPage', () => {
  const tree = () => (
    <MemoryRouter initialEntries={['/parola-unuttum']}>
      <Routes>
        <Route path="/parola-unuttum" element={<ForgotPasswordPage />} />
        <Route path="/login" element={<div>LOGIN-EKRANI</div>} />
        <Route path="/parola-sifirla/:token" element={<div>SIFIRLA-EKRANI</div>} />
      </Routes>
    </MemoryRouter>
  );

  it('kullanıcı adı BOŞ gönderilirse apiFetch hiç çağrılmaz, istemci hatası gösterilir', () => {
    render(tree());
    fireEvent.click(screen.getByRole('button', { name: /Sıfırlama Talebi Gönder/i }));
    expect(screen.getByText(/Lütfen kullanıcı adınızı giriniz/i)).toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('geçerli kullanıcı adıyla POST /auth/forgot-password çağrılır ve JENERİK başarı mesajı gösterilir', async () => {
    apiFetchMock.mockResolvedValueOnce({ success: true, message: 'ok' });
    render(tree());

    fireEvent.change(screen.getByPlaceholderText('Kullanıcı Adı'), { target: { value: 'herhangi-bir-kullanici' } });
    fireEvent.click(screen.getByRole('button', { name: /Sıfırlama Talebi Gönder/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/auth/forgot-password', expect.objectContaining({ method: 'POST' })));
    expect(JSON.parse((apiFetchMock.mock.calls[0][1] as any).body)).toEqual({ username: 'herhangi-bir-kullanici' });

    // Enumeration koruması: "kullanıcı bulunamadı" gibi FARKLI bir mesaj YOK.
    expect(await screen.findByText(/Eğer bu kullanıcı adı sistemde kayıtlıysa/i)).toBeInTheDocument();
    expect(screen.queryByText(/bulunamadı/i)).not.toBeInTheDocument();
  });

  it('devResetToken dönerse test kısayolu görünür ve tıklanınca doğru token ile sıfırlama ekranına gider', async () => {
    apiFetchMock.mockResolvedValueOnce({ success: true, message: 'ok', devResetToken: 'a'.repeat(64) });
    render(tree());

    fireEvent.change(screen.getByPlaceholderText('Kullanıcı Adı'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: /Sıfırlama Talebi Gönder/i }));

    const shortcut = await screen.findByRole('button', { name: /Sıfırlama Bağlantısına Git/i });
    fireEvent.click(shortcut);
    expect(await screen.findByText('SIFIRLA-EKRANI')).toBeInTheDocument();
  });

  it('devResetToken DÖNMEZSE (üretim ortamı simülasyonu) kısayol butonu hiç gösterilmez', async () => {
    apiFetchMock.mockResolvedValueOnce({ success: true, message: 'ok' });
    render(tree());

    fireEvent.change(screen.getByPlaceholderText('Kullanıcı Adı'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: /Sıfırlama Talebi Gönder/i }));

    await screen.findByText(/Eğer bu kullanıcı adı sistemde kayıtlıysa/i);
    expect(screen.queryByRole('button', { name: /Sıfırlama Bağlantısına Git/i })).not.toBeInTheDocument();
  });

  it('apiFetch reddederse (ör. 429 rate limit) hata mesajı gösterilir, başarı mesajı YOK', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('Çok fazla deneme yaptınız, lütfen daha sonra tekrar deneyin.'));
    render(tree());

    fireEvent.change(screen.getByPlaceholderText('Kullanıcı Adı'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: /Sıfırlama Talebi Gönder/i }));

    expect(await screen.findByText(/Çok fazla deneme yaptınız/i)).toBeInTheDocument();
    expect(screen.queryByText(/Eğer bu kullanıcı adı sistemde kayıtlıysa/i)).not.toBeInTheDocument();
  });
});

describe('ResetPasswordPage', () => {
  const VALID_TOKEN = 'b'.repeat(64);

  function tree(token: string) {
    return (
      <MemoryRouter initialEntries={[`/parola-sifirla/${token}`]}>
        <Routes>
          <Route path="/parola-sifirla/:token" element={<ResetPasswordPage />} />
          <Route path="/login" element={<div>LOGIN-EKRANI</div>} />
          <Route path="/parola-unuttum" element={<div>UNUTTUM-EKRANI</div>} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('geçersiz biçimli token ile form HİÇ render edilmez, hata gösterilir', () => {
    render(tree('kisa-ve-gecersiz-token'));
    expect(screen.getByText(/Sıfırlama bağlantısı geçersiz veya eksik/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('En az 8 karakter')).not.toBeInTheDocument();
  });

  it('geçerli biçimli token ile form render edilir', () => {
    render(tree(VALID_TOKEN));
    expect(screen.getByPlaceholderText('En az 8 karakter')).toBeInTheDocument();
  });

  it('parolalar eşleşmezse apiFetch ÇAĞRILMAZ, istemci hatası gösterilir', () => {
    render(tree(VALID_TOKEN));
    fireEvent.change(screen.getByPlaceholderText('En az 8 karakter'), { target: { value: 'gecerliParola1' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'FARKLI-parola1' } });
    fireEvent.click(screen.getByRole('button', { name: /Parolayı Güncelle/i }));

    expect(screen.getByText(/eşleşmiyor/i)).toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('parola 8 karakterden kısaysa apiFetch ÇAĞRILMAZ', () => {
    render(tree(VALID_TOKEN));
    fireEvent.change(screen.getByPlaceholderText('En az 8 karakter'), { target: { value: 'kisa' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'kisa' } });
    fireEvent.click(screen.getByRole('button', { name: /Parolayı Güncelle/i }));

    expect(screen.getByText(/en az 8 karakter olmalıdır/i)).toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('geçerli eşleşen parolayla POST /auth/reset-password çağrılır ve başarıda /login?reset=success\'e yönlendirir', async () => {
    apiFetchMock.mockResolvedValueOnce({ success: true, message: 'ok' });
    render(tree(VALID_TOKEN));

    fireEvent.change(screen.getByPlaceholderText('En az 8 karakter'), { target: { value: 'yeniParola123' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'yeniParola123' } });
    fireEvent.click(screen.getByRole('button', { name: /Parolayı Güncelle/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/auth/reset-password', expect.objectContaining({ method: 'POST' })));
    expect(JSON.parse((apiFetchMock.mock.calls[0][1] as any).body)).toEqual({ token: VALID_TOKEN, newPassword: 'yeniParola123' });
    expect(await screen.findByText('LOGIN-EKRANI')).toBeInTheDocument();
  });

  it('apiFetch reddederse (geçersiz/kullanılmış token) backend mesajı olduğu gibi gösterilir', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('Geçersiz veya süresi dolmuş sıfırlama bağlantısı.'));
    render(tree(VALID_TOKEN));

    fireEvent.change(screen.getByPlaceholderText('En az 8 karakter'), { target: { value: 'yeniParola123' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'yeniParola123' } });
    fireEvent.click(screen.getByRole('button', { name: /Parolayı Güncelle/i }));

    expect(await screen.findByText(/Geçersiz veya süresi dolmuş sıfırlama bağlantısı/i)).toBeInTheDocument();
  });
});
