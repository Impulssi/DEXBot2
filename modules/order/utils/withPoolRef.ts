import { lookupAsset, derivePrice as systemDerivePrice, deriveMarketPrice as systemDeriveMarketPrice } from './system';
import { toFiniteNumber, isValidNumber } from '../format';
import * as MathUtils from './math';
import Logger from '../../logger';

const log = new Logger('PoolRef');

export interface PoolPriceOverrides {
  derivePoolPrice(symA: string, symB: string): Promise<number | null>;
}

export function withPoolRef(
  BitShares: any,
  poolRef: string | null | undefined
): PoolPriceOverrides | null {
  if (!poolRef || typeof poolRef !== 'string' || !poolRef.trim()) return null;

  const ref = poolRef.trim();
  const pinnedId = ref.startsWith('1.19.') ? ref : `1.19.${ref}`;

  log.info(`withPoolRef: pinned to pool ${pinnedId}`);

  return {
    derivePoolPrice: async (symA: string, symB: string): Promise<number | null> => {
      try {
        const [pool] = await BitShares.db.get_objects([pinnedId]);
        if (!pool) {
          log.warn(`derivePoolPrice: pool ${pinnedId} not found`);
          return null;
        }

        let amtA: any = null, amtB: any = null;
        let precA: number | null = null, precB: number | null = null;
        let poolLabel = `${pinnedId}`;

        if (isValidNumber(pool.balance_a) && isValidNumber(pool.balance_b)) {
          const [poolAssetA, poolAssetB] = await Promise.all([
            lookupAsset(BitShares, pool.asset_a),
            lookupAsset(BitShares, pool.asset_b),
          ]);
          if (!poolAssetA?.id || !poolAssetB?.id || poolAssetA.precision == null || poolAssetB.precision == null) {
            log.warn(`derivePoolPrice(pinned=${pinnedId}): cannot resolve pool asset precisions`);
            return null;
          }

          amtA = toFiniteNumber(pool.balance_a);
          amtB = toFiniteNumber(pool.balance_b);
          precA = poolAssetA.precision;
          precB = poolAssetB.precision;
          poolLabel = `${poolAssetA.symbol || pool.asset_a}/${poolAssetB.symbol || pool.asset_b} (${pinnedId})`;
        } else if (Array.isArray(pool.reserves)) {
          const [aMeta, bMeta] = await Promise.all([
            lookupAsset(BitShares, symA),
            lookupAsset(BitShares, symB),
          ]);
          if (!aMeta?.id || !bMeta?.id) {
            log.warn(`derivePoolPrice(pinned=${pinnedId}): cannot resolve ${symA}/${symB}`);
            return null;
          }
          const resA = pool.reserves.find((r: any) => String(r.asset_id) === String(aMeta.id));
          const resB = pool.reserves.find((r: any) => String(r.asset_id) === String(bMeta.id));
          if (resA && resB) {
            amtA = resA.amount;
            amtB = resB.amount;
            precA = aMeta.precision;
            precB = bMeta.precision;
          }
        }

        if (!isValidNumber(amtA) || !isValidNumber(amtB) || toFiniteNumber(amtB) === 0 || precA == null || precB == null) {
          log.warn(`derivePoolPrice(pinned=${pinnedId}): invalid reserves amtA=${amtA} amtB=${amtB}`);
          return null;
        }

        const floatA = MathUtils.blockchainToFloat(amtA, precA);
        const floatB = MathUtils.blockchainToFloat(amtB, precB);
        const price = floatB > 0 ? floatB / floatA : null;

        if (price != null) {
          log.info(`derivePoolPrice: ${symA}/${symB} pool=${poolLabel} [pinned] -> ${price.toFixed(8)}`);
        }
        return price;
      } catch (err: any) {
        log.warn(`derivePoolPrice(pinned=${pinnedId}) failed: ${err?.message || err}`);
        return null;
      }
    },
  };
}

export async function derivePriceWithPoolRef(
  BitShares: any,
  symA: string,
  symB: string,
  mode: string,
  poolRef: string | null | undefined
): Promise<number | null> {
  const effectiveMode = (typeof mode === 'string' ? mode : 'auto').toLowerCase();
  const override = poolRef ? withPoolRef(BitShares, poolRef) : null;

  if (override && effectiveMode !== 'book') {
    const p = await override.derivePoolPrice(symA, symB);
    if (p != null && p > 0) return p;
    if (effectiveMode === 'auto') {
      return systemDeriveMarketPrice(BitShares, symA, symB).catch(() => null);
    }
    return null;
  }

  return systemDerivePrice(BitShares, symA, symB, effectiveMode);
}
