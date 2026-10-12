#!/usr/bin/env bash
# Deploy SaringStylusVerifier to a local nitro-devnode and feed it the real Saring VAA.
# Node (own subnet, port 8549):
#   docker network create --subnet 172.31.0.0/16 saring-devnode
#   docker run -d --rm --name saring-nitro-dev --network saring-devnode -p 8549:8547 \
#     offchainlabs/nitro-node:v3.7.1-926f1ab --dev --http.addr 0.0.0.0 --http.api=net,web3,eth,debug
# Setup steps follow OffchainLabs/nitro-devnode run-dev-node.sh (chain owner, L1 price 0, CREATE2 factory, StylusDeployer).
set -euo pipefail
cd "$(dirname "$0")"
RPC=${RPC:-http://127.0.0.1:8549}
PK=0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659 # nitro-devnode's public pre-funded dev key
EMITTER=0x54c231cefc5bd0966f82594e4333d6211f9a1ab4740be61271fdcb2d5ceb6238
COURT=0x0fccfd5d8927992d06ab5468a7232ed5280718e34bf449a0acbbf66a36aa5f04
VAA=$(python3 -c "import json;print(json.load(open('../../wormhole/out/vaa-24gQkEbEwUo98arqpKRs3eWBjzya3dvMfrdPsesRMYGb.json'))['vaa'])")
FACTORY=0x4e59b44847b379578588920ca78fbf26c0b4956c
SALT=0x0000000000000000000000000000000000000000000000000000000000000000

if [ "$(cast code -r $RPC $FACTORY)" == "0x" ]; then
  cast send -r $RPC --private-key $PK 0x00000000000000000000000000000000000000FF "becomeChainOwner()" >/dev/null
  cast send -r $RPC --private-key $PK 0x0000000000000000000000000000000000000070 'setL1PricePerUnit(uint256)' 0x0 >/dev/null
  cast send -r $RPC --private-key $PK --value "1 ether" 0x3fab184622dc19b6109349b94811493bf2a45362 >/dev/null
  cast publish -r $RPC 0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222 >/dev/null
  CODE=$(curl -sL https://raw.githubusercontent.com/OffchainLabs/nitro-devnode/main/stylus-deployer-bytecode.txt)
  cast send -r $RPC --private-key $PK $FACTORY "$SALT$CODE" >/dev/null
  echo "devnode setup done; StylusDeployer $(cast create2 --salt $SALT --init-code $CODE | cut -f1)"
fi

CORE=$(cd ../contracts && forge create -r $RPC --private-key $PK --broadcast test/ParseOnlyWormhole.sol:ParseOnlyWormhole | awk '/Deployed to/ {print $3}')
echo "ParseOnlyWormhole (devnode stand-in for the core bridge) $CORE"
cargo stylus deploy -e $RPC --private-key $PK --no-verify --constructor-args $CORE $EMITTER 2>&1 \
  | sed -E 's/\x1b\[[0-9;]*m//g' | tee /tmp/stylus-deploy.log | grep -iE "deployed code|data fee|error|tx hash" || true
ADDR=$(grep -i "deployed code at address" /tmp/stylus-deploy.log | grep -oE "0x[0-9a-fA-F]{40}" | head -1)
echo "SaringStylusVerifier $ADDR"
echo "decodePayload(real payload): $(cast call -r $RPC $ADDR 'decodePayload(bytes)(bytes32,uint8,uint8,uint8,bool,uint64,uint8)' 0x${VAA: -90} | tr '\n' ' ')"
echo "verdictOf before: $(cast call -r $RPC $ADDR 'verdictOf(bytes32)(bool,uint8,uint8,uint8,bool,uint64,uint8)' $COURT | tr '\n' ' ')"
cast send -r $RPC --private-key $PK $ADDR 'submitVaa(bytes)' $VAA | grep -E "^(status|transactionHash|gasUsed)"
echo "verdictOf after: $(cast call -r $RPC $ADDR 'verdictOf(bytes32)(bool,uint8,uint8,uint8,bool,uint64,uint8)' $COURT | tr '\n' ' ')"
BAD=${VAA:0:${#VAA}-18}02${VAA: -16}   # incomplete flag byte = 2: the shared codec rejects it
echo "flag byte 2 -> $(cast call -r $RPC $ADDR 'submitVaa(bytes)' $BAD 2>&1 | grep -oE 'execution reverted.*|custom error.*' | head -1)"
