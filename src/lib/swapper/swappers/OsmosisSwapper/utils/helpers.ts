import {
  CHAIN_REFERENCE,
  cosmosChainId,
  fromAccountId,
  fromChainId,
  osmosisChainId,
  toAccountId,
} from '@shapeshiftoss/caip'
import type { osmosis, SignTxInput } from '@shapeshiftoss/chain-adapters'
import { toAddressNList } from '@shapeshiftoss/chain-adapters'
import type { CosmosSignTx, HDWallet, Osmosis, OsmosisSignTx } from '@shapeshiftoss/hdwallet-core'
import { TxStatus } from '@shapeshiftoss/unchained-client'
import type { IbcMetadata } from '@shapeshiftoss/unchained-client/src/cosmossdk'
import type { Result } from '@sniptt/monads'
import { Err, Ok } from '@sniptt/monads'
import axios from 'axios'
import { find } from 'lodash'
import { bn, bnOrZero } from 'lib/bignumber/bignumber'
import type { SwapErrorRight, TradeResult } from 'lib/swapper/api'
import { makeSwapErrorRight, SwapError, SwapErrorType } from 'lib/swapper/api'
import { osmoService } from 'lib/swapper/swappers/OsmosisSwapper/utils/osmoService'
import type {
  IbcTransferInput,
  OsmosisSupportedChainAdapter,
  PoolInfo,
  PoolRateInfo,
} from 'lib/swapper/swappers/OsmosisSwapper/utils/types'
import { selectTxById, selectTxsByFilter } from 'state/slices/selectors'
import type { Tx } from 'state/slices/txHistorySlice/txHistorySlice'
import { deserializeTxIndex } from 'state/slices/txHistorySlice/utils'
import { store } from 'state/store'

export interface SymbolDenomMapping {
  OSMO: string
  ATOM: string
  USDC: string
}

export const symbolDenomMapping = {
  OSMO: 'uosmo',
  ATOM: 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2',
  USDC: 'ibc/D189335C6E4A68B513C10AB227BF1C1D38C746766278BA3EEB4FB14124F1D858',
}

type FindPoolOutput = {
  pool: PoolInfo
  sellAssetIndex: number
  buyAssetIndex: number
}

// We can probably ditch this fn altogether and straight up do the selectTxById dance?
const getTx = (txid: string): Tx | undefined => {
  try {
    const tx = selectTxById(store.getState(), txid)
    if (!tx) throw new Error('Tx not yet found')
    return tx
  } catch (e) {
    // Making TS happy, this will never get hit - we poll until the Tx is found
    console.warn('Retrying to retrieve tx')
  }

  return
}

// We can probably ditch this fn altogether and straight up do the selectTxById dance?
const getTxStatus = (txid: string): string => {
  try {
    const tx = selectTxById(store.getState(), txid)
    if (!tx) throw new Error('Tx not yet found')
    if (tx.status === TxStatus.Confirmed) return 'success'
    if (tx.status === TxStatus.Failed) return 'failed'

    throw new Error('Tx pending')
  } catch (e) {
    console.warn('Retrying to retrieve status')
  }
  // Making TS happy, this will never get hit - we poll until the Tx is found
  return 'not found'
}

// TODO: leverage chain-adapters websockets
export const pollForComplete = ({ txid }: { txid: string }): Promise<string> => {
  return new Promise((resolve, reject) => {
    const timeout = 300000 // 5 mins
    const startTime = Date.now()
    const interval = 5000 // 5 seconds

    const poll = function () {
      const status = getTxStatus(txid)
      if (status === 'success') {
        resolve(status)
      } else if (Date.now() - startTime > timeout) {
        reject(
          new SwapError(`Couldnt find tx ${txid}`, {
            code: SwapErrorType.RESPONSE_ERROR,
          }),
        )
      } else {
        setTimeout(poll, interval)
      }
    }
    poll()
  })
}

// More logic here, since an IBC transfer consists of 2 transactions
// 1. MsgTransfer on the initiating chain i.e send from source chain to destination chain
// 2. MsgRecvPacket on the receiving chain i.e receive on destination chain from source chain
// While 1. can simply be polled for (which we do on the method above),
// the destination Tx needs to be picked by validators on the destination chain, and we don't know anything about said Tx in advance
// TODO(gomes): Now that we're relying on Txhistory Txs, we could make this a usePoll hook, reactive on the TxHistory slice?
export const pollForCrossChainComplete = ({
  initiatingChainTxid,
}: {
  initiatingChainTxid: string
  baseUrl: string
}): Promise<string> => {
  return new Promise((resolve, reject) => {
    const timeout = 300000 // 5 mins
    const startTime = Date.now()
    const interval = 5000 // 5 seconds

    const poll = function () {
      const initiatingChainStatus = getTxStatus(initiatingChainTxid)
      const initiatingChainTx = getTx(initiatingChainTxid)
      if (initiatingChainStatus === 'success' && initiatingChainTx) {
        // Initiating Tx is successful, now we need to wait for the destination tx to be picked up by validators

        // TODO(gomes): if we can pass initiating/destination accountId, we can avoid this whole dance
        // Sure, we'll have more room for errors as we'll have to make sure to pass them right, but that will make this a lot cleaner
        const initiatingChainAccountId = deserializeTxIndex(initiatingChainTxid).accountId
        const initiatingChainId = fromAccountId(initiatingChainAccountId).chainId
        const initiatingChainSequence = (initiatingChainTx.data as IbcMetadata | undefined)
          ?.sequence
        const destinationChainAddress = (initiatingChainTx.data as IbcMetadata | undefined)
          ?.ibcDestination

        // None of these two should ever happen but it may - a confirmed MsgTransfer Tx contains an initiating sequence and a destination address
        // if we don't parse them, we have bigger problems at unchained-client level
        if (!initiatingChainSequence) throw new Error('sequence not found in initiating Tx')
        if (!destinationChainAddress) throw new Error('ibcDestination not found in initiating Tx')

        const destinationChainId =
          initiatingChainId === cosmosChainId ? osmosisChainId : cosmosChainId
        const destinationChainAccountId = toAccountId({
          chainId: destinationChainId,
          account: destinationChainAddress,
        })

        const destinationAccountTxs = selectTxsByFilter(store.getState(), {
          accountId: destinationChainAccountId,
        })
        const maybeFoundTx = destinationAccountTxs.some(
          tx => (tx.data as IbcMetadata | undefined)?.sequence === initiatingChainSequence,
        )

        if (maybeFoundTx) return resolve('success')
        else return setTimeout(poll, interval)
      } else if (Date.now() - startTime > timeout) {
        reject(
          new SwapError(`Couldnt find tx ${initiatingChainTxid}`, {
            code: SwapErrorType.RESPONSE_ERROR,
          }),
        )
      } else {
        setTimeout(poll, interval)
      }
    }
    poll()
  })
}

const findPool = async (
  sellAssetSymbol: string,
  buyAssetSymbol: string,
  osmoUrl: string,
): Promise<Result<FindPoolOutput, SwapErrorRight>> => {
  const sellAssetDenom = symbolDenomMapping[sellAssetSymbol as keyof SymbolDenomMapping]
  const buyAssetDenom = symbolDenomMapping[buyAssetSymbol as keyof SymbolDenomMapping]

  const poolsUrl = osmoUrl + '/lcd/osmosis/gamm/v1beta1/pools?pagination.limit=1000'

  const maybePoolsResponse = await osmoService.get(poolsUrl)

  return maybePoolsResponse.andThen<FindPoolOutput>(poolsResponse => {
    const foundPool = find(poolsResponse.data.pools, pool => {
      const token0Denom = pool.pool_assets[0].token.denom
      const token1Denom = pool.pool_assets[1].token.denom
      return (
        (token0Denom === sellAssetDenom && token1Denom === buyAssetDenom) ||
        (token0Denom === buyAssetDenom && token1Denom === sellAssetDenom)
      )
    })

    if (!foundPool)
      return Err(
        makeSwapErrorRight({ message: 'could not find pool', code: SwapErrorType.POOL_NOT_FOUND }),
      )

    const { sellAssetIndex, buyAssetIndex } = (() => {
      if (foundPool.pool_assets[0].token.denom === sellAssetDenom) {
        return { sellAssetIndex: 0, buyAssetIndex: 1 }
      } else {
        return { sellAssetIndex: 1, buyAssetIndex: 0 }
      }
    })()

    return Ok({ pool: foundPool, sellAssetIndex, buyAssetIndex })
  })
}

const getPoolRateInfo = (
  sellAmount: string,
  pool: PoolInfo,
  sellAssetIndex: number,
  buyAssetIndex: number,
): PoolRateInfo => {
  const constantProduct = bnOrZero(pool.pool_assets[0].token.amount).times(
    pool.pool_assets[1].token.amount,
  )
  const sellAssetInitialPoolSize = bnOrZero(pool.pool_assets[sellAssetIndex].token.amount)
  const buyAssetInitialPoolSize = bnOrZero(pool.pool_assets[buyAssetIndex].token.amount)

  const initialMarketPrice = sellAssetInitialPoolSize.dividedBy(buyAssetInitialPoolSize)
  const sellAssetFinalPoolSize = sellAssetInitialPoolSize.plus(sellAmount)
  const buyAssetFinalPoolSize = constantProduct.dividedBy(sellAssetFinalPoolSize)
  const finalMarketPrice = sellAssetFinalPoolSize.dividedBy(buyAssetFinalPoolSize)
  const buyAmountCryptoBaseUnit = buyAssetInitialPoolSize.minus(buyAssetFinalPoolSize).toFixed(0)
  const rate = bnOrZero(buyAmountCryptoBaseUnit).dividedBy(sellAmount).toString()
  const priceImpact = bn(1).minus(initialMarketPrice.dividedBy(finalMarketPrice)).abs().toString()
  const buyAssetTradeFeeCryptoBaseUnit = bnOrZero(buyAmountCryptoBaseUnit)
    .times(bnOrZero(pool.pool_params.swap_fee))
    .toFixed(0)

  return {
    rate,
    priceImpact,
    buyAssetTradeFeeCryptoBaseUnit,
    buyAmountCryptoBaseUnit,
  }
}

export const getRateInfo = async (
  sellAsset: string,
  buyAsset: string,
  sellAmount: string,
  osmoUrl: string,
): Promise<Result<PoolRateInfo, SwapErrorRight>> => {
  const maybePool = await findPool(sellAsset, buyAsset, osmoUrl)
  return maybePool.andThen(({ pool, sellAssetIndex, buyAssetIndex }) =>
    Ok(getPoolRateInfo(sellAmount, pool, sellAssetIndex, buyAssetIndex)),
  )
}

type PerformIbcTransferInput = {
  input: IbcTransferInput
  adapter: OsmosisSupportedChainAdapter
  blockBaseUrl: string
  denom: string
  sourceChannel: string
  feeAmount: string
  accountNumber: number
  ibcAccountNumber: number
  sequence: string
  gas: string
  feeDenom: string
}

export const buildPerformIbcTransferUnsignedTx = async ({
  input,
  adapter,
  blockBaseUrl,
  denom,
  sourceChannel,
  feeAmount,
  accountNumber,
  ibcAccountNumber,
  sequence,
  gas,
  feeDenom,
}: PerformIbcTransferInput): Promise<CosmosSignTx> => {
  const { sender, receiver, amount } = input

  const responseLatestBlock = await (() => {
    try {
      return axios.get(`${blockBaseUrl}/lcd/blocks/latest`)
    } catch (e) {
      throw new SwapError('failed to get latest block', {
        code: SwapErrorType.RESPONSE_ERROR,
      })
    }
  })()
  const latestBlock = responseLatestBlock.data.block.header.height

  const tx: Osmosis.StdTx = {
    memo: '',
    fee: {
      amount: [
        {
          amount: feeAmount.toString(),
          denom: feeDenom,
        },
      ],
      gas,
    },
    signatures: [],
    msg: [
      {
        type: 'cosmos-sdk/MsgTransfer',
        value: {
          source_port: 'transfer',
          source_channel: sourceChannel,
          token: {
            denom,
            amount,
          },
          sender,
          receiver,
          timeout_height: {
            revision_number: '4',
            revision_height: String(Number(latestBlock) + 100),
          },
        },
      },
    ],
  }

  const bip44Params = adapter.getBIP44Params({ accountNumber })

  return {
    tx,
    addressNList: toAddressNList(bip44Params),
    chain_id: fromChainId(adapter.getChainId()).chainReference,
    account_number: ibcAccountNumber.toString(),
    sequence,
  }
}

export const performIbcTransfer = async (
  ibcTransferInput: PerformIbcTransferInput & { wallet: HDWallet },
): Promise<TradeResult> => {
  const { adapter, wallet } = ibcTransferInput
  const txToSign = await buildPerformIbcTransferUnsignedTx(ibcTransferInput)
  const signed = await adapter.signTransaction({
    txToSign,
    wallet,
  })
  const tradeId = await adapter.broadcastTransaction(signed)

  return {
    tradeId,
  }
}

type BuildTradeTxInput = {
  osmoAddress: string
  adapter: osmosis.ChainAdapter
  accountNumber: number
  buyAssetDenom: string
  sellAssetDenom: string
  sellAmount: string
  gas: string
  feeAmount: string
  feeDenom: string
}

export const buildApiTradeTx = async ({
  osmoAddress,
  adapter,
  accountNumber,
  buyAssetDenom,
  sellAssetDenom,
  sellAmount,
  gas,
  feeAmount,
  feeDenom,
}: BuildTradeTxInput): Promise<CosmosSignTx> => {
  const responseAccount = await adapter.getAccount(osmoAddress)

  // note - this is a cosmos sdk specific account_number, not a bip44Params accountNumber
  const account_number = responseAccount.chainSpecific.accountNumber || '0'
  const sequence = responseAccount.chainSpecific.sequence || '0'

  const tx: Osmosis.StdTx = {
    memo: '',
    fee: {
      amount: [
        {
          amount: feeAmount,
          denom: feeDenom,
        },
      ],
      gas,
    },
    signatures: [],
    msg: [
      {
        type: 'osmosis/gamm/swap-exact-amount-in',
        value: {
          sender: osmoAddress,
          routes: [
            {
              pool_id: '1', // TODO: should probably get this from the util pool call
              token_out_denom: buyAssetDenom,
            },
          ],
          token_in: {
            denom: sellAssetDenom,
            amount: sellAmount,
          },
          token_out_min_amount: '1', // slippage tolerance
        },
      },
    ],
  }

  const bip44Params = adapter.getBIP44Params({ accountNumber })

  return {
    tx,
    addressNList: toAddressNList(bip44Params),
    chain_id: CHAIN_REFERENCE.OsmosisMainnet,
    account_number,
    sequence,
  }
}

export const buildTradeTx = async (
  input: BuildTradeTxInput & { wallet: HDWallet },
): Promise<SignTxInput<OsmosisSignTx>> => {
  const { wallet } = input
  const txToSign = await buildApiTradeTx(input)

  return { txToSign, wallet }
}

export const getMinimumCryptoHuman = (sellAssetUsdRate: string): string => {
  const minimumAmountCryptoHuman = bn(1).dividedBy(bnOrZero(sellAssetUsdRate)).toString()
  return minimumAmountCryptoHuman
}
