import { useState, useEffect } from 'react';
import { getAssetIconUrl, getStampInfo, isNumericAsset, type StampInfo } from '../lib/stamps';

interface AssetIconProps {
  asset: string;
  size?: number;
  showStampNumber?: boolean;
}

export function AssetIcon({ asset, size = 24, showStampNumber = false }: AssetIconProps) {
  const [stampInfo, setStampInfo] = useState<StampInfo | null>(null);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    if (isNumericAsset(asset)) {
      getStampInfo(asset).then(setStampInfo);
    }
  }, [asset]);

  // Determine image source
  let imgSrc: string;
  if (stampInfo?.stamp_url) {
    imgSrc = stampInfo.stamp_url;
  } else {
    imgSrc = getAssetIconUrl(asset);
  }

  // Display name
  const displayName = stampInfo 
    ? `STAMP #${stampInfo.stamp}` 
    : asset;

  return (
    <span className="asset-icon-wrapper" title={displayName}>
      {!imgError ? (
        <img
          src={imgSrc}
          alt={asset}
          className="asset-icon"
          style={{ width: size, height: size }}
          onError={() => setImgError(true)}
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
