function ensureFeeCache(customCache: Record<string, any> | null = null) {
    const { _setFeeCache } = require('../../modules/order/utils/math');
    try {
        require('../../modules/order/utils/math').getAssetFees('BTS');
    } catch {
        _setFeeCache(customCache || {
            BTS: {
                limitOrderCreate: { bts: 0.1 },
                limitOrderCancel: { bts: 0.05 },
                limitOrderUpdate: { bts: 0.05 },
                makerFeeDiscountPercent: 0.25,
            },
        });
    }
}

module.exports = { ensureFeeCache };
