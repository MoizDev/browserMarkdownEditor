import { conversionDigest } from '../import/conversionMetadata';
import type { BoardDoc } from '../model/doc';

/** Plain data may cross the host boundary; the digest names the pre-conversion outer backup. */
export function boardConversionInfo(doc: BoardDoc): { readonly legacyOriginalSha256: string | null } {
    return { legacyOriginalSha256: conversionDigest(doc.preserved) };
}
