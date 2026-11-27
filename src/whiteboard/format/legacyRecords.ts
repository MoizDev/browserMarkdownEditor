export const LEGACY_RECORD_FAMILIES = ['shape', 'binding', 'document', 'user', 'unknown-record', 'unreadable-record',
    'bookmark-asset', 'orphan-asset', 'unreadable-asset', 'rich-text'] as const;
export type LegacyRecordFamily = typeof LEGACY_RECORD_FAMILIES[number];

const recordTypes: ReadonlySet<string> = new Set(LEGACY_RECORD_FAMILIES.map(family => `legacy-${family}`));

export function isImportedLegacyRecord(record: { readonly type: string }): boolean {
    return recordTypes.has(record.type);
}

export const IMPORTED_LEGACY_NODE_FIELDS: ReadonlySet<string> = new Set(['legacyMeta', 'legacyTextLastEditedBy',
    'legacyBookmarkPreview', 'legacyMissingAsset']);

export const IMPORTED_LEGACY_MEDIA_FIELDS: ReadonlySet<string> = new Set(['legacyMeta', 'legacyAssetSource', 'legacyAssetProps',
    'legacyAssetFields']);
