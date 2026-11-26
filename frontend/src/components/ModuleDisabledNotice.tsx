import React from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * ARCH-106 — firmanın paketinde olmayan bir modülün ekranına (ör. doğrudan URL
 * ile) gelindiğinde gösterilir. Backend bu modülün uçlarına zaten
 * 403 MODULE_DISABLED dönüyor; burada boş/hatalı bir tablo yerine nedeni
 * açıkça söylenir ve kullanıcı "Modüllerim" sayfasına yönlendirilir.
 */
export const ModuleDisabledNotice: React.FC<{ moduleLabel: string }> = ({ moduleLabel }) => {
  const navigate = useNavigate();
  return (
    <div data-testid="module-disabled-notice" className="max-w-xl mx-auto mt-16 bg-[#1c1b1b] border border-[#353535] rounded-xl p-8 text-center space-y-4">
      <span className="material-symbols-outlined text-4xl text-[#ffb77f]">extension_off</span>
      <h2 className="text-lg font-black text-[#e5e2e1]">"{moduleLabel}" modülü etkin değil</h2>
      <p className="text-sm text-[#d5c4ab]">
        Bu özellik firmanızın paketinde yer almıyor. Paketinizi yükseltmek için platform yöneticinizle iletişime geçin.
      </p>
      <button
        type="button"
        data-testid="module-disabled-go-modules"
        onClick={() => navigate('/panel/modules')}
        className="px-5 py-2.5 bg-[#ffb77f] text-[#412d00] rounded-xl text-xs font-black"
      >
        Modüllerime Git
      </button>
    </div>
  );
};
