import type { AccountId } from '@shapeshiftoss/caip'
import type { AssetId } from '@shapeshiftoss/caip'
import type { DefiProvider, DefiType } from 'features/defi/contexts/DefiManagerProvider/DefiCommon'
import type { Nominal } from 'types/common'

export type OpportunityMetadata = {
  apy: string
  assetId: AssetId
  provider: DefiProvider
  tvl: string
  type: DefiType
  underlyingAssetIds: readonly [AssetId, AssetId]
}

// User-specific values for this opportunity
export type UserStakingOpportunity = {
  // The amount of farmed LP tokens
  stakedAmountCryptoPrecision: string
  // The amount of rewards available to claim for the farmed LP position
  rewardsAmountCryptoPrecision: string
}

// The AccountId of the staking contract in the form of chainId:accountAddress
export type StakingId = Nominal<string, 'StakingId'>
// The AccountId of the LP contract in the form of chainId:accountAddress
export type LpId = Nominal<string, 'LpId'>
// The unique identifier of an lp opportunity in the form of UserAccountId*StakingId
export type UserStakingId = `${AccountId}*${StakingId}`

export type OpportunitiesState = {
  lp: {
    byAccountId: Record<AccountId, LpId[]> // a 1:n foreign key of which user AccountIds hold this LpId
    byId: Record<LpId, OpportunityMetadata>
    ids: LpId[]
  }
  // Staking is the odd one here - it isn't a portfolio holding, but rather a synthetic value living on a smart contract
  // Which means we can't just derive the data from portfolio, marketData and other slices but have to actually store the amount in the slice
  userStaking: {
    byId: Record<UserStakingId, UserStakingOpportunity>
    ids: UserStakingId[]
  }

  staking: {
    // a 1:n foreign key of which user AccountIds hold this StakingId
    byAccountId: Record<AccountId, StakingId[]>
    byId: Record<StakingId, OpportunityMetadata>
    ids: StakingId[]
  }
}

export type OpportunityMetadataById = OpportunitiesState['lp' | 'staking']['byId']
export type OpportunityDataById = OpportunitiesState['lp' | 'staking']['byAccountId']

export type GetOpportunityMetadataInput = {
  opportunityId: LpId | StakingId
  opportunityType: 'lp' | 'staking'
  defiType: DefiType
}

export type GetOpportunityUserDataInput = {
  accountId: AccountId
  opportunityId: LpId | StakingId
  opportunityType: 'lp' | 'staking'
  defiType: DefiType
}

export type GetOpportunityMetadataOutput = {
  byId: OpportunitiesState['lp' | 'staking']['byId']
  type: 'lp' | 'staking'
}
export type GetOpportunityUserDataOutput = {
  byAccountId: OpportunitiesState['lp' | 'staking']['byAccountId']
  type: 'lp' | 'staking'
}