import { Type, type Static } from '@sinclair/typebox';
import { Id, Instant, Revision, object } from './primitives.js';
import { Attachments } from './attachments.js';

const nullableText = (maxLength: number) => Type.Union([Type.String({ maxLength }), Type.Null()]);
export const MaintenancePlan = object({ assetId: Id, reference: Type.String({ maxLength: 4096 }) });
export type MaintenancePlan = Static<typeof MaintenancePlan>;
export const HomeAssetFields = {
  name: Type.String({ minLength: 1, maxLength: 300 }),
  model: Type.String({ maxLength: 300 }),
  serial: Type.String({ maxLength: 300 }),
  location: Type.String({ maxLength: 300 }),
  acquiredDate: nullableText(10),
  notes: Type.String({ maxLength: 20000 }),
};
export const MaintenanceRecordFields = {
  occurredAt: Instant,
  notes: Type.String({ maxLength: 20000 }),
  costAmount: Type.Union([
    Type.String({ pattern: '^(?:0|[1-9][0-9]{0,11})(?:\\.[0-9]{1,4})?$' }),
    Type.Null(),
  ]),
  currency: Type.Union([Type.String({ pattern: '^[A-Z]{3}$' }), Type.Null()]),
};
const common = { scopeId: Id, deletedAt: Type.Union([Instant, Type.Null()]), attachments: Attachments };
export const homeContentSchemas = {
  home_asset: object({ ...common, ...HomeAssetFields, archived: Type.Boolean() }),
  maintenance_record: object({
    ...common,
    ...MaintenanceRecordFields,
    assetId: Id,
    completionId: Type.Union([Id, Type.Null()]),
  }),
};
export type HomeKind = keyof typeof homeContentSchemas;
type Header<K extends HomeKind> = {
  recordId: string;
  kind: K;
  revision: number;
  createdAt: number;
  updatedAt: number;
};
export type HomeAsset = Header<'home_asset'> & Static<typeof homeContentSchemas.home_asset>;
export type MaintenanceRecord = Header<'maintenance_record'> &
  Static<typeof homeContentSchemas.maintenance_record>;
export type HomeRecord = HomeAsset | MaintenanceRecord;
export type HomeSnapshot = { assets: HomeAsset[]; serviceRecords: MaintenanceRecord[] };
export const emptyHome = (): HomeSnapshot => ({ assets: [], serviceRecords: [] });
const target = { recordId: Id, expectedRevision: Revision };
export const homeCommands = {
  CreateHomeAsset: object({ recordId: Id, scopeId: Id, ...HomeAssetFields }),
  UpdateHomeAsset: object({ ...target, ...HomeAssetFields }),
  SetHomeAssetArchived: object({ ...target, archived: Type.Boolean() }),
  DeleteHomeAsset: object(target),
  RestoreHomeAsset: object(target),
  CreateMaintenanceRecord: object({ recordId: Id, scopeId: Id, assetId: Id, ...MaintenanceRecordFields }),
  UpdateMaintenanceRecord: object({ ...target, ...MaintenanceRecordFields }),
  DeleteMaintenanceRecord: object(target),
  RestoreMaintenanceRecord: object(target),
} as const;
