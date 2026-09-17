import { z } from 'zod';

/** IOT-306 — firmware artefakt kataloğu (SUPER_ADMIN) + kademeli rollout (tenant). */
export const createFirmwareArtifactSchema = z.object({
  version: z.string().min(1, 'version zorunludur.').max(32),
  hardwareRevision: z.string().min(1, 'hardwareRevision zorunludur.').max(64),
  channel: z.enum(['stable', 'beta']).default('stable'),
  artifactUrl: z.string().url('artifactUrl geçerli bir URL olmalıdır.').max(512),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i, 'sha256 64 hex karakter olmalıdır.'),
  signature: z.string().min(1, 'signature zorunludur.').max(4096)
});
export type CreateFirmwareArtifactDTO = z.infer<typeof createFirmwareArtifactSchema>;

export const listFirmwareArtifactQuerySchema = z.object({
  hardwareRevision: z.string().min(1).max(64).optional(),
  channel: z.enum(['stable', 'beta']).optional()
});
export type ListFirmwareArtifactQueryDTO = z.infer<typeof listFirmwareArtifactQuerySchema>;

export const startFirmwareRolloutSchema = z.object({
  firmwareArtifactId: z.string().min(1, 'firmwareArtifactId zorunludur.').max(64),
  siteName: z.string().min(1).max(128).optional()
});
export type StartFirmwareRolloutDTO = z.infer<typeof startFirmwareRolloutSchema>;

export const listFirmwareRolloutQuerySchema = z.object({
  status: z.enum(['DEVAM_EDIYOR', 'DURDURULDU', 'TAMAMLANDI']).optional()
});
export type ListFirmwareRolloutQueryDTO = z.infer<typeof listFirmwareRolloutQuerySchema>;

export const reportRolloutRollbackSchema = z.object({
  reason: z.string().min(5, 'reason en az 5 karakter olmalıdır.').max(1000)
});
export type ReportRolloutRollbackDTO = z.infer<typeof reportRolloutRollbackSchema>;
