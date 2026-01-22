/**
 * Stampchain API Service
 * Fetches stamp metadata for enriched display
 */

const STAMPCHAIN_API = 'https://stampchain.io/api/v2';
const XCHAIN_ICON_BASE = 'https://xchain.io/icon';

// In-memory cache for stamp metadata
const stampCache = new Map<string, StampInfo | null>();

export interface StampInfo {
  stamp: number;
  cpid: string;
  stamp_url: string;
  stamp_mimetype: string;
  creator: string;
  creator_name?: string;
  supply: number;
  divisible: boolean;
  ident: string; // 'STAMP', 'SRC-20', etc.
}

/**
 * Check if an asset ID looks like a numeric stamp (A + 17 digits)
 */
export function isNumericAsset(asset: string): boolean {
  return /^A\d{17,}$/.test(asset);
}

/**
 * Get icon URL for any Counterparty asset
 * Uses XChain as the source for asset icons
 */
export function getAssetIconUrl(asset: string): string {
  return `${XCHAIN_ICON_BASE}/${encodeURIComponent(asset)}.png`;
}

/**
 * Fetch stamp info from Stampchain API
 * Returns null if asset is not a stamp
 */
export async function getStampInfo(cpid: string): Promise<StampInfo | null> {
  // Check cache first
  if (stampCache.has(cpid)) {
    return stampCache.get(cpid) || null;
  }

  try {
    const res = await fetch(`${STAMPCHAIN_API}/stamps/${cpid}`);
    if (!res.ok) {
      stampCache.set(cpid, null);
      return null;
    }
    
    const data = await res.json();
    if (data && data.stamp) {
      const info: StampInfo = {
        stamp: data.stamp,
        cpid: data.cpid || cpid,
        stamp_url: data.stamp_url || '',
        stamp_mimetype: data.stamp_mimetype || '',
        creator: data.creator || '',
        creator_name: data.creator_name,
        supply: data.supply || 0,
        divisible: data.divisible || false,
        ident: data.ident || 'STAMP',
      };
      stampCache.set(cpid, info);
      return info;
    }
    
    stampCache.set(cpid, null);
    return null;
  } catch {
    stampCache.set(cpid, null);
    return null;
  }
}

/**
 * Get display name for an asset
 * For stamps: "STAMP #XXX"
 * For others: asset name as-is
 */
export async function getAssetDisplayName(asset: string): Promise<string> {
  if (isNumericAsset(asset)) {
    const stampInfo = await getStampInfo(asset);
    if (stampInfo) {
      return `STAMP #${stampInfo.stamp}`;
    }
  }
  return asset;
}

/**
 * Batch fetch stamp info for multiple assets
 * Returns a map of cpid -> StampInfo
 */
export async function batchGetStampInfo(assets: string[]): Promise<Map<string, StampInfo>> {
  const results = new Map<string, StampInfo>();
  const numericAssets = assets.filter(isNumericAsset);
  
  // Fetch in parallel with limit
  const promises = numericAssets.map(async (cpid) => {
    const info = await getStampInfo(cpid);
    if (info) {
      results.set(cpid, info);
    }
  });
  
  await Promise.all(promises);
  return results;
}
