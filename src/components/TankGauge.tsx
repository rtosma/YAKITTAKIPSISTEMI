import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Tank } from '../types';

interface TankGaugeProps {
  tank: Tank;
  index?: number;
  variant?: 'compact' | 'detailed';
  siteFilter?: string;
  refreshKey?: number;
  onEdit?: (tank: Tank) => void;
  onDelete?: (tank: Tank) => void;
}

export const TankGauge: React.FC<TankGaugeProps> = ({
  tank,
  index = 0,
  variant = 'detailed',
  siteFilter = 'TÜMÜ',
  refreshKey = 0,
  onEdit,
  onDelete
}) => {
  const [animationFinished, setAnimationFinished] = useState(false);
  const [displayLiters, setDisplayLiters] = useState(0);
  const [displayPct, setDisplayPct] = useState(0);

  const pct = Math.min(100, Math.max(0, Math.round((tank.currentLevelLiters / tank.capacityLiters) * 100)));
  const isCritical = pct < 20;
  const isWarning = pct >= 20 && pct < 40;

  // Re-trigger animation when tank levels, refreshKey, or siteFilter change
  useEffect(() => {
    setAnimationFinished(false);
    setDisplayLiters(0);
    setDisplayPct(0);

    const staggerDelayMs = index * 100;
    const durationMs = 1000;
    const startTime = performance.now();

    let animationFrameId: number;

    const timeoutId = setTimeout(() => {
      const targetLiters = tank.currentLevelLiters;
      const targetPct = pct;

      const step = (currentTime: number) => {
        const elapsed = currentTime - (startTime + staggerDelayMs);
        if (elapsed <= 0) {
          animationFrameId = requestAnimationFrame(step);
          return;
        }

        const progress = Math.min(1, elapsed / durationMs);
        // Ease out cubic
        const easedProgress = 1 - Math.pow(1 - progress, 3);

        setDisplayLiters(Math.round(targetLiters * easedProgress));
        setDisplayPct(Math.round(targetPct * easedProgress));

        if (progress < 1) {
          animationFrameId = requestAnimationFrame(step);
        } else {
          setAnimationFinished(true);
        }
      };

      animationFrameId = requestAnimationFrame(step);
    }, staggerDelayMs);

    return () => {
      clearTimeout(timeoutId);
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    };
  }, [tank.currentLevelLiters, tank.capacityLiters, siteFilter, index, pct, refreshKey]);

  // Signature Amber Gradient with status adjustment for critical/warn
  const getLiquidBgClass = () => {
    if (isCritical) return 'bg-gradient-to-t from-[#93000a] via-[#ff5449] to-[#ffb4ab]';
    if (isWarning) return 'bg-gradient-to-t from-[#613100] via-[#ff8a00] to-[#ffb77f]';
    // Section 1.4 Signature Amber Gradient
    return 'bg-gradient-to-t from-[#6b4c00] via-[#ffb800] to-[#ffdca1]';
  };

  const statusLabel = isCritical ? 'Kritik' : isWarning ? 'Uyarı' : 'Normal';

  const staggerDelaySec = (index * 100) / 1000;

  // COMPACT Variant (Used in Overview Dashboard)
  if (variant === 'compact') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: staggerDelaySec }}
        className="group relative flex flex-col items-center space-y-3 bg-[#1c1b1b] hover:bg-[#20201f] border border-[#514532]/20 hover:border-[#ffdca1]/40 p-3.5 rounded-xl transition-all duration-150"
      >
        {/* Capsule Tube */}
        <div className="relative w-14 h-36 bg-[#0e0e0e] border-2 border-[#514532]/40 rounded-full p-1 flex flex-col justify-end overflow-hidden shadow-inner shrink-0">
          <div className="absolute left-1.5 top-3 bottom-3 w-1 bg-white/10 rounded-full pointer-events-none z-20" />
          <motion.div
            initial={{ height: '0%' }}
            animate={{ height: `${pct}%` }}
            transition={{ duration: 1.0, ease: [0.16, 1, 0.3, 1], delay: staggerDelaySec }}
            className={`w-full rounded-full relative overflow-hidden ${getLiquidBgClass()}`}
          >
            <div className="h-1 w-full bg-white/40 rounded-t-full" />
          </motion.div>
          <div className="absolute inset-0 flex items-center justify-center font-mono font-black text-xs text-[#e5e2e1] drop-shadow-md z-10">
            %{displayPct}
          </div>
        </div>

        <div className="space-y-1 text-center w-full">
          <p className="text-xs font-bold text-[#e5e2e1] truncate max-w-[100px] mx-auto">
            {tank.name}
          </p>
          <p className="text-[10px] text-[#d5c4ab] font-mono">
            {displayLiters.toLocaleString('tr-TR')} / {tank.capacityLiters.toLocaleString('tr-TR')} L
          </p>
          <div className="h-5 flex items-center justify-center">
            <span className={`text-[9px] font-bold font-mono px-2 py-0.5 rounded ${
              isCritical ? 'bg-[#93000a] text-[#ffdad6]' : isWarning ? 'bg-[#ff8a00]/20 text-[#ffb77f]' : 'bg-[#ffb800]/20 text-[#ffdca1]'
            }`}>
              {statusLabel}
            </span>
          </div>
        </div>
      </motion.div>
    );
  }

  // DETAILED Variant (Full width widescreen Section 5.2 layout)
  const tankCode = tank.name.includes('(')
    ? tank.name.substring(tank.name.indexOf('(') + 1, tank.name.indexOf(')'))
    : `T-0${index + 1}`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: staggerDelaySec }}
      className="group bg-[#20201f] hover:bg-[#2a2a2a] border border-[#514532]/25 hover:border-[#ffdca1]/40 rounded-xl p-6 flex flex-col justify-between space-y-6 transition-all duration-150"
    >
      {/* Kart Üst Satırı: Tank Kodu + Şantiye Adı (label-md, on-surface-variant) & İkon Butonları */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono font-bold uppercase tracking-wider text-[#d5c4ab]">
          {tankCode} • {tank.siteName.toUpperCase()}
        </span>

        <div className="flex items-center space-x-1.5">
          {onEdit && (
            <button
              onClick={() => onEdit(tank)}
              title="Tank Detayları / Düzenle"
              className="p-1.5 text-[#d5c4ab] hover:text-[#ffdca1] hover:bg-[#353535] rounded-md transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-base">database</span>
            </button>
          )}
          {onDelete && (
            <button
              onClick={() => onDelete(tank)}
              title="Tankı Sil"
              className="p-1.5 text-[#d5c4ab] hover:text-[#ffb4ab] hover:bg-[#93000a]/30 rounded-md transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-base">delete</span>
            </button>
          )}
        </div>
      </div>

      {/* Kart Başlığı */}
      <div>
        <h3 className="text-lg font-bold text-[#e5e2e1] group-hover:text-[#ffdca1] transition-colors leading-tight">
          {tank.name}
        </h3>
        <p className="text-xs font-mono text-[#d5c4ab] mt-1 flex items-center space-x-2">
          <span>{tank.fuelType}</span>
          <span>•</span>
          <span className="text-[#a1e8a2] font-semibold">{tank.temperatureC}°C</span>
        </p>
      </div>

      {/* Gösterge Gövdesi: Belirgin şekilde geniş (200-220px genişlik), dikey kapsül tüp formunda */}
      <div className="flex justify-center py-2">
        <div className="relative w-52 h-64 bg-[#0e0e0e] border-2 border-[#514532]/40 group-hover:border-[#ffdca1]/50 rounded-full p-2 flex flex-col justify-end overflow-hidden shadow-inner transition-colors">
          
          {/* Sol taraf cam parlama şeridi */}
          <div className="absolute left-3 top-6 bottom-6 w-2 bg-white/10 rounded-full pointer-events-none z-20" />

          {/* Yatay Referans Çizgileri ve Sağ Kenar Yüzde Etiketleri */}
          <div className="absolute inset-x-0 inset-y-4 px-3 flex flex-col justify-between pointer-events-none z-10 text-[10px] font-mono text-[#d5c4ab]/60">
            {[100, 80, 60, 40, 20, 0].map((val) => (
              <div key={val} className="flex items-center justify-between w-full">
                <div className="w-4 h-[1px] bg-[#514532]/40" />
                <div className="h-[1px] flex-1 mx-2 bg-[#514532]/20" />
                <span className="font-bold text-[9px]">%{val}</span>
              </div>
            ))}
          </div>

          {/* Liquid Fill Bar */}
          <motion.div
            initial={{ height: '0%' }}
            animate={{ height: `${pct}%` }}
            transition={{
              duration: 1.0,
              ease: [0.16, 1, 0.3, 1], // ease-out
              delay: staggerDelaySec
            }}
            className={`w-full rounded-full relative overflow-hidden ${getLiquidBgClass()}`}
          >
            <div className="h-2 w-full bg-white/40 rounded-t-full shadow" />
          </motion.div>

          {/* Center percentage display */}
          <div className="absolute inset-0 flex items-center justify-center font-mono font-black text-2xl text-[#e5e2e1] drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)] z-30">
            %{displayPct}
          </div>
        </div>
      </div>

      {/* Kart Alt Bilgi Bloğu (İki Sütun) */}
      <div className="grid grid-cols-2 gap-4 pt-4 border-t border-[#514532]/20 font-mono text-xs">
        {/* Sol Sütun */}
        <div className="space-y-2">
          <div>
            <span className="text-[10px] text-[#d5c4ab] font-semibold block uppercase tracking-wider">
              MEVCUT MİKTAR
            </span>
            <span className="text-base font-black text-[#e5e2e1] group-hover:text-[#ffdca1] transition-colors">
              {displayLiters.toLocaleString('tr-TR')} L
            </span>
          </div>
          <div>
            <span className="text-[10px] text-[#d5c4ab] font-semibold block uppercase tracking-wider">
              SON DOLUM
            </span>
            <span className="text-xs text-[#e5e2e1] font-bold">
              {tank.lastRefillDate}
            </span>
          </div>
        </div>

        {/* Sağ Sütun */}
        <div className="space-y-2 text-right">
          <div>
            <span className="text-[10px] text-[#d5c4ab] font-semibold block uppercase tracking-wider">
              KAPASİTE
            </span>
            <span className="text-base font-black text-[#e5e2e1]">
              {tank.capacityLiters.toLocaleString('tr-TR')} L
            </span>
          </div>
          <div>
            <span className="text-[10px] text-[#d5c4ab] font-semibold block uppercase tracking-wider">
              DURUM
            </span>
            <span className={`inline-block text-xs font-black uppercase ${
              isCritical ? 'text-[#ffb4ab]' : isWarning ? 'text-[#ffb77f]' : 'text-[#ffdca1]'
            }`}>
              {statusLabel}
            </span>
          </div>
        </div>
      </div>

    </motion.div>
  );
};
