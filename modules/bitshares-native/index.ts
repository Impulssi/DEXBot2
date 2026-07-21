'use strict';

const { createTransport, ConnectionError, AllNodesFailed, RpcError, RpcTimeoutError } = require('./transport');
const { createChainClient, createReadOnlyClient, ChainConfigError } = require('./chain_client');
const { createSubscriptionManager } = require('./subscriptions');
const { createSigningClient, wifToBuffer } = require('./signing_client');
const { createResolvers } = require('./resolvers');
const serial = require('./serial');
const getEcc = require('./crypto/ecc_selector');
const ecc = getEcc();
const tx = require('./tx/builder');
const { GRAPHENE_CHAIN_ID, GRAPHENE_ADDRESS_PREFIX, GRAPHENE_BLOCKCHAIN_PRECISION } = require('./serial/chain_constants');

export = {
    createTransport,
    createChainClient,
    createReadOnlyClient,
    createSubscriptionManager,
    createSigningClient,
    wifToBuffer,
    createResolvers,

    ConnectionError,
    AllNodesFailed,
    RpcError,
    RpcTimeoutError,
    ChainConfigError,
    ...tx,

    serial,
    ecc,
    tx,

    GRAPHENE_CHAIN_ID,
    GRAPHENE_ADDRESS_PREFIX,
    GRAPHENE_BLOCKCHAIN_PRECISION,
};
