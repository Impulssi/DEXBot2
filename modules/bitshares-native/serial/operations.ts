
import { Serializer } from './serializer';
'use strict';

import {
    uint8, uint16, uint32, int64, uint64,
    bytes as bytesType, bool as bool_type,
    array as arrayType, protocol_id_type, object_id_type,
    static_variant as staticVariantType, set as setType,
    optional as optionalType, extension as extensionType,
    time_point_sec,
    void_type,
    public_key,
} from './types';

const future_extensions = void_type;

const operation = staticVariantType([]);

const transfer_operation_fee_parameters = Serializer('transfer_operation_fee_parameters', {
    fee: uint64,
    price_per_kbyte: uint32,
});

const limit_order_create_operation_fee_parameters = Serializer('limit_order_create_operation_fee_parameters', {
    fee: uint64,
});

const limit_order_cancel_operation_fee_parameters = Serializer('limit_order_cancel_operation_fee_parameters', {
    fee: uint64,
});

const call_order_update_operation_fee_parameters = Serializer('call_order_update_operation_fee_parameters', {
    fee: uint64,
});

const fill_order_operation_fee_parameters = Serializer('fill_order_operation_fee_parameters', {});

const asset_settle_operation_fee_parameters = Serializer('asset_settle_operation_fee_parameters', {
    fee: uint64,
});

const limit_order_update_operation_fee_parameters = Serializer('limit_order_update_operation_fee_parameters', {
    fee: uint64,
});

const liquidity_pool_exchange_operation_fee_parameters = Serializer('liquidity_pool_exchange_operation_fee_parameters', {
    fee: uint64,
});

const credit_offer_accept_operation_fee_parameters = Serializer('credit_offer_accept_operation_fee_parameters', {
    fee: uint64,
});

const credit_deal_repay_operation_fee_parameters = Serializer('credit_deal_repay_operation_fee_parameters', {
    fee: uint64,
});

const credit_deal_update_operation_fee_parameters = Serializer('credit_deal_update_operation_fee_parameters', {
    fee: uint64,
});

// -- Operation fee parameters (all non-virtual Core ops) --

const account_create_operation_fee_parameters = Serializer('account_create_operation_fee_parameters', {
    basic_fee: uint64,
    premium_fee: uint64,
    price_per_kbyte: uint32,
});

const account_update_operation_fee_parameters = Serializer('account_update_operation_fee_parameters', {
    fee: int64,
    price_per_kbyte: uint32,
});

const account_whitelist_operation_fee_parameters = Serializer('account_whitelist_operation_fee_parameters', {
    fee: int64,
});

const account_upgrade_operation_fee_parameters = Serializer('account_upgrade_operation_fee_parameters', {
    membership_annual_fee: uint64,
    membership_lifetime_fee: uint64,
});

const account_transfer_operation_fee_parameters = Serializer('account_transfer_operation_fee_parameters', {
    fee: uint64,
});

const asset_create_operation_fee_parameters = Serializer('asset_create_operation_fee_parameters', {
    symbol3: uint64,
    symbol4: uint64,
    long_symbol: uint64,
    price_per_kbyte: uint32,
});

const asset_update_operation_fee_parameters = Serializer('asset_update_operation_fee_parameters', {
    fee: uint64,
    price_per_kbyte: uint32,
});

const asset_update_bitasset_operation_fee_parameters = Serializer('asset_update_bitasset_operation_fee_parameters', {
    fee: uint64,
});

const asset_update_feed_producers_operation_fee_parameters = Serializer('asset_update_feed_producers_operation_fee_parameters', {
    fee: uint64,
});

const asset_issue_operation_fee_parameters = Serializer('asset_issue_operation_fee_parameters', {
    fee: uint64,
    price_per_kbyte: uint32,
});

const asset_reserve_operation_fee_parameters = Serializer('asset_reserve_operation_fee_parameters', {
    fee: uint64,
});

const asset_fund_fee_pool_operation_fee_parameters = Serializer('asset_fund_fee_pool_operation_fee_parameters', {
    fee: uint64,
});

const asset_global_settle_operation_fee_parameters = Serializer('asset_global_settle_operation_fee_parameters', {
    fee: uint64,
});

const asset_publish_feed_operation_fee_parameters = Serializer('asset_publish_feed_operation_fee_parameters', {
    fee: uint64,
});

const asset_settle_cancel_operation_fee_parameters = Serializer('asset_settle_cancel_operation_fee_parameters', {});

const asset_claim_fees_operation_fee_parameters = Serializer('asset_claim_fees_operation_fee_parameters', {
    fee: uint64,
});

const witness_create_operation_fee_parameters = Serializer('witness_create_operation_fee_parameters', {
    fee: uint64,
});

const witness_update_operation_fee_parameters = Serializer('witness_update_operation_fee_parameters', {
    fee: int64,
});

const proposal_create_operation_fee_parameters = Serializer('proposal_create_operation_fee_parameters', {
    fee: uint64,
    price_per_kbyte: uint32,
});

const proposal_update_operation_fee_parameters = Serializer('proposal_update_operation_fee_parameters', {
    fee: uint64,
    price_per_kbyte: uint32,
});

const proposal_delete_operation_fee_parameters = Serializer('proposal_delete_operation_fee_parameters', {
    fee: uint64,
});

const withdraw_permission_create_operation_fee_parameters = Serializer('withdraw_permission_create_operation_fee_parameters', {
    fee: uint64,
});

const withdraw_permission_update_operation_fee_parameters = Serializer('withdraw_permission_update_operation_fee_parameters', {
    fee: uint64,
});

const withdraw_permission_claim_operation_fee_parameters = Serializer('withdraw_permission_claim_operation_fee_parameters', {
    fee: uint64,
    price_per_kbyte: uint32,
});

const withdraw_permission_delete_operation_fee_parameters = Serializer('withdraw_permission_delete_operation_fee_parameters', {
    fee: uint64,
});

const committee_member_create_operation_fee_parameters = Serializer('committee_member_create_operation_fee_parameters', {
    fee: uint64,
});

const committee_member_update_operation_fee_parameters = Serializer('committee_member_update_operation_fee_parameters', {
    fee: uint64,
});

const committee_member_update_global_parameters_operation_fee_parameters = Serializer('committee_member_update_global_parameters_operation_fee_parameters', {
    fee: uint64,
});

const vesting_balance_create_operation_fee_parameters = Serializer('vesting_balance_create_operation_fee_parameters', {
    fee: uint64,
});

const vesting_balance_withdraw_operation_fee_parameters = Serializer('vesting_balance_withdraw_operation_fee_parameters', {
    fee: uint64,
});

const worker_create_operation_fee_parameters = Serializer('worker_create_operation_fee_parameters', {
    fee: uint64,
});

const custom_operation_fee_parameters = Serializer('custom_operation_fee_parameters', {
    fee: uint64,
    price_per_kbyte: uint32,
});

const assert_operation_fee_parameters = Serializer('assert_operation_fee_parameters', {
    fee: uint64,
});

const balance_claim_operation_fee_parameters = Serializer('balance_claim_operation_fee_parameters', {});

const override_transfer_operation_fee_parameters = Serializer('override_transfer_operation_fee_parameters', {
    fee: uint64,
    price_per_kbyte: uint32,
});

const transfer_to_blind_operation_fee_parameters = Serializer('transfer_to_blind_operation_fee_parameters', {
    fee: uint64,
    price_per_output: uint32,
});

const blind_transfer_operation_fee_parameters = Serializer('blind_transfer_operation_fee_parameters', {
    fee: uint64,
    price_per_output: uint32,
});

const transfer_from_blind_operation_fee_parameters = Serializer('transfer_from_blind_operation_fee_parameters', {
    fee: uint64,
});

const asset_claim_pool_operation_fee_parameters = Serializer('asset_claim_pool_operation_fee_parameters', {
    fee: uint64,
});

const asset_update_issuer_operation_fee_parameters = Serializer('asset_update_issuer_operation_fee_parameters', {
    fee: uint64,
});

const bid_collateral_operation_fee_parameters = Serializer('bid_collateral_operation_fee_parameters', {
    fee: uint64,
});

const execute_bid_operation_fee_parameters = Serializer('execute_bid_operation_fee_parameters', {});

const htlc_create_operation_fee_parameters = Serializer('htlc_create_operation_fee_parameters', {
    fee: uint64,
    fee_per_day: uint64,
});

const htlc_redeem_operation_fee_parameters = Serializer('htlc_redeem_operation_fee_parameters', {
    fee: uint64,
    fee_per_kb: uint64,
});

const htlc_redeemed_operation_fee_parameters = Serializer('htlc_redeemed_operation_fee_parameters', {});

const htlc_extend_operation_fee_parameters = Serializer('htlc_extend_operation_fee_parameters', {
    fee: uint64,
    fee_per_day: uint64,
});

const htlc_refund_operation_fee_parameters = Serializer('htlc_refund_operation_fee_parameters', {});

const custom_authority_create_operation_fee_parameters = Serializer('custom_authority_create_operation_fee_parameters', {
    basic_fee: uint64,
    price_per_byte: uint32,
});

const custom_authority_update_operation_fee_parameters = Serializer('custom_authority_update_operation_fee_parameters', {
    basic_fee: uint64,
    price_per_byte: uint32,
});

const custom_authority_delete_operation_fee_parameters = Serializer('custom_authority_delete_operation_fee_parameters', {
    fee: uint64,
});

const ticket_create_operation_fee_parameters = Serializer('ticket_create_operation_fee_parameters', {
    fee: uint64,
});

const ticket_update_operation_fee_parameters = Serializer('ticket_update_operation_fee_parameters', {
    fee: uint64,
});

const liquidity_pool_create_operation_fee_parameters = Serializer('liquidity_pool_create_operation_fee_parameters', {
    fee: uint64,
});

const liquidity_pool_delete_operation_fee_parameters = Serializer('liquidity_pool_delete_operation_fee_parameters', {
    fee: uint64,
});

const liquidity_pool_deposit_operation_fee_parameters = Serializer('liquidity_pool_deposit_operation_fee_parameters', {
    fee: uint64,
});

const liquidity_pool_withdraw_operation_fee_parameters = Serializer('liquidity_pool_withdraw_operation_fee_parameters', {
    fee: uint64,
});

const samet_fund_create_operation_fee_parameters = Serializer('samet_fund_create_operation_fee_parameters', {
    fee: uint64,
});

const samet_fund_delete_operation_fee_parameters = Serializer('samet_fund_delete_operation_fee_parameters', {
    fee: uint64,
});

const samet_fund_update_operation_fee_parameters = Serializer('samet_fund_update_operation_fee_parameters', {
    fee: uint64,
});

const samet_fund_borrow_operation_fee_parameters = Serializer('samet_fund_borrow_operation_fee_parameters', {
    fee: uint64,
});

const samet_fund_repay_operation_fee_parameters = Serializer('samet_fund_repay_operation_fee_parameters', {
    fee: uint64,
});

const credit_offer_create_operation_fee_parameters = Serializer('credit_offer_create_operation_fee_parameters', {
    fee: uint64,
    price_per_kbyte: uint32,
});

const credit_offer_delete_operation_fee_parameters = Serializer('credit_offer_delete_operation_fee_parameters', {
    fee: uint64,
});

const credit_offer_update_operation_fee_parameters = Serializer('credit_offer_update_operation_fee_parameters', {
    fee: uint64,
    price_per_kbyte: uint32,
});

const credit_deal_expired_operation_fee_parameters = Serializer('credit_deal_expired_operation_fee_parameters', {});

const liquidity_pool_update_operation_fee_parameters = Serializer('liquidity_pool_update_operation_fee_parameters', {
    fee: uint64,
});

const fba_distribute_operation_fee_parameters = Serializer('fba_distribute_operation_fee_parameters', {});

const fee_parameters = staticVariantType([
    transfer_operation_fee_parameters,
    limit_order_create_operation_fee_parameters,
    limit_order_cancel_operation_fee_parameters,
    call_order_update_operation_fee_parameters,
    fill_order_operation_fee_parameters,
]);

fee_parameters.st_operations[5] = account_create_operation_fee_parameters;
fee_parameters.st_operations[6] = account_update_operation_fee_parameters;
fee_parameters.st_operations[7] = account_whitelist_operation_fee_parameters;
fee_parameters.st_operations[8] = account_upgrade_operation_fee_parameters;
fee_parameters.st_operations[9] = account_transfer_operation_fee_parameters;
fee_parameters.st_operations[10] = asset_create_operation_fee_parameters;
fee_parameters.st_operations[11] = asset_update_operation_fee_parameters;
fee_parameters.st_operations[12] = asset_update_bitasset_operation_fee_parameters;
fee_parameters.st_operations[13] = asset_update_feed_producers_operation_fee_parameters;
fee_parameters.st_operations[14] = asset_issue_operation_fee_parameters;
fee_parameters.st_operations[15] = asset_reserve_operation_fee_parameters;
fee_parameters.st_operations[16] = asset_fund_fee_pool_operation_fee_parameters;
fee_parameters.st_operations[17] = asset_settle_operation_fee_parameters;
fee_parameters.st_operations[18] = asset_global_settle_operation_fee_parameters;
fee_parameters.st_operations[19] = asset_publish_feed_operation_fee_parameters;
fee_parameters.st_operations[20] = witness_create_operation_fee_parameters;
fee_parameters.st_operations[21] = witness_update_operation_fee_parameters;
fee_parameters.st_operations[22] = proposal_create_operation_fee_parameters;
fee_parameters.st_operations[23] = proposal_update_operation_fee_parameters;
fee_parameters.st_operations[24] = proposal_delete_operation_fee_parameters;
fee_parameters.st_operations[25] = withdraw_permission_create_operation_fee_parameters;
fee_parameters.st_operations[26] = withdraw_permission_update_operation_fee_parameters;
fee_parameters.st_operations[27] = withdraw_permission_claim_operation_fee_parameters;
fee_parameters.st_operations[28] = withdraw_permission_delete_operation_fee_parameters;
fee_parameters.st_operations[29] = committee_member_create_operation_fee_parameters;
fee_parameters.st_operations[30] = committee_member_update_operation_fee_parameters;
fee_parameters.st_operations[31] = committee_member_update_global_parameters_operation_fee_parameters;
fee_parameters.st_operations[32] = vesting_balance_create_operation_fee_parameters;
fee_parameters.st_operations[33] = vesting_balance_withdraw_operation_fee_parameters;
fee_parameters.st_operations[34] = worker_create_operation_fee_parameters;
fee_parameters.st_operations[35] = custom_operation_fee_parameters;
fee_parameters.st_operations[36] = assert_operation_fee_parameters;
fee_parameters.st_operations[37] = balance_claim_operation_fee_parameters;
fee_parameters.st_operations[38] = override_transfer_operation_fee_parameters;
fee_parameters.st_operations[39] = transfer_to_blind_operation_fee_parameters;
fee_parameters.st_operations[40] = blind_transfer_operation_fee_parameters;
fee_parameters.st_operations[41] = transfer_from_blind_operation_fee_parameters;
fee_parameters.st_operations[42] = asset_settle_cancel_operation_fee_parameters;
fee_parameters.st_operations[43] = asset_claim_fees_operation_fee_parameters;
fee_parameters.st_operations[44] = fba_distribute_operation_fee_parameters;
fee_parameters.st_operations[45] = bid_collateral_operation_fee_parameters;
fee_parameters.st_operations[46] = execute_bid_operation_fee_parameters;
fee_parameters.st_operations[47] = asset_claim_pool_operation_fee_parameters;
fee_parameters.st_operations[48] = asset_update_issuer_operation_fee_parameters;
fee_parameters.st_operations[49] = htlc_create_operation_fee_parameters;
fee_parameters.st_operations[50] = htlc_redeem_operation_fee_parameters;
fee_parameters.st_operations[51] = htlc_redeemed_operation_fee_parameters;
fee_parameters.st_operations[52] = htlc_extend_operation_fee_parameters;
fee_parameters.st_operations[53] = htlc_refund_operation_fee_parameters;
fee_parameters.st_operations[54] = custom_authority_create_operation_fee_parameters;
fee_parameters.st_operations[55] = custom_authority_update_operation_fee_parameters;
fee_parameters.st_operations[56] = custom_authority_delete_operation_fee_parameters;
fee_parameters.st_operations[57] = ticket_create_operation_fee_parameters;
fee_parameters.st_operations[58] = ticket_update_operation_fee_parameters;
fee_parameters.st_operations[59] = liquidity_pool_create_operation_fee_parameters;
fee_parameters.st_operations[60] = liquidity_pool_delete_operation_fee_parameters;
fee_parameters.st_operations[61] = liquidity_pool_deposit_operation_fee_parameters;
fee_parameters.st_operations[62] = liquidity_pool_withdraw_operation_fee_parameters;
fee_parameters.st_operations[63] = liquidity_pool_exchange_operation_fee_parameters;
fee_parameters.st_operations[64] = samet_fund_create_operation_fee_parameters;
fee_parameters.st_operations[65] = samet_fund_delete_operation_fee_parameters;
fee_parameters.st_operations[66] = samet_fund_update_operation_fee_parameters;
fee_parameters.st_operations[67] = samet_fund_borrow_operation_fee_parameters;
fee_parameters.st_operations[68] = samet_fund_repay_operation_fee_parameters;
fee_parameters.st_operations[69] = credit_offer_create_operation_fee_parameters;
fee_parameters.st_operations[70] = credit_offer_delete_operation_fee_parameters;
fee_parameters.st_operations[71] = credit_offer_update_operation_fee_parameters;
fee_parameters.st_operations[72] = credit_offer_accept_operation_fee_parameters;
fee_parameters.st_operations[73] = credit_deal_repay_operation_fee_parameters;
fee_parameters.st_operations[74] = credit_deal_expired_operation_fee_parameters;
fee_parameters.st_operations[75] = liquidity_pool_update_operation_fee_parameters;
fee_parameters.st_operations[76] = credit_deal_update_operation_fee_parameters;
fee_parameters.st_operations[77] = limit_order_update_operation_fee_parameters;

const fee_schedule = Serializer('fee_schedule', {
    parameters: setType(fee_parameters),
    scale: uint32,
});

const void_result = Serializer('void_result', {});

const asset = Serializer('asset', {
    amount: int64,
    asset_id: protocol_id_type('asset'),
});

const price = Serializer('price', {
    base: asset,
    quote: asset,
});

const memo_data = Serializer('memo_data', {
    from: public_key,
    to: public_key,
    nonce: uint64,
    message: bytesType(),
});

const create_take_profit_order_action = Serializer('create_take_profit_order_action', {
    fee_asset_id: protocol_id_type('asset'),
    spread_percent: uint16,
    size_percent: uint16,
    expiration_seconds: uint32,
    repeat: bool_type,
    extensions: setType(void_type),
});

const limit_order_auto_action = staticVariantType([create_take_profit_order_action]);

const limit_order_create = Serializer('limit_order_create', {
    fee: asset,
    seller: protocol_id_type('account'),
    amount_to_sell: asset,
    min_to_receive: asset,
    expiration: time_point_sec,
    fill_or_kill: bool_type,
    extensions: extensionType([
        { name: 'on_fill', type: arrayType(limit_order_auto_action) },
    ]),
});

const limit_order_cancel = Serializer('limit_order_cancel', {
    fee: asset,
    fee_paying_account: protocol_id_type('account'),
    order: protocol_id_type('limit_order'),
    extensions: setType(future_extensions),
});

const call_order_update = Serializer('call_order_update', {
    fee: asset,
    funding_account: protocol_id_type('account'),
    delta_collateral: asset,
    delta_debt: asset,
    extensions: extensionType([
        { name: 'target_collateral_ratio', type: uint16 },
    ]),
});

const fill_order = Serializer('fill_order', {
    fee: asset,
    order_id: object_id_type,
    account_id: protocol_id_type('account'),
    pays: asset,
    receives: asset,
    fill_price: price,
    is_maker: bool_type,
});

const asset_settle = Serializer('asset_settle', {
    fee: asset,
    account: protocol_id_type('account'),
    amount: asset,
    extensions: setType(future_extensions),
});

const transfer = Serializer('transfer', {
    fee: asset,
    from: protocol_id_type('account'),
    to: protocol_id_type('account'),
    amount: asset,
    memo: optionalType(memo_data),
    extensions: setType(future_extensions),
});

const limit_order_update = Serializer('limit_order_update', {
    fee: asset,
    seller: protocol_id_type('account'),
    order: protocol_id_type('limit_order'),
    new_price: optionalType(price),
    delta_amount_to_sell: optionalType(asset),
    new_expiration: optionalType(time_point_sec),
    on_fill: optionalType(arrayType(limit_order_auto_action)),
    extensions: setType(future_extensions),
});

const credit_offer_accept = Serializer('credit_offer_accept', {
    fee: asset,
    borrower: protocol_id_type('account'),
    offer_id: protocol_id_type('credit_offer'),
    borrow_amount: asset,
    collateral: asset,
    max_fee_rate: uint32,
    min_duration_seconds: uint32,
    extensions: extensionType([
        { name: 'auto_repay', type: uint8 },
    ]),
});

const credit_deal_repay = Serializer('credit_deal_repay', {
    fee: asset,
    account: protocol_id_type('account'),
    deal_id: protocol_id_type('credit_deal'),
    repay_amount: asset,
    credit_fee: asset,
    extensions: setType(future_extensions),
});

const credit_deal_update = Serializer('credit_deal_update', {
    fee: asset,
    account: protocol_id_type('account'),
    deal_id: protocol_id_type('credit_deal'),
    auto_repay: uint8,
    extensions: setType(future_extensions),
});

const liquidity_pool_exchange = Serializer('liquidity_pool_exchange', {
    fee: asset,
    account: protocol_id_type('account'),
    pool: protocol_id_type('liquidity_pool'),
    amount_to_sell: asset,
    min_to_receive: asset,
    extensions: setType(future_extensions),
});

operation.st_operations = [
    transfer,
    limit_order_create,
    limit_order_cancel,
    call_order_update,
    fill_order,
];

operation.st_operations[17] = asset_settle;
operation.st_operations[72] = credit_offer_accept;
operation.st_operations[73] = credit_deal_repay;
operation.st_operations[76] = credit_deal_update;
operation.st_operations[63] = liquidity_pool_exchange;
operation.st_operations[77] = limit_order_update;

const generic_operation_result = Serializer('generic_operation_result', {
    new_objects: setType(object_id_type),
    updated_objects: setType(object_id_type),
    removed_objects: setType(object_id_type),
});

const generic_exchange_operation_result = Serializer('generic_exchange_operation_result', {
    paid: arrayType(asset),
    received: arrayType(asset),
    fees: arrayType(asset),
});

const extendable_operation_result = extensionType([
    { name: 'impacted_accounts', type: setType(protocol_id_type('account')) },
    { name: 'new_objects', type: setType(object_id_type) },
    { name: 'updated_objects', type: setType(object_id_type) },
    { name: 'removed_objects', type: setType(object_id_type) },
    { name: 'paid', type: arrayType(asset) },
    { name: 'received', type: arrayType(asset) },
    { name: 'fees', type: arrayType(asset) },
]);

const operation_result = staticVariantType([
    void_result,
    object_id_type,
    asset,
    generic_operation_result,
    generic_exchange_operation_result,
    extendable_operation_result,
]);

const transaction = Serializer('transaction', {
    ref_block_num: uint16,
    ref_block_prefix: uint32,
    expiration: time_point_sec,
    operations: arrayType(operation),
    extensions: setType(future_extensions),
});

const signed_transaction = Serializer('signed_transaction', {
    ref_block_num: uint16,
    ref_block_prefix: uint32,
    expiration: time_point_sec,
    operations: arrayType(operation),
    extensions: setType(future_extensions),
    signatures: arrayType(bytesType(65)),
});

const processed_transaction = Serializer('processed_transaction', {
    ref_block_num: uint16,
    ref_block_prefix: uint32,
    expiration: time_point_sec,
    operations: arrayType(operation),
    extensions: setType(future_extensions),
    signatures: arrayType(bytesType(65)),
    operation_results: arrayType(operation_result),
});

export { operation, transaction, signed_transaction, processed_transaction, transfer, limit_order_create, limit_order_cancel, call_order_update, fill_order, asset_settle, limit_order_update, credit_offer_accept, credit_deal_repay, credit_deal_update, liquidity_pool_exchange, fee_schedule, fee_parameters, asset, price, void_result, transfer_operation_fee_parameters, limit_order_create_operation_fee_parameters, limit_order_cancel_operation_fee_parameters, call_order_update_operation_fee_parameters, fill_order_operation_fee_parameters, asset_settle_operation_fee_parameters, limit_order_update_operation_fee_parameters, credit_offer_accept_operation_fee_parameters, credit_deal_repay_operation_fee_parameters, credit_deal_update_operation_fee_parameters, liquidity_pool_exchange_operation_fee_parameters, account_create_operation_fee_parameters, account_update_operation_fee_parameters, account_whitelist_operation_fee_parameters, account_upgrade_operation_fee_parameters, account_transfer_operation_fee_parameters, asset_create_operation_fee_parameters, asset_update_operation_fee_parameters, asset_update_bitasset_operation_fee_parameters, asset_update_feed_producers_operation_fee_parameters, asset_issue_operation_fee_parameters, asset_reserve_operation_fee_parameters, asset_fund_fee_pool_operation_fee_parameters, asset_global_settle_operation_fee_parameters, asset_publish_feed_operation_fee_parameters, asset_settle_cancel_operation_fee_parameters, asset_claim_fees_operation_fee_parameters, witness_create_operation_fee_parameters, witness_update_operation_fee_parameters, proposal_create_operation_fee_parameters, proposal_update_operation_fee_parameters, proposal_delete_operation_fee_parameters, withdraw_permission_create_operation_fee_parameters, withdraw_permission_update_operation_fee_parameters, withdraw_permission_claim_operation_fee_parameters, withdraw_permission_delete_operation_fee_parameters, committee_member_create_operation_fee_parameters, committee_member_update_operation_fee_parameters, committee_member_update_global_parameters_operation_fee_parameters, vesting_balance_create_operation_fee_parameters, vesting_balance_withdraw_operation_fee_parameters, worker_create_operation_fee_parameters, custom_operation_fee_parameters, assert_operation_fee_parameters, balance_claim_operation_fee_parameters, override_transfer_operation_fee_parameters, transfer_to_blind_operation_fee_parameters, blind_transfer_operation_fee_parameters, transfer_from_blind_operation_fee_parameters, asset_claim_pool_operation_fee_parameters, asset_update_issuer_operation_fee_parameters, bid_collateral_operation_fee_parameters, execute_bid_operation_fee_parameters, htlc_create_operation_fee_parameters, htlc_redeem_operation_fee_parameters, htlc_redeemed_operation_fee_parameters, htlc_extend_operation_fee_parameters, htlc_refund_operation_fee_parameters, custom_authority_create_operation_fee_parameters, custom_authority_update_operation_fee_parameters, custom_authority_delete_operation_fee_parameters, ticket_create_operation_fee_parameters, ticket_update_operation_fee_parameters, liquidity_pool_create_operation_fee_parameters, liquidity_pool_delete_operation_fee_parameters, liquidity_pool_deposit_operation_fee_parameters, liquidity_pool_withdraw_operation_fee_parameters, samet_fund_create_operation_fee_parameters, samet_fund_delete_operation_fee_parameters, samet_fund_update_operation_fee_parameters, samet_fund_borrow_operation_fee_parameters, samet_fund_repay_operation_fee_parameters, credit_offer_create_operation_fee_parameters, credit_offer_delete_operation_fee_parameters, credit_offer_update_operation_fee_parameters, credit_deal_expired_operation_fee_parameters, liquidity_pool_update_operation_fee_parameters, fba_distribute_operation_fee_parameters }

