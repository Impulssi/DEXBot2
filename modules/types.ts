/**
 * DEXBot2 Central Type Definitions
 *
 * Where possible, types align with the BitShares C++ protocol headers
 * at https://github.com/bitshares/bitshares-core
 *
 * See libraries/protocol/include/graphene/protocol/ for canonical defs.
 */

// ============================================================
// STRING LITERAL ENUMS
// ============================================================

export type OrderType = 'sell' | 'buy' | 'spread';
export type OrderState = 'virtual' | 'active' | 'partial';

// ============================================================
// DOMAIN: ORDER (DISCRIMINATED UNION)
// ============================================================

export interface OrderBase {
  id: string;
  price: number;
  type: OrderType;
  state: OrderState;
  size: number;
  orderId: string | null;
  committedSide?: OrderType;
  rawOnChain?: { for_sale?: number };
  metadata?: Record<string, any>;
  gridIndex?: number;
  idealSize?: number;
  sideHint?: string;
}

export interface VirtualOrder extends OrderBase {
  state: 'virtual';
  orderId: null | '';
}

export interface ActiveOrder extends OrderBase {
  state: 'active';
  orderId: string;
  size: number;
}

export interface PartialOrder extends OrderBase {
  state: 'partial';
  orderId: string;
  size: number;
}

export type Order = VirtualOrder | ActiveOrder | PartialOrder;
