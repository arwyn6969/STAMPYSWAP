import { useState, useEffect } from 'react';
import { getAssetIconUrl, getStampInfo, isNumericAsset, type StampInfo } from '../lib/stamps';

interface AssetIconProps {
  asset: string;
  size?: number;
  showStampNumber?: boolean;
}

export function AssetIcon({ asset, size = 24, showStampNumber = false }: AssetIconProps) {
  const [stampLookup, setStampLookup] = useState<{ asset: string; info: StampInfo | null }>({
    asset: '',
    info: null,
  });
  const [failedIconKey, setFailedIconKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!isNumericAsset(asset)) return undefined;

    getStampInfo(asset)
      .then((info) => {
        if (!cancelled) {
          setStampLookup({ asset, info });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStampLookup({ asset, info: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [asset]);

  const stampInfo = stampLookup.asset === asset ? stampLookup.info : null;

  // Determine image source
  let imgSrc: string;
  if (stampInfo?.stamp_url) {
    imgSrc = stampInfo.stamp_url;
  } else {
    imgSrc = getAssetIconUrl(asset);
  }
  const iconKey = `${asset}:${imgSrc}`;
  const imgError = failedIconKey === iconKey;

  // Display name
  const displayName = stampInfo 
    ? `STAMP #${stampInfo.stamp}` 
    : asset;

  return (
    <span className="asset-icon-wrapper" title={displayName}>
      {!imgError ? (
        <img
          key={iconKey}
          src={imgSrc}
          alt={asset}
          className="asset-icon"
          style={{ width: size, height: size }}
          onError={() => setFailedIconKey(iconKey)}
        />
      ) : (
        <span 
          className="asset-icon-fallback"
          style={{ width: size, height: size }}
        >
          {asset.slice(0, 2)}
        </span>
      )}
      {showStampNumber && stampInfo && (
        <span className="stamp-number">#{stampInfo.stamp}</span>
      )}
    </span>
  );
}
