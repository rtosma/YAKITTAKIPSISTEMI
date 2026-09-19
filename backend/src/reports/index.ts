/**
 * REP-703 — rapor kataloğunu process başlatılırken doldurur. `routes.ts`
 * bu dosyayı BİR KEZ import eder (side effect); yeni bir rapor eklemek
 * `definitions/` altına bir dosya + burada bir satır import eklemekten
 * ibarettir (AC: "yeni bir rapor yalnızca tanım eklenerek üretilebilmeli").
 */
import './definitions/rep711DispenseMovement';
import './definitions/rep712VehicleConsumption';
import './definitions/rep713SiteStock';
import './definitions/rep714TankReconciliation';
import './definitions/rep722AuditReport';

export { getReportDefinition, listReportsForRole } from './reportRegistry';
export { runReport, streamReportExport, assertPdfRowLimit } from './reportEngine';
export type { ReportQueryParams } from './reportEngine';
export { streamReportToCsv } from './csvExport';
export { streamReportToPdf } from './pdfExport';
