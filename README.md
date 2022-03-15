# 🔒💰 Cellar LP Bonding

An extension of canonical ERC20 staking patterns for Sommelier LP bonding rewards programs. Unlike other ERC20 staking pools, Sommelier also uses a 'bonding' mechanism, inspired party by [Osmosis](https://osmosis.zone/).

When staking, users must choose an "unbonding" time - this is the cooldown period a user must wait to claim their tokens after electing to unstake. Higher unbonding periods/cooldown times receive higher reward boosts.

## Features

* 🏦 Admins can set the length of a rewards epoch and fund a certain amount of rewards, starting an epoch.
* ⬇️ Users can stake coins in the bonding program, choosing 1-day, 7-day, or 14-day bonding. User's stakes receives multipliers based on bonding period. For instance, a deposit of 100 LP shares with a 2-week unbonding period will receive the equivalent of 200 LP shares deposited with no boost.
* 🎁 Users begin to accumulate rewards as soon as their stake is deposited.
* 🎊 Users can claim accumulated rewards at any time.
* ⏲️ Users can begin unbonding period at any time, starting the cooldown timer. Once unbonding, any time-based boosts are removed. Users cannot edit their unbonding period after staking.
* ❌ After beginning to unbond, users can cancel unbonding at any time, moving the cooldown timer back to 0 and reinstating any time-based boosts.
* ⬆️ After unbonding, users can return after the cooldown period to claim their deposited tokens, along with rewards.

Full technical documentation can be read in the code's natspec.
## Project Architecture

Template copied from kkennis' Hardhat template - see [template README](https://github.com/kkennis/solidity-template) for generalized project instrutions.

