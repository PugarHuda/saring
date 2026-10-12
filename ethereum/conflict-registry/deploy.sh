#!/usr/bin/env bash
# Deploy UmaConflictRegistry with the current Conflict Report root, then prove one real conflict on-chain.
#   ./deploy.sh                              # Sepolia, key from ~/.saring-eth/deployer.key (never printed)
#   RPC=http://127.0.0.1:8545 KEY_FILE=/tmp/anvil.key ./deploy.sh   # local anvil dry run
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${RPC:-${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}}"
KEY_FILE="${KEY_FILE:-$HOME/.saring-eth/deployer.key}"
URI="${DATASET_URI:-https://pugarhuda.github.io/saring/data/conflicts.csv}"
[ -s "$KEY_FILE" ] || { echo "missing $KEY_FILE"; exit 1; }
ADDR=$(cast wallet address --private-key "$(cat "$KEY_FILE")")
CHAIN=$(cast chain-id --rpc-url "$RPC")
BAL=$(cast balance "$ADDR" --rpc-url "$RPC")
echo "chain $CHAIN deployer $ADDR balance $(cast from-wei "$BAL") ETH"
if [ "$BAL" = "0" ]; then echo "NOT FUNDED: send ~0.02 Sepolia ETH to $ADDR, then rerun ./deploy.sh"; exit 2; fi

j() { node -p "require('./data/$1')$2"; }
ROOT=$(j root.json .root); HASH=$(j root.json .datasetHash); LEAVES=$(j root.json .leafCount); DISPUTES=$(j root.json .disputeCount)
echo "root $ROOT ($LEAVES leaves, $DISPUTES disputes)"

forge build --silent
OUT=$(forge create src/UmaConflictRegistry.sol:UmaConflictRegistry --rpc-url "$RPC" --private-key "$(cat "$KEY_FILE")" \
  --broadcast --json --constructor-args "$ROOT" "$HASH" "$LEAVES" "$DISPUTES" "$URI")
REG=$(echo "$OUT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s.slice(s.indexOf('{')));console.log(j.deployedTo)})")
TX=$(echo "$OUT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s.slice(s.indexOf('{')));console.log(j.transactionHash)})")
echo "UmaConflictRegistry $REG  tx $TX"

# On-chain check with a real proof: Thailand strikes Cambodia, voter 0xacb1…6272 (held 1.12M YES, voted YES)
ID=$(j fixture.json .cases[0].disputeId); VOTER=$(j fixture.json .cases[0].voter); PROOF=$(j fixture.json ".cases[0].proof.join(',')")
WHALE=$(j fixture.json .nonConflictedVoter)
C1=$(cast call "$REG" "isConflicted(bytes32,address,bytes32[])(bool)" "$ID" "$VOTER" "[$PROOF]" --rpc-url "$RPC")
C2=$(cast call "$REG" "isConflicted(bytes32,address,bytes32[])(bool)" "$ID" "$WHALE" "[$PROOF]" --rpc-url "$RPC")
echo "isConflicted(Thailand, $VOTER) = $C1 ; isConflicted(Thailand, $WHALE) = $C2"
node -e "require('fs').writeFileSync('data/deployment-$CHAIN.json', JSON.stringify({chainId:$CHAIN, registry:'$REG', tx:'$TX', deployer:'$ADDR', root:'$ROOT', leafCount:$LEAVES, disputeCount:$DISPUTES, datasetURI:'$URI', check:{disputeId:'$ID', voter:'$VOTER', isConflicted:'$C1', nonConflicted:'$WHALE', isConflictedNonConflicted:'$C2'}, deployed_utc:new Date().toISOString()}, null, 1))"
echo "written data/deployment-$CHAIN.json"
